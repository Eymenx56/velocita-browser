const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, session, shell, webContents, net } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

app.setName('Velocita');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let win;
const PARTITION = 'persist:velocita';
const PRIVATE_PARTITION = 'velocita-private';
const DOWNLOADS_FILE = () => path.join(app.getPath('userData'), 'downloads.json');
const ACTIVE_PROFILE_FILE = () => path.join(app.getPath('userData'), 'active-profile.json');
const ADBLOCK_SETTINGS_FILE = () => path.join(app.getPath('userData'), 'adblock-settings.json');
const ACCOUNT_ENVELOPE_FORMAT = 'velocita-encrypted-v1';
const SUPABASE_CONFIG_FILE = path.join(__dirname, 'supabase-config.json');
const SHORTCUT_KEYS = ['a', 't', 'w', 'l', 'r', 'd', 'f', 'h', 'j', 'n', 'tab', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '=', '-', '0'];
const permissionDecisions = new Map();
const activeDownloads = new Map();
const configuredPartitions = new Set();
let downloadRecords = [];
let downloadSaveQueue = Promise.resolve();
const supabaseClients = new Map();
let pendingOAuthProfileId = null;
let queuedOAuthCallback = null;
// Kullanıcıya sormadan izin verilen, zararsız izinler (video tam ekran vb.)
const SILENT_PERMISSIONS = new Set(['fullscreen', 'pointerLock', 'window-management', 'speaker-selection']);
const permissionLabels = {
  media: 'kamera ve mikrofon',
  geolocation: 'konum',
  notifications: 'bildirim',
  'clipboard-read': 'pano okuma'
};

// ---- Reklam / izleyici engelleyici ----
let adblockEnabled = true;
async function loadAdblockPreference() {
  try {
    const saved = JSON.parse(await fs.readFile(ADBLOCK_SETTINGS_FILE(), 'utf8'));
    if (typeof saved.enabled === 'boolean') adblockEnabled = saved.enabled;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Reklam engelleyici tercihi okunamadı:', error);
  }
}
const BLOCKED_HOSTS = [
  '2mdn.net','adform.net','adnxs.com','adroll.com','adsafeprotected.com','adsrvr.org','adsterra.com',
  'advertising.com','amazon-adsystem.com','bidswitch.net','bluekai.com','casalemedia.com','clickadu.com',
  'contextweb.com','criteo.com','criteo.net','demdex.net','doubleclick.net','e-planning.net','exoclick.com',
  'googlesyndication.com','googleadservices.com','google-analytics.com','googletagmanager.com',
  'adservice.google.com','hilltopads.net','imrworldwide.com','lijit.com','mgid.com','moatads.com',
  'openx.net','outbrain.com','popads.net','popcash.net','pubmatic.com','quantserve.com','revcontent.com',
  'rubiconproject.com','scorecardresearch.com','sharethrough.com','taboola.com','trafficjunky.net',
  'zedo.com','zemanta.com'
];
const isBlockedHost = host => BLOCKED_HOSTS.some(d => host === d || host.endsWith('.' + d));
function isBlockedUrl(url) {
  try { return isBlockedHost(new URL(url).hostname); } catch { return false; }
}
function applyAdblock(targetSession) {
  targetSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!adblockEnabled || details.resourceType === 'mainFrame') return callback({});
    callback({ cancel: isBlockedUrl(details.url) });
  });
}

function configurePermissions(targetSession, profileId = 'default', privateMode = false) {
  const pending = new Map();
  const decisionKey = (origin, permission) => `${profileId}|${privateMode ? 'private' : 'regular'}|${origin}|${permission}`;

  targetSession.setPermissionCheckHandler((_, permission, origin) => {
    if (SILENT_PERMISSIONS.has(permission)) return true;
    return permissionDecisions.get(decisionKey(origin, permission)) === true;
  });

  targetSession.setPermissionRequestHandler((contents, permission, callback, details = {}) => {
    if (SILENT_PERMISSIONS.has(permission)) return callback(true);
    if (!Object.hasOwn(permissionLabels, permission)) return callback(false);

    let origin;
    try {
      const requestingUrl = new URL(details.requestingUrl || contents.getURL());
      const localHost = ['localhost', '127.0.0.1', '::1'].includes(requestingUrl.hostname);
      if (requestingUrl.protocol !== 'https:' && !localHost) return callback(false);
      origin = requestingUrl.origin;
    } catch {
      return callback(false);
    }

    const key = decisionKey(origin, permission);
    if (permissionDecisions.has(key)) return callback(permissionDecisions.get(key));
    if (pending.has(key)) {
      pending.get(key).push(callback);
      return;
    }

    pending.set(key, [callback]);
    const prompt = {
      type: 'question',
      title: 'Site izni',
      message: `${origin} sitesi ${permissionLabels[permission]} erişimi istiyor.`,
      buttons: ['İzin ver', 'Engelle'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    };
    const ask = win && !win.isDestroyed()
      ? dialog.showMessageBox(win, prompt)
      : dialog.showMessageBox(prompt);

    ask.then(({ response }) => {
      const allowed = response === 0;
      permissionDecisions.set(key, allowed);
      pending.get(key)?.forEach(done => done(allowed));
      pending.delete(key);
    }).catch(() => {
      pending.get(key)?.forEach(done => done(false));
      pending.delete(key);
    });
  });
}

async function handleOAuthCallback(rawUrl) {
  let callback;
  try { callback = new URL(rawUrl); } catch { return; }
  if (callback.protocol !== 'velocita:' || callback.hostname !== 'auth' || callback.pathname !== '/callback') return;

  const profileId = pendingOAuthProfileId || await loadActiveProfileId();
  pendingOAuthProfileId = null;
  let result;
  const code = callback.searchParams.get('code');
  const providerError = callback.searchParams.get('error_description') || callback.searchParams.get('error');
  if (providerError) result = { error: providerError };
  else if (!code) result = { error: 'Google giriş yanıtında yetkilendirme kodu bulunamadı.' };
  else {
    try {
      const client = await getSupabaseClient(profileId);
      const { error } = await client.auth.exchangeCodeForSession(code);
      result = error ? { error: error.message } : { success: true };
    } catch (error) {
      result = { error: error.message || 'Google oturumu tamamlanamadı.' };
    }
  }

  if (!win || win.isDestroyed() || win.webContents.isLoading()) queuedOAuthCallback = { profileId, ...result };
  else win.webContents.send('auth:complete', { profileId, ...result });
}

function validProfileId(profileId) {
  return typeof profileId === 'string' && /^[a-z0-9-]{1,64}$/.test(profileId);
}

function profilePartition(profileId = 'default') {
  if (!validProfileId(profileId)) throw new Error('Geçersiz profil kimliği.');
  return profileId === 'default' ? PARTITION : `persist:velocita-profile-${profileId}`;
}

function privatePartition(profileId = 'default') {
  if (!validProfileId(profileId)) throw new Error('Geçersiz profil kimliği.');
  return `velocita-private-${profileId}`;
}

function ensureProfile(profileId = 'default') {
  if (!validProfileId(profileId)) throw new Error('Geçersiz profil kimliği.');
  if (configuredPartitions.has(profileId)) return;
  configurePermissions(session.fromPartition(profilePartition(profileId)), profileId, false);
  configurePermissions(session.fromPartition(privatePartition(profileId)), profileId, true);
  trackDownloads(session.fromPartition(profilePartition(profileId)), false, profileId);
  trackDownloads(session.fromPartition(privatePartition(profileId)), true, profileId);
  applyAdblock(session.fromPartition(profilePartition(profileId)));
  applyAdblock(session.fromPartition(privatePartition(profileId)));
  configuredPartitions.add(profileId);
}

function sessionProfile(targetSession) {
  for (const profileId of configuredPartitions) {
    if (targetSession === session.fromPartition(privatePartition(profileId))) return { profileId, privateMode: true };
    if (targetSession === session.fromPartition(profilePartition(profileId))) return { profileId, privateMode: false };
  }
  return { profileId: 'default', privateMode: false };
}

const extensionsFile = (profileId = 'default') => path.join(app.getPath('userData'), profileId === 'default' ? 'extensions.json' : `extensions-${profileId}.json`);

async function loadActiveProfileId() {
  try {
    const saved = JSON.parse(await fs.readFile(ACTIVE_PROFILE_FILE(), 'utf8'));
    return validProfileId(saved.profileId) ? saved.profileId : 'default';
  } catch {
    return 'default';
  }
}

const supabaseSessionFile = profileId => path.join(app.getPath('userData'), `supabase-session-${profileId}.bin`);

async function assertSessionEncryption() {
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('İşletim sistemi güvenli depolaması kullanılamıyor.');
}

async function readEncryptedJson(filePath) {
  await assertSessionEncryption();
  try {
    const envelope = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (envelope.format !== ACCOUNT_ENVELOPE_FORMAT || typeof envelope.data !== 'string') throw new Error('Invalid encrypted session');
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(envelope.data, 'base64'));
    return JSON.parse(decrypted.result);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Şifreli Supabase oturumu okunamadı.');
  }
}

async function writeEncryptedJson(filePath, data) {
  await assertSessionEncryption();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const encrypted = (await safeStorage.encryptStringAsync(JSON.stringify(data))).toString('base64');
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ format: ACCOUNT_ENVELOPE_FORMAT, data: encrypted }), { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function loadSupabaseConfig() {
  let config = {};
  try {
    config = JSON.parse(await fs.readFile(SUPABASE_CONFIG_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Supabase yapılandırma dosyası okunamadı.');
  }
  const url = process.env.VELOCITA_SUPABASE_URL || config.url;
  const anonKey = process.env.VELOCITA_SUPABASE_ANON_KEY || config.anonKey;
  if (typeof url !== 'string' || typeof anonKey !== 'string' || !url || !anonKey) {
    throw new Error('Supabase URL ve anon key yapılandırılmamış.');
  }
  if (url.includes('YOUR_PROJECT_REF') || anonKey.includes('YOUR_SUPABASE')) throw new Error('supabase-config.json dosyasına proje URL’si ve public anon key ekleyin.');
  if (/service[_-]?role|sb_secret/i.test(anonKey)) throw new Error('Service-role anahtarı kullanılamaz; yalnızca public anon/publishable key kullanın.');
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { throw new Error('Supabase URL geçersiz.'); }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost') throw new Error('Supabase URL HTTPS olmalı.');
  return { url: parsedUrl.origin, anonKey };
}

async function getSupabaseClient(profileId) {
  if (!validProfileId(profileId)) throw new Error('Geçersiz profil.');
  if (supabaseClients.has(profileId)) return supabaseClients.get(profileId);
  const pending = (async () => {
    const { url, anonKey } = await loadSupabaseConfig();
    const storageFile = supabaseSessionFile(profileId);
    const storage = {
      getItem: async () => (await readEncryptedJson(storageFile))?.value ?? null,
      setItem: async (_, value) => writeEncryptedJson(storageFile, { value }),
      removeItem: async () => fs.rm(storageFile, { force: true })
    };
    return createClient(url, anonKey, {
      auth: { storage, storageKey: `velocita-${profileId}`, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce' }
    });
  })();
  supabaseClients.set(profileId, pending);
  try {
    const client = await pending;
    supabaseClients.set(profileId, client);
    return client;
  } catch (error) {
    supabaseClients.delete(profileId);
    throw error;
  }
}

async function authenticatedUser(client) {
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error('Önce giriş yapın.');
  return data.user;
}

function publicAuthUser(user) {
  const metadata = user?.user_metadata || {};
  const candidate = metadata.avatar_url || metadata.picture;
  let avatarUrl = null;
  if (typeof candidate === 'string') {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:') avatarUrl = parsed.href;
    } catch {}
  }
  return { id: user.id, email: user.email, avatarUrl };
}

function validSyncPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.bookmarks) || !Array.isArray(payload.history) || !payload.settings || typeof payload.settings !== 'object' || Array.isArray(payload.settings)) return false;
  if (payload.bookmarks.length > 5000 || payload.history.length > 10000) return false;
  try { return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 4 * 1024 * 1024; } catch { return false; }
}

async function loadSavedExtensions(profileId = 'default') {
  const targetSession = session.fromPartition(profilePartition(profileId));
  const paths = await savedExtensionPaths(profileId);
  const loadedPaths = [];
  const installedPaths = new Set(targetSession.extensions.getAllExtensions().map(extension => path.resolve(extension.path)));
  for (const extensionPath of paths) {
    try {
      if (installedPaths.has(path.resolve(extensionPath))) {
        loadedPaths.push(extensionPath);
        continue;
      }
      await targetSession.extensions.loadExtension(extensionPath, { allowFileAccess: false });
      loadedPaths.push(extensionPath);
    } catch (error) {
      console.warn(`Uzantı yüklenemedi (${extensionPath}): ${error.message}`);
    }
  }
  if (loadedPaths.length !== paths.length) await saveExtensionPaths(loadedPaths, profileId);
}

async function savedExtensionPaths(profileId = 'default') {
  try {
    const paths = JSON.parse(await fs.readFile(extensionsFile(profileId), 'utf8'));
    return Array.isArray(paths) ? paths.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function saveExtensionPaths(paths, profileId = 'default') {
  await fs.mkdir(path.dirname(extensionsFile(profileId)), { recursive: true });
  await fs.writeFile(extensionsFile(profileId), JSON.stringify(paths, null, 2), 'utf8');
}

async function loadDownloadRecords() {
  try {
    const records = JSON.parse(await fs.readFile(DOWNLOADS_FILE(), 'utf8'));
    downloadRecords = Array.isArray(records)
      ? records.filter(item => item && typeof item.id === 'string' && !item.privateMode).slice(0, 250).map(item => ({
        ...item,
        profileId: validProfileId(item.profileId) ? item.profileId : 'default',
        state: ['progressing', 'paused'].includes(item.state) ? 'interrupted' : item.state,
        paused: false,
        canResume: false
      }))
      : [];
  } catch {
    downloadRecords = [];
  }
}

function saveDownloadRecords() {
  const records = downloadRecords.filter(item => !item.privateMode).slice(0, 250);
  downloadSaveQueue = downloadSaveQueue.then(async () => {
    await fs.mkdir(path.dirname(DOWNLOADS_FILE()), { recursive: true });
    await fs.writeFile(DOWNLOADS_FILE(), JSON.stringify(records, null, 2), 'utf8');
  }).catch(error => console.error('İndirme geçmişi kaydedilemedi:', error));
}

function publishDownload(record) {
  const index = downloadRecords.findIndex(item => item.id === record.id);
  if (index >= 0) downloadRecords[index] = record;
  else downloadRecords.unshift(record);
  downloadRecords = downloadRecords.slice(0, 250);
  if (!record.privateMode) saveDownloadRecords();
  if (win && !win.isDestroyed()) {
    const { path: _path, ...publicRecord } = record;
    win.webContents.send('download', publicRecord);
  }
}

function trackDownloads(targetSession, privateMode = false, profileId = 'default') {
  targetSession.on('will-download', (_, item) => {
    const id = randomUUID();
    const update = state => publishDownload({
      id,
      name: item.getFilename(),
      path: item.getSavePath(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: item.getReceivedBytes(),
      state,
      paused: item.isPaused(),
      canResume: item.canResume(),
      startedAt: item.getStartTime() * 1000 || Date.now(),
      privateMode,
      profileId
    });

    activeDownloads.set(id, { item, privateMode, profileId, update });
    update('progressing');
    item.on('updated', (_event, state) => update(state));
    item.once('done', (_event, state) => {
      update(state);
      activeDownloads.delete(id);
    });
  });
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'Velocita',
    ...(process.platform === 'win32' ? { icon: path.join(__dirname, 'assets', 'velocita.ico') } : {}),
    backgroundColor: '#dbe7f8',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 12 } }
      : { titleBarOverlay: { color: '#d6e4f8', symbolColor: '#1f2937', height: 40 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true
    }
  });
  win.loadFile('index.html');
}

// Sayfa içindeki (webview) pencere açma ve kısayolları yakala
app.on('web-contents-created', (_, contents) => {
  if (contents.getType() !== 'webview') return;

  contents.setWindowOpenHandler(({ url }) => {
    if (adblockEnabled && isBlockedUrl(url)) return { action: 'deny' };
    const browsingProfile = sessionProfile(contents.session);
    win?.webContents.send('open-url', {
      url,
      privateMode: browsingProfile.privateMode,
      profileId: browsingProfile.profileId
    });
    return { action: 'deny' };
  });

  // --- HTML tam ekran (film/video siteleri) ---
  let windowWasFullScreen = false;
  let htmlFullScreen = false;
  contents.on('enter-html-full-screen', () => {
    if (!win || win.isDestroyed()) return;
    htmlFullScreen = true;
    windowWasFullScreen = win.isFullScreen();
    if (!windowWasFullScreen) win.setFullScreen(true);
    win.webContents.send('html-fullscreen', true);
  });
  contents.on('leave-html-full-screen', () => {
    if (!win || win.isDestroyed()) return;
    htmlFullScreen = false;
    if (!windowWasFullScreen && win.isFullScreen()) win.setFullScreen(false);
    win.webContents.send('html-fullscreen', false);
  });
  contents.on('destroyed', () => {
    if (htmlFullScreen && win && !win.isDestroyed()) {
      if (!windowWasFullScreen && win.isFullScreen()) win.setFullScreen(false);
      win.webContents.send('html-fullscreen', false);
    }
  });

  contents.on('context-menu', (event, params) => {
    event.preventDefault();
    const browsingProfile = sessionProfile(contents.session);
    const privateMode = browsingProfile.privateMode;
    const profileId = browsingProfile.profileId;
    const open = (url, background = false) => win?.webContents.send('open-url', { url, privateMode, background, profileId });
    const template = [];

    if (params.linkURL) {
      template.push(
        { label: 'Bağlantıyı yeni sekmede aç', click: () => open(params.linkURL) },
        { label: 'Bağlantıyı arka planda aç', click: () => open(params.linkURL, true) },
        { label: 'Bağlantı adresini kopyala', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }
    if (params.mediaType === 'image' && params.srcURL) {
      template.push(
        { label: 'Resmi yeni sekmede aç', click: () => open(params.srcURL) },
        { label: 'Resmi kopyala', click: () => contents.copyImageAt(params.x, params.y) },
        { label: 'Resmi farklı kaydet', click: () => contents.downloadURL(params.srcURL) },
        { label: 'Resim adresini kopyala', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' }
      );
    }
    if (params.mediaType === 'video' && params.srcURL && /^https?:/i.test(params.srcURL)) {
      template.push(
        { label: 'Videoyu farklı kaydet', click: () => contents.downloadURL(params.srcURL) },
        { type: 'separator' }
      );
    }
    if (params.selectionText) {
      const short = params.selectionText.trim().slice(0, 24);
      template.push(
        { label: 'Kopyala', role: 'copy' },
        { label: `“${short}${params.selectionText.trim().length > 24 ? '…' : ''}” için ara`, click: () => win?.webContents.send('search-text', { text: params.selectionText.trim().slice(0, 300), privateMode, profileId }) },
        { type: 'separator' }
      );
    }
    if (params.isEditable) {
      template.push(
        { label: 'Kes', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Kopyala', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Yapıştır', role: 'paste', enabled: params.editFlags.canPaste },
        { label: 'Tümünü seç', role: 'selectAll' },
        { type: 'separator' }
      );
    }
    template.push(
      { label: 'Geri', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: 'İleri', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: 'Yenile', click: () => contents.reload() },
      { type: 'separator' },
      { label: 'Sayfa adresini kopyala', click: () => clipboard.writeText(contents.getURL()) },
      { label: 'İncele', click: () => contents.inspectElement(params.x, params.y) }
    );
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      event.preventDefault();
      if (htmlFullScreen) contents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
      else win?.setFullScreen(!win.isFullScreen());
      return;
    }
    if (!(input.control || input.meta)) return;
    const key = input.key.toLowerCase();
    if (SHORTCUT_KEYS.includes(key)) {
      event.preventDefault();
      win?.webContents.send('shortcut', { key, shift: input.shift });
    }
  });
});

// Sayfa ekran görüntüsü (yalnızca webview içerikleri için)
ipcMain.handle('tools:screenshot', async (_, webContentsId) => {
  const target = Number.isInteger(webContentsId) ? webContents.fromId(webContentsId) : null;
  if (!target || target.isDestroyed() || target.getType() !== 'webview') return { error: 'Önce bir web sayfası açın.' };
  try {
    const image = await target.capturePage();
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const result = await dialog.showSaveDialog(win, {
      title: 'Ekran görüntüsünü kaydet',
      defaultPath: path.join(app.getPath('pictures'), `Velocita-${stamp}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, image.toPNG());
    return { path: result.filePath };
  } catch (error) {
    return { error: error.message || 'Ekran görüntüsü alınamadı.' };
  }
});

ipcMain.handle('adblock:get', () => adblockEnabled);

ipcMain.handle('adblock:set', async (_, enabled) => {
  if (typeof enabled !== 'boolean') throw new TypeError('Reklam engelleyici tercihi geçersiz.');
  await fs.mkdir(path.dirname(ADBLOCK_SETTINGS_FILE()), { recursive: true });
  await fs.writeFile(ADBLOCK_SETTINGS_FILE(), JSON.stringify({ enabled }), 'utf8');
  adblockEnabled = enabled;
  return adblockEnabled;
});

// Favicon önbelleği: diskte saklanır, ikinci açılıştan itibaren anında gelir
const favMem = new Map();
const favDir = () => path.join(app.getPath('userData'), 'favicons');
ipcMain.handle('favicon:get', async (_, domain) => {
  if (typeof domain !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(domain)) return null;
  if (favMem.has(domain)) return favMem.get(domain);
  const file = path.join(favDir(), domain.toLowerCase() + '.png');
  try {
    const cached = await fs.readFile(file);
    const dataUrl = 'data:image/png;base64,' + cached.toString('base64');
    favMem.set(domain, dataUrl);
    return dataUrl;
  } catch {}
  try {
    const res = await net.fetch('https://www.google.com/s2/favicons?sz=128&domain=' + encodeURIComponent(domain));
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 256 * 1024) return null;
    await fs.mkdir(favDir(), { recursive: true });
    await fs.writeFile(file, buf);
    const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
    favMem.set(domain, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const callbackUrl = commandLine.find(argument => argument.startsWith('velocita://'));
    if (callbackUrl) void handleOAuthCallback(callbackUrl);
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    void handleOAuthCallback(url);
  });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  const protocolRegistered = app.isPackaged
    ? app.setAsDefaultProtocolClient('velocita')
    : app.setAsDefaultProtocolClient('velocita', process.execPath, [path.resolve(process.argv[1])]);
  if (!protocolRegistered) console.warn('Velocita giriş bağlantı protokolü kaydedilemedi.');
  await loadAdblockPreference();
  const profileId = await loadActiveProfileId();
  ensureProfile(profileId);
  await loadDownloadRecords();
  await loadSavedExtensions(profileId).catch(error => console.error('Uzantılar yüklenemedi:', error));
  createWindow();
  win.webContents.on('did-finish-load', () => {
    if (!queuedOAuthCallback || win.isDestroyed()) return;
    win.webContents.send('auth:complete', queuedOAuthCallback);
    queuedOAuthCallback = null;
  });
  const startupCallback = process.argv.find(argument => argument.startsWith('velocita://'));
  if (startupCallback) void handleOAuthCallback(startupCallback);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on('overlay', (_, { color, symbolColor }) => {
  if (process.platform !== 'darwin' && win?.setTitleBarOverlay) {
    win.setTitleBarOverlay({ color, symbolColor, height: 40 });
  }
});

ipcMain.on('fullscreen', () => win?.setFullScreen(!win.isFullScreen()));

ipcMain.handle('profiles:activate', async (_, profileId = 'default') => {
  ensureProfile(profileId);
  await loadSavedExtensions(profileId);
  await fs.mkdir(path.dirname(ACTIVE_PROFILE_FILE()), { recursive: true });
  await fs.writeFile(ACTIVE_PROFILE_FILE(), JSON.stringify({ profileId }), 'utf8');
  return true;
});

ipcMain.handle('auth:signUp', async (_, email, password, profileId = 'default') => {
  if (!validProfileId(profileId) || typeof email !== 'string' || typeof password !== 'string') return { error: 'E-posta ve parola gerekli.' };
  try {
    const client = await getSupabaseClient(profileId);
    const { data, error } = await client.auth.signUp({ email: email.trim(), password });
    if (error) return { error: error.message };
    return {
      user: data.user ? publicAuthUser(data.user) : null,
      signedIn: Boolean(data.session),
      requiresEmailConfirmation: !data.session
    };
  } catch (error) {
    return { error: error.message || 'Kayıt oluşturulamadı.' };
  }
});

ipcMain.handle('auth:signIn', async (_, email, password, profileId = 'default') => {
  if (!validProfileId(profileId) || typeof email !== 'string' || typeof password !== 'string') return { error: 'E-posta veya parola hatalı.' };
  try {
    const client = await getSupabaseClient(profileId);
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) return { error: error.message };
    return { user: publicAuthUser(data.user), signedIn: true };
  } catch (error) {
    return { error: error.message || 'Giriş yapılamadı.' };
  }
});

ipcMain.handle('auth:signInGoogle', async (_, profileId = 'default') => {
  if (!validProfileId(profileId)) return { error: 'Geçersiz profil.' };
  try {
    const client = await getSupabaseClient(profileId);
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: 'velocita://auth/callback',
        skipBrowserRedirect: true,
        queryParams: { prompt: 'select_account' }
      }
    });
    if (error) return { error: error.message };
    if (!data.url) return { error: 'Google giriş bağlantısı oluşturulamadı.' };
    pendingOAuthProfileId = profileId;
    await shell.openExternal(data.url);
    return { success: true };
  } catch (error) {
    pendingOAuthProfileId = null;
    return { error: error.message || 'Google girişi başlatılamadı.' };
  }
});

ipcMain.handle('search:suggest', async (_, engine, query) => {
  const endpoints = {
    Google: value => `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(value)}`,
    DuckDuckGo: value => `https://duckduckgo.com/ac/?q=${encodeURIComponent(value)}&type=list`,
    Bing: value => `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(value)}`,
    Yandex: value => `https://suggest.yandex.com/suggest-ya.cgi?part=${encodeURIComponent(value)}&uil=en&v=4`
  };
  if (typeof engine !== 'string' || !Object.hasOwn(endpoints, engine) || typeof query !== 'string') {
    return { error: 'Arama önerisi isteği geçersiz.' };
  }
  const value = query.trim().slice(0, 256);
  if (value.length < 2) return { suggestions: [] };

  try {
    const response = await net.fetch(endpoints[engine](value), { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { error: `Arama önerileri alınamadı (HTTP ${response.status}).` };
    const data = await response.json();
    let suggestions;
    if (engine === 'DuckDuckGo') {
      suggestions = Array.isArray(data) ? data.map(item => item?.phrase) : [];
    } else if (engine === 'Yandex') {
      suggestions = Array.isArray(data?.[1]) ? data[1] : [];
    } else {
      suggestions = Array.isArray(data?.[1]) ? data[1] : [];
    }
    return {
      suggestions: [...new Set(suggestions.filter(item => typeof item === 'string' && item.trim()))]
        .slice(0, 6)
    };
  } catch (error) {
    console.warn('Arama önerileri alınamadı:', error.message);
    return { error: 'Arama önerileri şu anda alınamıyor.' };
  }
});

ipcMain.handle('auth:signOut', async (_, profileId = 'default') => {
  if (!validProfileId(profileId)) return { error: 'Geçersiz profil.' };
  try {
    const client = supabaseClients.has(profileId) ? await supabaseClients.get(profileId) : null;
    if (client) await client.auth.signOut({ scope: 'local' }).catch(() => {});
    await fs.rm(supabaseSessionFile(profileId), { force: true });
    supabaseClients.delete(profileId);
    return { success: true };
  } catch (error) {
    return { error: error.message || 'Çıkış yapılamadı.' };
  }
});

ipcMain.handle('auth:getSession', async (_, profileId = 'default') => {
  if (!validProfileId(profileId)) return { error: 'Geçersiz profil.' };
  try {
    const client = await getSupabaseClient(profileId);
    const { data, error } = await client.auth.getSession();
    if (error) return { error: error.message };
    const user = data.session?.user;
    return { user: user ? publicAuthUser(user) : null };
  } catch (error) {
    return { error: error.message || 'Oturum okunamadı.' };
  }
});

ipcMain.handle('sync:pull', async (_, profileId = 'default') => {
  if (!validProfileId(profileId)) return { error: 'Geçersiz profil.' };
  try {
    const client = await getSupabaseClient(profileId);
    const user = await authenticatedUser(client);
    const { data, error } = await client.from('browser_data').select('bookmarks, history, settings, updated_at').eq('user_id', user.id).maybeSingle();
    if (error) return { error: error.message };
    return { data: data ? { bookmarks: data.bookmarks || [], history: data.history || [], settings: data.settings || {}, updatedAt: data.updated_at } : null };
  } catch (error) {
    return { error: error.message || 'Bulut verisi alınamadı.' };
  }
});

ipcMain.handle('sync:push', async (_, payload, profileId = 'default') => {
  if (!validProfileId(profileId) || !validSyncPayload(payload)) return { error: 'Eşitlenecek veri geçersiz veya çok büyük.' };
  try {
    const client = await getSupabaseClient(profileId);
    const user = await authenticatedUser(client);
    const { error } = await client.from('browser_data').upsert({
      user_id: user.id,
      bookmarks: payload.bookmarks,
      history: payload.history,
      settings: payload.settings,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    return error ? { error: error.message } : { success: true };
  } catch (error) {
    return { error: error.message || 'Bulut eşitlemesi başarısız.' };
  }
});

ipcMain.handle('clear-data', async (_, profileId = 'default') => {
  ensureProfile(profileId);
  const ses = session.fromPartition(profilePartition(profileId));
  await ses.clearStorageData();
  await ses.clearCache();
  for (const key of permissionDecisions.keys()) {
    if (key.startsWith(`${profileId}|regular|`)) permissionDecisions.delete(key);
  }
  return true;
});

ipcMain.handle('clear-private-data', async (_, profileId = 'default') => {
  ensureProfile(profileId);
  const privateSession = session.fromPartition(privatePartition(profileId));
  await privateSession.clearStorageData();
  await privateSession.clearCache();
  await privateSession.clearAuthCache();
  for (const key of permissionDecisions.keys()) {
    if (key.startsWith(`${profileId}|private|`)) permissionDecisions.delete(key);
  }
  return true;
});

ipcMain.handle('downloads:list', (_, privateMode = false, profileId = 'default') => {
  if (!validProfileId(profileId)) return [];
  return downloadRecords
    .filter(item => item.profileId === profileId && item.privateMode === Boolean(privateMode))
    .map(({ id, name, totalBytes, receivedBytes, state, paused, canResume, startedAt, privateMode: isPrivate }) => ({
      id, name, totalBytes, receivedBytes, state, paused, canResume, startedAt, privateMode: isPrivate
    }));
});

ipcMain.handle('downloads:control', (_, id, command, profileId = 'default') => {
  const entry = activeDownloads.get(id);
  if (!entry || entry.profileId !== profileId) return false;
  if (command === 'pause' && !entry.item.isPaused()) {
    entry.item.pause();
    entry.update('paused');
  } else if (command === 'resume' && (entry.item.isPaused() || entry.item.canResume())) {
    entry.item.resume();
    entry.update('progressing');
  }
  else if (command === 'cancel') entry.item.cancel();
  else return false;
  return true;
});

ipcMain.handle('downloads:open', async (_, id, profileId = 'default') => {
  const record = downloadRecords.find(item => item.id === id && item.profileId === profileId && item.state === 'completed');
  if (!record?.path) return { error: 'Dosya bulunamadı.' };
  const error = await shell.openPath(record.path);
  return error ? { error } : { success: true };
});

ipcMain.handle('downloads:show', (_, id, profileId = 'default') => {
  const record = downloadRecords.find(item => item.id === id && item.profileId === profileId && item.state === 'completed');
  if (!record?.path) return false;
  shell.showItemInFolder(record.path);
  return true;
});

ipcMain.handle('downloads:clear', (_, privateMode = false, profileId = 'default') => {
  downloadRecords = downloadRecords.filter(item => item.profileId !== profileId || item.privateMode !== Boolean(privateMode) || activeDownloads.has(item.id));
  if (!privateMode) saveDownloadRecords();
  return true;
});

ipcMain.handle('extensions:list', (_, profileId = 'default') => {
  ensureProfile(profileId);
  return session.fromPartition(profilePartition(profileId)).extensions.getAllExtensions().map(({ id, name, version }) => ({ id, name, version }));
});

ipcMain.handle('permissions:list', (_, profileId = 'default') => {
  if (!validProfileId(profileId)) return [];
  return [...permissionDecisions].flatMap(([key, allowed]) => {
    const [scope, mode, origin, permission] = key.split('|');
    return scope === profileId && mode === 'regular' ? [{ origin, permission, allowed }] : [];
  });
});

ipcMain.handle('permissions:clear', (_, profileId = 'default') => {
  if (!validProfileId(profileId)) return 0;
  let removed = 0;
  for (const key of permissionDecisions.keys()) {
    if (key.startsWith(`${profileId}|regular|`)) {
      permissionDecisions.delete(key);
      removed++;
    }
  }
  return removed;
});

ipcMain.handle('extensions:install', async (_, profileId = 'default') => {
  ensureProfile(profileId);
  const result = await dialog.showOpenDialog(win, {
    title: 'Uzantı klasörünü seç',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };

  try {
    const extensionPath = path.resolve(result.filePaths[0]);
    const targetSession = session.fromPartition(profilePartition(profileId));
    const extension = await targetSession.extensions.loadExtension(extensionPath, { allowFileAccess: false });
    const paths = await savedExtensionPaths(profileId);
    if (!paths.includes(extensionPath)) paths.push(extensionPath);
    await saveExtensionPaths(paths, profileId);
    return { id: extension.id, name: extension.name, version: extension.version };
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('extensions:remove', async (_, id, profileId = 'default') => {
  ensureProfile(profileId);
  const targetSession = session.fromPartition(profilePartition(profileId));
  const extension = targetSession.extensions.getAllExtensions().find(item => item.id === id);
  if (!extension) return false;

  targetSession.extensions.removeExtension(extension.id);
  const paths = await savedExtensionPaths(profileId);
  await saveExtensionPaths(paths.filter(item => path.resolve(item) !== path.resolve(extension.path)), profileId);
  return true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
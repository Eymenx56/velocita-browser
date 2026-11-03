const { contextBridge, ipcRenderer } = require('electron');

const sendChannels = new Set(['overlay', 'fullscreen']);
const invokeChannels = new Set([
  'clear-data',
  'clear-private-data',
  'profiles:activate',
  'auth:signUp',
  'auth:signIn',
  'auth:signInGoogle',
  'auth:signOut',
  'auth:getSession',
  'search:suggest',
  'sync:pull',
  'sync:push',
  'extensions:list',
  'extensions:install',
  'extensions:remove',
  'downloads:list',
  'downloads:control',
  'downloads:open',
  'downloads:show',
  'downloads:clear',
  'permissions:list',
  'permissions:clear',
  'tools:screenshot',
  'adblock:get',
  'adblock:set',
  'favicon:get'
]);
const eventChannels = new Set(['shortcut', 'open-url', 'download', 'html-fullscreen', 'search-text', 'auth:complete']);

contextBridge.exposeInMainWorld('velocita', {
  send(channel, payload) {
    if (!sendChannels.has(channel)) throw new Error('Unsupported IPC channel');
    ipcRenderer.send(channel, payload);
  },
  invoke(channel, ...args) {
    if (!invokeChannels.has(channel)) throw new Error('Unsupported IPC channel');
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, listener) {
    if (!eventChannels.has(channel)) throw new Error('Unsupported IPC channel');
    const handler = (_event, ...args) => listener(undefined, ...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
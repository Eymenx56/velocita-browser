# Velocita Browser

Velocita is an experimental desktop browser built with Electron. It includes separate browser profiles, bookmarks, history, downloads, search suggestions, optional host-based ad blocking, and optional Supabase account sync.

Velocita is a personal project and has not undergone an independent security audit. Do not rely on it for sensitive or high-risk activity. No software can be guaranteed completely secure.

## Download for Windows

The Windows installer (`Velocita Setup 1.1.0.exe`) is attached to the latest GitHub Release:

**[Download Velocita from Releases](https://github.com/Eymenx56/velocita-browser/releases/latest)**

Open the latest release and download the `.exe` under **Assets**. The installer is currently unsigned, so Windows SmartScreen may show a warning. Only download it from this repository's Releases page.

## Before using Velocita

- Google sign-in depends on the project's Supabase and Google OAuth configuration. If the Google OAuth app is in **Testing** mode, only its listed test users can sign in.
- Signing in is optional. When signed in, bookmarks, browsing history, and browser settings may be synchronized to the configured Supabase project.
- Search suggestions send the text typed in the address bar to the selected search provider (Google, DuckDuckGo, Bing, or Yandex).
- The new-tab dashboard requests weather data from Open-Meteo and market data from Yahoo Finance. If you choose to use device location for weather, your coordinates are used for that weather request.
- The built-in ad blocker uses a host blocklist. It cannot block every ad, especially ads served from the same host as page content.
- Electron does not support every Chromium feature or all Chrome Web Store extensions.
- Browser profiles keep cookies and local browsing data separate on this device. This is not a guarantee of anonymity or protection against malware, network monitoring, or unsafe websites.

## Privacy and account data

- Google sign-in is handled by Supabase Auth. Velocita uses the account email and, when available, the profile image URL for the account UI.
- When cloud sync is enabled by signing in, Velocita synchronizes bookmarks, browsing history, and settings with the configured Supabase project.
- OAuth client secrets and Supabase service-role/secret keys must never be embedded in the application or published in this repository. The app should use only a public anon/publishable key; Supabase Row Level Security (RLS) policies protect user records.
- Review the privacy policies and terms of the selected search, weather, market-data, and authentication providers before use.

## Run from source

### Requirements

- Node.js and npm
- Windows to build the Windows installer
- A Supabase project for sign-in and cloud sync

### Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `supabase-config.example.json` to `supabase-config.json`.
3. Configure your own Supabase project URL and public anon/publishable key in `supabase-config.json`.
4. Start Velocita:

   ```sh
   npm start
   ```

Never put a Supabase service-role/secret key, Google OAuth client secret, or other private credential in the app or a public repository. `supabase-config.json` is intentionally ignored by Git.

### Supabase setup

The cloud-sync table and per-user RLS policies are defined in [`supabase/schema.sql`](./supabase/schema.sql). Apply and verify these policies in your own Supabase project before enabling sync. Configure Google OAuth in Supabase and Google Cloud, including the `velocita://auth/callback` redirect. OAuth testing/verification requirements are controlled by Google.

### Build

Build the Windows installer:

```sh
npm run build
```

The generated installer is written to `dist/`. Build output and local configuration are intentionally excluded from Git. To distribute a new installer, attach the `.exe` to a GitHub Release.

## Feedback

Please open a GitHub issue for reproducible bugs or feature requests. Do not include passwords, OAuth client secrets, access tokens, personal browsing history, or other private data in issues.

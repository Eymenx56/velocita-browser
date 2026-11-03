# Velocita Browser

Velocita is an Electron-based desktop browser with profiles, bookmarks, browsing history, downloads, search suggestions, optional ad blocking, and Supabase-backed account sync.

## Requirements

- Node.js and npm
- Windows to build the Windows installer
- A Supabase project for cloud sign-in and sync

## Run locally

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `supabase-config.example.json` to `supabase-config.json`.
3. Set the Supabase project URL and its public anon/publishable key in `supabase-config.json`.
4. Start the app:

   ```sh
   npm start
   ```

Never put a Supabase service-role/secret key, OAuth client secret, or other private credential in the app or a public repository. `supabase-config.json` is intentionally ignored by Git.

## Build

Build the Windows installer:

```sh
npm run build
```

The generated installer is written to `dist/`, which is intentionally ignored by Git.

## Supabase

The database schema used by cloud sync is in [`supabase/schema.sql`](./supabase/schema.sql). Configure Google OAuth and the `velocita://auth/callback` redirect in your own Supabase and Google Cloud projects before enabling Google sign-in.

## Notes

- Browser profiles keep their browsing data and cloud sessions separate on the local device.
- Search suggestions are requested from the selected search provider as the user types.
- Electron does not provide full Chromium or Chrome Web Store extension compatibility.
- The built-in ad blocker uses a host blocklist; it cannot block every ad, especially ads served from the same host as page content.

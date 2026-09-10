# PJSDAS v1.0 Google Drive Sync Setup

PJSDAS remains fully usable without cloud configuration. Cloud mode uses Google Identity Services and the Google Drive API to store one hidden PJSDAS workspace file inside the user's own Drive `appDataFolder`.

There is no PJSDAS cloud database in v1.0. IndexedDB remains the immediate workspace used by the UI.

## 1. Create or choose a Google Cloud project

Open Google Cloud Console, create a project for PJSDAS (or choose an existing project dedicated to it), and enable **Google Drive API**.

## 2. Configure the OAuth consent screen

Configure Google Auth / OAuth consent for the project. During development or testing, add the Google accounts that should be allowed to test the app if the consent screen is still in testing mode.

PJSDAS requests only:

- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/drive.appdata`

`drive.appdata` lets PJSDAS view and manage only its own application data in the hidden Drive application-data folder. It does not grant PJSDAS permission to browse the user's ordinary My Drive files.

## 3. Create a Web OAuth client

Create an OAuth 2.0 Client ID of type **Web application**.

For the public GitHub Pages deployment, add this Authorized JavaScript origin:

`https://haohongfei2001-png.github.io`

For local development, add the local Vite origin that you actually use, for example `http://localhost:5173`.

The v1.0 implementation uses the Google Identity Services token model in a popup and does not require a PJSDAS backend or a redirect endpoint.

Copy the resulting Client ID. It normally ends in `.apps.googleusercontent.com`.

## 4. Configure the GitHub Pages build

In the GitHub repository, add one Actions **Variable**:

- `VITE_GOOGLE_CLIENT_ID`

Set it to the Web OAuth Client ID from the previous step, then re-run the GitHub Pages deployment.

For local development, copy `.env.example` to `.env.local` and set the same value.

## 5. Where the data lives

PJSDAS creates a hidden file named:

`pjsdas-workspace.json`

inside the user's Google Drive `appDataFolder`. The file contains the validated PJSDAS local snapshot plus a fingerprint and device metadata used for conflict detection.

The user does not need to manually manage this file in Drive, and PJSDAS cannot use the `drive.appdata` permission to browse normal Drive documents.

## 6. Local-first and conflict semantics

- IndexedDB is the immediate source used by the UI.
- The Drive copy is a synchronization/recovery copy, not the live database.
- PJSDAS computes a SHA-256 fingerprint of normalized workspace data.
- Google Drive's monotonically increasing file `version` is stored as the remote checkpoint.
- If only local changed, PJSDAS uploads the current snapshot.
- If only Drive changed, PJSDAS validates and restores that snapshot locally.
- If both changed after the last common checkpoint, sync stops and asks the user which side to keep.
- A browser workspace is bound to the first Google account it syncs with. Connecting another account does not silently upload the existing local data.

Before an existing Drive file is updated, PJSDAS re-reads its Drive `version`. If it changed, the write is aborted and handled as a conflict. This is a fail-closed client-side guard rather than a claim of server-side transactional locking.

## 7. Token and privacy boundary

The Google OAuth access token is kept only in current-page memory. PJSDAS does not write it to IndexedDB or `localStorage` and has no refresh-token service in v1.0.

Therefore a full page reload or an expired token can require the user to connect Google again. This affects cloud synchronization only; the complete local application continues to work offline/local-first.

Do not add a client secret, service-account key, or other server credential to GitHub Pages or Vite environment variables.

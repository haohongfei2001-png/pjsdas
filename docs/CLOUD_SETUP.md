# PJSDAS v1.0 Cloud Setup

PJSDAS remains fully usable without cloud configuration. Cloud mode adds Google sign-in and an account-isolated workspace snapshot for cross-device sync.

## 1. Create a Supabase project

Create a project in Supabase, then open the SQL editor and run `supabase/schema.sql` from this repository.

The schema creates one `pjsdas_workspaces` row per authenticated user and enables Row Level Security. Each user can select/insert/update/delete only the row whose `user_id` equals `auth.uid()`.

## 2. Configure Google OAuth in Supabase

Enable the Google provider in Supabase Auth. Create a Web OAuth client in Google Cloud / Google Auth Platform and copy the Client ID and Client Secret into the Supabase Google provider configuration.

Use the callback URL shown by Supabase for the Google OAuth client's authorized redirect URI.

For the PJSDAS web application, set the Supabase Site URL / redirect allow-list to include:

`https://haohongfei2001-png.github.io/pjsdas/`

For local development also add the local Vite URL you actually use.

## 3. Configure the GitHub Pages build

In the GitHub repository, add Actions **Variables** (not a service-role secret):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

The Pages workflow already exposes these two variables to the Vite build. Re-run the Pages deployment after adding them.

For local development, copy `.env.example` to `.env.local` and fill the same two values.

## 4. Security boundary

Never place a Supabase `service_role` key in the browser, repository, GitHub Pages variables, or any Vite-prefixed environment variable. PJSDAS relies on Supabase Auth plus database Row Level Security; the browser needs only the project URL and Publishable key.

## 5. Sync semantics

- IndexedDB remains the immediate source used by the UI.
- Cloud sync compares a SHA-256 fingerprint of normalized snapshot data.
- The cloud row has a monotonically increasing `revision`.
- If only local changed, PJSDAS uploads a new revision.
- If only cloud changed, PJSDAS replaces the local workspace with the validated cloud snapshot.
- If both changed after the last common revision, sync stops and asks the user which side to keep.
- A local browser workspace is bound to the first cloud account it syncs with. Signing into another account does not silently upload the existing local data.

The v1.0 cloud transport is deliberately snapshot-based. This keeps the current local-first domain model authoritative while creating a stable remote boundary for future MCP/API work.

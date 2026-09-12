# v1.8.1 — Stable Account & Sync Session

## Goal

Replace the old tab-scoped Google Drive authorization with a durable PJSDAS account session without changing the local-first workspace model.

Before v1.8.1, browser Drive sync was based on a Google Identity Services access token stored only in JavaScript module memory. Refreshing the page destroyed that token and the UI appeared signed out even though IndexedDB data remained. Separately, Supabase OAuth used for AI access was intentionally stored in `sessionStorage` and explicitly signed out after the Google refresh token was encrypted server-side.

v1.8.1 separates three concepts:

1. **PJSDAS account identity** — durable Supabase Auth session using Google as the identity provider.
2. **Google Drive authorization** — encrypted Google refresh token held server-side and scoped to `drive.appdata`.
3. **PJSDAS workspace data** — remains local-first in browser IndexedDB, with Google Drive `appDataFolder` as the optional cloud copy.

## Runtime data flow

```text
Google account
    │
    ▼
Supabase Auth (PJSDAS account)
    │ persistent PKCE session in browser localStorage
    │ access token auto-refreshed by Supabase
    ▼
PJSDAS browser
    │
    ├── IndexedDB ── immediate workspace / source of truth
    │
    └── authenticated POST /api/google-access-token
            │
            ▼
        Vercel PJSDAS gateway
            │ verify Supabase bearer
            │ read only current user's RLS-bound connection
            │ decrypt encrypted Google refresh token
            │ refresh Google OAuth access token
            ▼
        short-lived Google access token
            │
            └──────────────► browser memory only
                                  │
                                  ▼
                         Google Drive appDataFolder
```

The PJSDAS backend does **not** proxy or persist the workspace snapshot. The browser still calls the Google Drive API directly after receiving a short-lived Google access token.

## Stable sign-in

`src/aiAccess/supabaseClient.ts` now persists the Supabase session in browser `localStorage`, with:

- PKCE flow;
- `persistSession: true`;
- `autoRefreshToken: true`;
- `detectSessionInUrl: true`.

Therefore a normal page refresh or browser restart should restore the PJSDAS account without another Google consent screen while the Supabase refresh token remains valid.

A new sign-in still requests:

- `openid`;
- `email`;
- `profile`;
- `https://www.googleapis.com/auth/drive.appdata`;
- `access_type=offline`.

The returned Google refresh token is passed to the existing `api/google-link` endpoint and encrypted before storage in `public.google_drive_connections`.

## Browser Drive token restoration

The browser no longer depends on a Google access token created directly by Google Identity Services.

When a Drive request needs authorization:

1. the browser obtains its current Supabase access token;
2. it calls `POST /api/google-access-token`;
3. the Vercel endpoint verifies the Supabase user;
4. RLS restricts the Google binding lookup to that user;
5. the encrypted refresh token is decrypted server-side;
6. the server exchanges it with Google for a fresh access token;
7. only the short-lived access token is returned;
8. the browser caches it in memory for less than the expected Google expiry period.

If the browser is refreshed, only this short-lived cache disappears. The PJSDAS account and encrypted refresh token remain, so the next sync can recover a new short-lived token without displaying Google UI.

## Backward-compatible local workspace ownership

Existing v1.0–v1.8 browsers stored `workspaceOwnerUserId` using the Google OIDC subject (`sub`). Supabase uses a different UUID as its internal user ID.

Changing the local owner ID directly to the Supabase UUID would make an existing user's own workspace appear to belong to another account.

Therefore `CloudUser` contains two identities:

- `id` — Google subject, used for existing local workspace owner/checkpoint compatibility;
- `accountId` — Supabase UUID, used conceptually as the durable PJSDAS account identity on the authenticated backend.

The Google subject is recovered from the Supabase Google identity metadata. This lets existing local sync metadata continue to match without rewriting browser workspace state.

If the recovered identity genuinely does not match the existing local owner, PJSDAS keeps the existing fail-closed account mismatch flow. It never silently rebinds or uploads the local workspace.

## Sync and conflict semantics

The v1.0 sync model is unchanged:

- IndexedDB is immediate local authority;
- Drive `appDataFolder` is the cloud copy;
- first sync binds a local workspace to an identity;
- local-only change pushes;
- remote-only change pulls;
- both changed after the last common checkpoint produces an explicit conflict;
- no silent last-write-wins;
- explicit Keep Local / Use Drive remains required for conflict resolution.

Authentication recovery does not weaken those rules.

## Sign-out semantics

Signing out of PJSDAS:

- removes the local Supabase account session;
- clears the in-memory short-lived Google access token;
- stops automatic cloud sync;
- does **not** delete IndexedDB;
- does **not** silently rebind the workspace;
- does **not** delete the encrypted Google refresh token server-side.

A future explicit account-removal / Drive-revoke operation should be modeled separately. "Sign out" and "delete/revoke my cloud binding" are intentionally different actions.

## AI access

The existing ChatGPT/MCP read path already uses the same Supabase identity plus the encrypted Google refresh token. v1.8.1 stops signing the browser out of Supabase after AI access is linked.

This produces one identity layer instead of two competing pseudo-login states:

```text
PJSDAS Google account
   ├── browser Drive sync
   └── ChatGPT authenticated MCP read access
```

AI write semantics remain unchanged: proposals are still review-only, signed, and require explicit local Apply.

## Failure modes

### Supabase session expires or is revoked

PJSDAS continues to expose local IndexedDB data. Cloud sync stops and the user must sign in again.

### Google refresh token expires or is revoked

`/api/google-access-token` fails closed. Local data remains available. Google Drive must be re-authorized before cloud sync resumes.

### Token broker is unavailable

Local workspace remains usable. No local or remote data is overwritten.

### Account mismatch

Auto-sync is paused. The user must explicitly bind the current local workspace or replace it with the selected account's Drive workspace.

### Local and Drive both changed

The existing explicit sync conflict is preserved. Authentication restoration never resolves content conflicts automatically.

## Security boundary

- Supabase publishable key remains public client configuration.
- Google client secret and PJSDAS token-encryption key remain server-only environment variables.
- Google refresh token is encrypted with the existing AES-GCM application-layer envelope before database storage.
- Google refresh token is never returned to the browser after linking.
- `/api/google-access-token` uses `cache-control: no-store`.
- Browser stores only the Supabase account session and an in-memory short-lived Google Drive access token.
- Workspace snapshots are not stored in Supabase.

## Acceptance criteria

Automated:

- durable Supabase storage uses localStorage rather than sessionStorage;
- PKCE session remains auto-refreshable;
- Google login no longer uses the old in-memory GIS token model;
- browser token broker requires a valid Supabase bearer;
- token broker only reads the current user's RLS-bound Google connection;
- missing/revoked Drive binding fails closed;
- short-lived Google token is never persisted to IndexedDB/localStorage;
- AI access linking does not sign out the durable PJSDAS account;
- existing decision, ChangeSet, snapshot, sync and discovery tests remain green.

Final real-browser acceptance after deployment:

1. sign in with Google once;
2. verify existing local workspace is still present and not falsely account-mismatched;
3. sync successfully;
4. refresh the page and confirm the account remains signed in;
5. close and reopen the browser and confirm the account restores;
6. run Sync Now without another Google consent screen;
7. sign out and confirm local IndexedDB data remains visible;
8. sign in again and confirm normal sync resumes.

## Non-goals

v1.8.1 does not:

- move workspace data into Supabase;
- add multi-user collaboration;
- silently merge conflicting workspaces;
- delete server-side Drive authorization on ordinary sign-out;
- change rankings, Decision Rules, Discovery Profile, ChangeSet semantics, or snapshot schema.

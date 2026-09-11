# PJSDAS Remote MCP Gateway

Status: **v1.1 alpha — demo MCP accepted; authenticated real-data path staged behind OAuth**

PJSDAS exposes the same six read-only AI Bridge tools through stateless Streamable HTTP MCP handlers.

## Endpoints

The existing public demo endpoint remains:

```text
https://<vercel-project-domain>/api/mcp
```

It is intentionally unauthenticated and serves only `gateway/fixtures/demo-workspace.json`.

The staged real-data endpoint is:

```text
https://<vercel-project-domain>/api/mcp-auth
```

It has **no demo fallback**. Requests without a valid PJSDAS/Supabase bearer identity receive HTTP 401 with OAuth protected-resource metadata. The standard metadata path is routed to:

```text
/.well-known/oauth-protected-resource
```

and points clients to the PJSDAS Supabase Auth authorization server.

## Read-only tools

Both modes expose exactly these six tools:

1. `get_today_plan`
2. `list_opportunities`
3. `get_pipeline`
4. `get_decision_rules`
5. `explain_priority`
6. `get_recent_timeline`

All reuse `src/ai/readLayer.ts`; there is no second ranking implementation and there are no mutation tools.

## Accepted demo transport

The demo transport is accepted:

- public MCP discovery/tool listing works;
- a tool call works through HTTPS;
- ChatGPT can connect to PJSDAS and call the read tools;
- `/api/health` reports synthetic demo mode;
- production build and CI pass.

Vercel Authentication must stay off for the public MCP transport itself. End-user identity belongs at the PJSDAS OAuth layer, not at Vercel Deployment Protection.

## Google Drive reader

`gateway/driveWorkspaceSource.ts` implements the server-side Google Drive reader. Given a short-lived Google access token, it:

1. queries only `spaces=appDataFolder`;
2. searches only for `pjsdas-workspace.json`;
3. fails closed on zero or multiple workspaces;
4. validates the Drive envelope and PJSDAS snapshot;
5. recomputes the canonical SHA-256 fingerprint before exposing data;
6. returns stable typed auth/Drive/workspace errors without credential leakage.

## Authenticated user-to-Drive chain

The server-side chain is implemented but not switched on for the existing demo connector:

```text
ChatGPT bearer token
  -> Supabase Auth identity
  -> RLS-scoped google_drive_connections row for that user
  -> AES-GCM decrypt provider refresh token
  -> Google OAuth token refresh
  -> DriveWorkspaceSource
  -> validated Google Drive appDataFolder workspace
  -> AI Read Layer
```

Supabase table `google_drive_connections` stores only the encrypted Google provider refresh token plus minimal account metadata. RLS allows authenticated users to select/insert/update/delete only their own row.

`gateway/googleLinkHandler.ts` implements the secure browser-to-server linking endpoint. It validates the PJSDAS identity, validates the Google provider access token, requires the `drive.appdata` scope, checks account identity consistency, encrypts the provider refresh token server-side, and then performs an RLS-protected upsert.

The encryption key must be provided only as the Vercel secret `PJSDAS_TOKEN_ENCRYPTION_KEY`. It must never be committed.

## Browser AI-access setup

The PJSDAS Settings page now includes a separate **ChatGPT · AI Access · v1.1** card. Its Google flow requests:

- `openid email profile`
- `https://www.googleapis.com/auth/drive.appdata`
- `access_type=offline`
- `prompt=consent`

The temporary Supabase setup session is stored in `sessionStorage`. After the encrypted binding is stored server-side, the setup session is signed out locally.

## OAuth consent UI

PJSDAS now contains an OAuth consent page rendered when the production site receives an `authorization_id`. It uses Supabase OAuth 2.1 APIs to:

- authenticate the user with Google if necessary;
- show the requesting client and scopes;
- approve or deny the authorization;
- redirect back to the MCP client.

The authenticated `/api/mcp-auth` endpoint advertises Supabase Auth through protected-resource metadata. OAuth must be enabled/configured in the Supabase dashboard before this endpoint is used by ChatGPT.

## Required deployment secrets

The real-data Vercel deployment requires these server-only environment variables:

```text
PJSDAS_TOKEN_ENCRYPTION_KEY
PJSDAS_GOOGLE_CLIENT_ID
PJSDAS_GOOGLE_CLIENT_SECRET
```

The Google Client ID/Secret here must be the separate **PJSDAS Supabase Auth** Web OAuth client, not values committed into browser code. The secret values must be entered directly in Vercel and never pasted into GitHub or chat.

## Remaining v1.1 acceptance

Before switching normal usage from demo to authenticated real data:

1. configure Supabase Site URL / redirect allow-list for the GitHub Pages PJSDAS URL;
2. enable Supabase OAuth 2.1 Server and point its authorization path at the PJSDAS consent UI;
3. enable dynamic client registration if required by the ChatGPT MCP connector;
4. deploy current GitHub code to the Vercel project and add the three server secrets;
5. run the Settings-page Google AI-access link once and verify an encrypted user binding exists;
6. create/test a ChatGPT connector against `/api/mcp-auth` using OAuth;
7. verify ChatGPT reads the user's real Decision Rules/Today data;
8. test a second identity and prove cross-user reads are impossible.

The v1.1 surface remains read-only. Write-capable MCP tools remain a v1.2 concern and must create pending ChangeSets rather than mutate business state directly.

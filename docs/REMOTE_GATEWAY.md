# PJSDAS Remote MCP Gateway

Status: **v1.1 alpha — remote transport accepted; authenticated Drive wiring in progress**

PJSDAS exposes the same six read-only AI Bridge tools through a stateless Streamable HTTP MCP handler suitable for a serverless deployment.

## Current public endpoint

When the repository is deployed on Vercel, the MCP endpoint is:

```text
https://<vercel-project-domain>/api/mcp
```

A separate health endpoint is available at:

```text
https://<vercel-project-domain>/api/health
```

The current public handler still reports and serves synthetic demo data only:

- `mode: demo`
- `auth: none`
- `data: synthetic-demo-only`

## Security boundary

The current public MCP endpoint is intentionally unauthenticated and MUST remain restricted to the synthetic fixture in `gateway/fixtures/demo-workspace.json`.

The newly implemented Google Drive workspace reader is **not wired into the public handler** yet. A real Google access token must never be hard-coded, committed, exposed as an MCP argument, returned to the model, or placed in the synthetic public endpoint.

The remote server instructions tell MCP hosts that the current public data is synthetic and must not be presented as the user's real job-search state.

## Remote tools

The endpoint exposes exactly these read-only tools:

1. `get_today_plan`
2. `list_opportunities`
3. `get_pipeline`
4. `get_decision_rules`
5. `explain_priority`
6. `get_recent_timeline`

All reuse `src/ai/readLayer.ts`; there is no second ranking implementation and there are no mutation tools.

## Transport

`gateway/remoteHttp.ts` uses the official MCP TypeScript SDK v2 `createMcpHandler` entry. `api/mcp.ts` is the Vercel Web Handler adapter and contains no business logic.

The deployed endpoint has been accepted against ChatGPT after production-level Vercel Authentication was removed from the demo deployment. Deployment-provider authentication must not be used as the end-user identity mechanism for the production MCP connector.

## Remote transport acceptance

The remote transport stage is accepted:

- MCP discovery and tool listing succeed over public HTTPS;
- the intended six read tools are advertised;
- tool calls succeed through the HTTP handler;
- CI tests and the production Vite build are green;
- `/api/health` reports synthetic demo mode;
- a ChatGPT custom connector can call PJSDAS and read Decision Rules.

## Google Drive Server Reader — implemented, not yet public

`gateway/driveWorkspaceSource.ts` implements the server-side read path needed for real user data. Given an access-token provider, it:

1. requests only the Google Drive `appDataFolder` space;
2. searches only for `pjsdas-workspace.json`;
3. fails closed if zero or multiple PJSDAS workspace files exist;
4. downloads the Drive workspace envelope;
5. validates the envelope version and PJSDAS snapshot schema;
6. recomputes the canonical SHA-256 workspace fingerprint and refuses mismatched data;
7. returns the Drive file version as Bridge workspace metadata;
8. never includes the access token in Bridge output or error text.

The source maps Drive/auth failures to stable `WorkspaceSourceError` codes so MCP callers can distinguish missing workspace, invalid workspace, expired/forbidden Google authorization, and retryable Drive outages.

This layer is deliberately dependency-injected: it receives `getAccessToken()` instead of knowing how Google OAuth credentials are stored. That keeps OAuth/token lifecycle separate from workspace parsing and makes the reader testable without real user credentials.

## Next stage: PJSDAS OAuth and user-to-Drive binding

The remaining v1.1 path is:

```text
ChatGPT
  -> HTTPS MCP endpoint
  -> PJSDAS OAuth / user session
  -> server-side Google credential binding
  -> short-lived Google access token
  -> DriveWorkspaceSource
  -> Google Drive appDataFolder
  -> validated pjsdas-workspace.json
  -> AI Read Layer
```

Before the public endpoint can switch from demo data to real data, PJSDAS still needs:

1. a remote PJSDAS user identity model;
2. an OAuth authorization flow compatible with the ChatGPT MCP connector;
3. Google offline authorization for the minimal `drive.appdata` scope;
4. secure server-side storage for the Google refresh credential or an equivalent delegated credential;
5. strict mapping from one PJSDAS identity to exactly one authorized Google account/workspace;
6. refresh-token rotation/revocation handling without exposing Google credentials to the model;
7. an authenticated `WorkspaceSource` factory that creates `DriveWorkspaceSource` for the current authorized user;
8. end-to-end tests proving user A can never read user B's workspace.

The v1.1 surface remains read-only. Write-capable MCP tools remain a v1.2 concern and must create pending ChangeSets rather than mutate business state directly.

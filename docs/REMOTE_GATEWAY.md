# PJSDAS Remote MCP Gateway

Status: **v1.1 alpha — remote transport, synthetic data only**

PJSDAS now exposes the same six read-only AI Bridge tools through a stateless Streamable HTTP MCP handler suitable for a serverless deployment.

## Current endpoint

When the repository is deployed on Vercel, the MCP endpoint is:

```text
https://<vercel-project-domain>/api/mcp
```

A separate health endpoint is available at:

```text
https://<vercel-project-domain>/api/health
```

The health response explicitly reports:

- `mode: demo`
- `auth: none`
- `data: synthetic-demo-only`

## Security boundary

The current remote endpoint is intentionally unauthenticated and MUST remain restricted to the synthetic fixture in `gateway/fixtures/demo-workspace.json`.

Do not point the public handler at a real exported workspace, a local snapshot containing personal data, or a Google Drive access token. The next stage must introduce authentication and a Google Drive-backed workspace source before any real PJSDAS data is exposed remotely.

The remote server instructions also tell MCP hosts that the current data is synthetic and must not be presented as the user's real job-search state.

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

`gateway/remoteHttp.ts` uses the official MCP TypeScript SDK v2 `createMcpHandler` entry. The handler is stateless and supports the 2026-07-28 protocol revision, while the SDK also provides its default stateless legacy compatibility lane.

`api/mcp.ts` is a Vercel Web Handler adapter. It does not contain business logic.

## Alpha acceptance

Before connecting real user data, the remote transport stage is accepted only when all of the following are true:

- `server/discover` succeeds over HTTP;
- `tools/list` advertises exactly the intended six read tools;
- at least one `tools/call` succeeds through the HTTP handler;
- CI tests and the production Vite build remain green;
- the deployed `/api/health` endpoint reports synthetic demo mode;
- a ChatGPT custom app can scan the remote endpoint and see the six tools.

## Next stage: authenticated Google Drive source

The next implementation stage replaces only the `WorkspaceSource`, not the read tools or decision engine:

```text
ChatGPT
  -> HTTPS MCP endpoint
  -> PJSDAS authentication / authorization
  -> Google Drive appDataFolder
  -> validated pjsdas-workspace.json envelope
  -> AI Read Layer
```

Required work before real data can be enabled:

1. define the PJSDAS remote user identity and authorization model;
2. complete an OAuth flow that can maintain access without exposing Google credentials to the model;
3. store refresh credentials securely server-side or use an equivalent delegated authorization mechanism;
4. read only the user's PJSDAS file from Google Drive `appDataFolder`;
5. validate the Drive envelope, snapshot schema and fingerprint before exposing any view;
6. map Drive conflict/account mismatch/auth-expiry states to stable Bridge errors;
7. keep the remote v1.1 surface read-only.

Write-capable MCP tools remain a v1.2 concern and must create pending ChangeSets rather than mutate business state directly.

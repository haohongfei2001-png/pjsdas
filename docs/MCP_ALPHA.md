# PJSDAS v1.1 MCP Gateway Alpha

Status: **read-only local/stdio alpha**

This is the first runnable MCP transport for the PJSDAS AI Bridge. It exposes the existing read layer through the official MCP TypeScript server SDK. It does **not** yet connect a hosted ChatGPT client to the user's real Google Drive workspace.

## What this alpha proves

The gateway can expose six bounded, read-only tools over MCP:

- `get_today_plan`
- `list_opportunities`
- `get_pipeline`
- `get_decision_rules`
- `explain_priority`
- `get_recent_timeline`

Every tool reads a validated PJSDAS snapshot and reuses PJSDAS's existing deterministic decision/process logic. There are no mutation tools in v1.1 alpha.

## Run locally

Install dependencies and start the stdio server from the repository root:

```bash
npm ci
npm run mcp
```

By default the gateway reads the synthetic fixture at `gateway/fixtures/demo-workspace.json`. The fixture contains no real user data.

The server writes MCP protocol traffic only to stdout. Its startup message is written to stderr.

## Use another snapshot file

Set `PJSDAS_MCP_SNAPSHOT_FILE` to a PJSDAS JSON snapshot file before starting the server.

Optional environment variables:

- `PJSDAS_MCP_TIMEZONE` — timezone reported to the AI, for example `Asia/Shanghai`.
- `PJSDAS_MCP_NOW` — fixed ISO timestamp for deterministic testing only.
- `PJSDAS_MCP_WORKSPACE_VERSION` — optional source version label exposed in response metadata.
- `PJSDAS_MCP_DEFAULT_AVAILABLE_MINUTES` — default Today budget, from 30 to 1440 minutes.

A malformed or incompatible snapshot fails closed instead of being exposed.

## Trust boundary

This server is intentionally read-only. It cannot:

- edit Opportunities, Pipeline, Actions, Rules, Timeline, or ChangeSets;
- overwrite a workspace;
- browse arbitrary Google Drive files;
- receive or expose Google access/refresh tokens;
- access a browser's IndexedDB remotely.

The MCP tool responses are bounded semantic views, not a raw PJSDAS database dump.

## What is not implemented yet

The current stdio process is suitable for local MCP hosts and protocol testing. A cloud ChatGPT session cannot launch this process on the user's computer or directly read browser IndexedDB.

The next gateway milestone is therefore a hosted MCP endpoint with user authentication and a server-side authorization path to the user's PJSDAS file in Google Drive `appDataFolder`. That milestone must preserve the same six read contracts and the existing Google Drive validation/fingerprint boundary.

Write intent remains a later v1.2 concern. When writes are added, they must create pending ChangeSets and must not bypass user confirmation.

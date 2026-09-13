# PJSDAS v1.9 — Deployment Portability & Dual-Backend Readiness

## Goal

PJSDAS must not depend on one compute provider for correctness or releaseability. Vercel remains the current primary production backend, but the same backend protocol can run on another provider without forking product logic or creating another business database.

## Invariants

1. Google Drive `appDataFolder` remains the durable workspace.
2. Supabase remains the account/authentication layer.
3. Compute providers are stateless protocol runtimes, not independent PJSDAS states.
4. All providers expose the same `/api/*` contract and the same v1.9 health capabilities.
5. OAuth protected-resource metadata and MCP challenges describe the origin that received the request; provider hostnames are not business identity.
6. Generic user/policy mutations remain ChangeSet-governed. Trusted ingestion remains bounded and optimistic-workspace-version guarded.
7. A browser write is never replayed automatically to another provider after it has already been issued. Provider selection happens before the write request.

## Current topology

```text
GitHub Pages frontend
        |
        | health-select before backend use
        v
ordered backend origins
  1. Vercel production (default)
  2. optional standby provider
        |
        v
same PJSDAS API handlers
        |
        +--> Supabase account/auth
        +--> Google Drive appDataFolder workspace
```

With no additional configuration, the ordered backend list contains only the existing Vercel production origin. Therefore this portability layer is backward-compatible and requires no new key, API token or user setup.

## Browser selection

`src/backendEndpoints.ts` reads `VITE_PJSDAS_BACKEND_ORIGINS` when present. The value is a comma-separated ordered list. If it is absent, PJSDAS uses the existing Vercel production backend.

The browser probes `/api/health` before choosing a backend and caches the selected origin. A failed or rate-limited backend invalidates the cached selection for the next operation. PJSDAS does not blindly replay a write against another provider because a lost response could otherwise duplicate a mutation.

## Server self-description

`gateway/backendOrigin.ts` derives the public origin from:

1. optional `PJSDAS_PUBLIC_BACKEND_ORIGIN` when an operator intentionally exposes a stable canonical API domain;
2. otherwise the incoming Request origin;
3. otherwise the existing Vercel production origin as a compatibility fallback for non-request contexts.

Health payloads, OAuth metadata, and MCP `WWW-Authenticate` challenges use that derived origin.

## Cloudflare adapter

`cloudflare/worker.ts` is a thin route adapter over the existing `api/*` handlers. It does not contain business logic.

`wrangler.jsonc` deliberately contains no secrets. A future real Cloudflare deployment will need the same existing server-side secrets already used by the production backend, but code development and CI do not require the user to enter them again.

Cloudflare Workers compatibility dates after 2026-08-04 provide the Node compatibility needed by the current runtime shape, including environment variables exposed through `process.env`.

## Release gate

GitHub Pages receives `PJSDAS_BACKEND_ORIGINS`. It checks each configured origin until one advertises the complete hardened v1.9 health contract. Pages publishes only after at least one backend is ready.

The production self-test similarly accepts multiple candidate origins and succeeds only when a full self-test passes on at least one provider.

## Activation boundary

This change makes the second provider code-ready; it does not silently create a Cloudflare account or copy secrets. Activating a real standby later is an operational step, not another PJSDAS application rewrite.

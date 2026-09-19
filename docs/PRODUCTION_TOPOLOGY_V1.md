# PJSDAS Production Topology v1

Status: **canonical production/domain/audience contract for v1.1.0**  
Package: **PJSDAS-AI-OPERATED-PRODUCTION-v1 / Round 4**

This document defines deployment topology and activation order. Exact personal-domain
values are deployment inputs. Source code must not guess or invent them.

## Logical production topology

The target topology is:

```text
existing personal website
  └─ /pjsdas
     product landing / docs / privacy / changelog / entry point

PJSDAS Web App
  canonical web origin:
    PJSDAS_CANONICAL_WEB_ORIGIN
    VITE_PJSDAS_CANONICAL_WEB_ORIGIN

PJSDAS API / MCP
  canonical API origin:
    PJSDAS_CANONICAL_API_ORIGIN
    VITE_PJSDAS_CANONICAL_API_ORIGIN

fallback backend(s)
  PJSDAS_BACKEND_ORIGINS
  VITE_PJSDAS_BACKEND_ORIGINS

legacy browser origins
  PJSDAS_LEGACY_WEB_ORIGINS
  VITE_PJSDAS_LEGACY_WEB_ORIGINS
```

The existing GitHub Pages origin
`https://haohongfei2001-png.github.io` remains the default legacy origin until
deployment configuration says otherwise.

## Origin security contract

All first-party browser endpoints use one shared allow-origin policy.

Connected browser endpoints include:

- `/api/google-link`
- `/api/google-access-token`
- `/api/automation-settings`
- `/api/workspace`
- `/api/access`

These endpoints require a real approved browser `Origin`; requests with no Origin do
not gain first-party credential or settings capabilities merely because they carry a
valid bearer token.

A canonical origin and legacy origins may coexist during migration. CORS is still not
authorization: identity, audience authorization, and operation-level authorization are
separate gates.

## Controlled audience

`PJSDAS_AUDIENCE_MODE` has two states:

### legacy

Default. Preserves the current authenticated behavior during migration and development.

### allowlist

A valid Supabase account is not sufficient. The authenticated user must have an active
record in `pjsdas_access_grants` with role:

- `owner`
- `beta`

Allowlist state is server-owned and revocable. Normal authenticated browser clients
cannot mutate the allowlist table.

The controlled-launch order is:

1. create owner grant;
2. verify owner can still access connected Web + MCP;
3. add beta grants deliberately;
4. set `PJSDAS_AUDIENCE_MODE=allowlist`;
5. verify production health and post-deploy self-test;
6. do not open unrestricted signup in v1.1.0.

## Canonical API identity

Public OAuth protected-resource metadata and MCP challenges prefer
`PJSDAS_CANONICAL_API_ORIGIN` when configured.

The frontend prefers `VITE_PJSDAS_CANONICAL_API_ORIGIN` but keeps configured
Vercel / Cloudflare backends as fallback candidates.

A fallback host may serve the exact production build while public metadata still points
at the canonical API identity.

## Why domain cutover cannot happen first

IndexedDB is origin-scoped. A new domain cannot read the old
`https://haohongfei2001-png.github.io` IndexedDB.

Therefore PJSDAS must not implement:

```text
switch DNS/domain
→ hope the new site can find old browser data
```

The required order is:

```text
legacy origin
→ validate Local snapshot
→ validate legacy Drive snapshot
→ compare fingerprints
→ stop if both non-empty states diverge
→ download local migration recovery bundle
→ explicitly bootstrap transactional workspace
→ re-read server state and verify fingerprint
→ only then allow production authority/domain cutover
```

The migration workflow never changes
`PJSDAS_CONNECTED_AUTHORITY` or
`VITE_PJSDAS_CONNECTED_AUTHORITY` itself.

## Connected migration rules

Migration planning selects:

- `reconciled` when Local and Drive fingerprints match;
- `drive` only when Local is effectively empty;
- `local` only when Drive is effectively empty;
- `conflict` when both are non-empty and divergent.

If a transactional workspace already exists:

- matching fingerprint → migration is already complete;
- different fingerprint → fail closed; never overwrite.

Before the first bootstrap, the browser downloads a migration recovery bundle containing
the validated Local snapshot, optional Drive snapshot, selected source, and fingerprint.

## Production authority activation

Connected authority remains default-off.

The activation flag must switch durable writers together:

Server:

```text
PJSDAS_CONNECTED_AUTHORITY=transactional
```

Web:

```text
VITE_PJSDAS_CONNECTED_AUTHORITY=transactional
```

Web sync, MCP, Gmail automation, and Discovery automation must never be split across two
durable authorities.

Activation prerequisites:

1. Round 1 transactional schema applied;
2. Round 2 Gmail continuation schema applied;
3. owner workspace explicitly migrated and fingerprint-verified;
4. service-role credential configured in every backend runtime;
5. canonical API/Web origins configured;
6. owner audience grant exists before allowlist mode;
7. same deployment commit passes production contract;
8. rollback/recovery material exists.

## Release-gate topology checks

`/api/health` publishes:

- `workspaceAuthority`;
- canonical Web origin;
- canonical API origin;
- legacy Web origins;
- audience mode;
- Round 4 capability markers.

GitHub Pages publication and Production Self-Test verify these values against repository
deployment variables. A mismatched topology is a release failure.

## Environment contract

Server:

- `PJSDAS_CANONICAL_WEB_ORIGIN`
- `PJSDAS_CANONICAL_API_ORIGIN`
- `PJSDAS_LEGACY_WEB_ORIGINS`
- `PJSDAS_ALLOWED_WEB_ORIGINS` (optional additional first-party origins)
- `PJSDAS_AUDIENCE_MODE=legacy|allowlist`
- `PJSDAS_CONNECTED_AUTHORITY=google-drive|transactional`
- `PJSDAS_SUPABASE_SERVICE_ROLE_KEY` when allowlist or transactional is active

Frontend:

- `VITE_PJSDAS_CANONICAL_WEB_ORIGIN`
- `VITE_PJSDAS_CANONICAL_API_ORIGIN`
- `VITE_PJSDAS_LEGACY_WEB_ORIGINS`
- `VITE_PJSDAS_BACKEND_ORIGINS`
- `VITE_PJSDAS_CONNECTED_AUTHORITY`

## Domain activation that remains external

The following are deployment/DNS actions rather than source-code guesses:

- exact personal website domain;
- exact PJSDAS app subdomain;
- exact PJSDAS API subdomain;
- DNS records;
- Vercel custom-domain attachment;
- Supabase OAuth redirect allowlist updates;
- Google OAuth authorized redirect/origin updates when required.

These must use the actual selected domain values. Round 4 code is ready to consume those
values without another architecture change.

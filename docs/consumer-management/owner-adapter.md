# Owner management MCP adapter (default off)

This source-only adapter extends the existing authenticated MCP server without changing the v7 core tool directory or old OAuth consent. It is not an activation or consumer-launch claim.

## Supported scope

- `get_business_management`: current account/client v2 consent status, current `txn:N`, and optional bounded exact-ID/paginated reads of preparation, actions or application groups.
- `execute_business_management`: the existing nine reversible batch operations for independent preparation, independent manual actions and application groups. Maximum 50 operations and 256 KiB. The caller supplies a stable command ID and observed base revision, not an account/client selector.
- `undo_business_management`: restore a current-account management command through the same conflict-aware authoritative executor. Other command families are refused.

Existing jobs/process/calendar/correction tools stay unchanged. Scheduled/derived-action edits remain governed by existing domain commands. This is not full CRUD for every business domain. Permanent deletion, credential/security changes and external sharing are not provided.

## Activation gates

All are required before the adapter is constructed: explicit server setting `PJSDAS_OWNER_MANAGEMENT=enabled`, transactional authority, verified delegated OAuth client, and a verified active `owner` role in allowlist mode. Missing, differently spelled or public/beta configuration stays off. No source value sets the environment variable.

A separate exact account/client v2 grant is still mandatory for execution. The adapter does not create one. Grant identity/revision is copied at tool admission and retained through lookup, executor evaluation, retries and atomic SQL commit; replacement/regrant cannot silently authorize an older request. The database transaction remains the final authorization boundary. No generic-RPC fallback is allowed.

The MCP result excludes the complete workspace snapshot and stored compensation. Grant records are not exposed. Responses carry command identity, outcome, workspace version and bounded result/conflict information. Missing consent reports an explicit status; a database or authorization error is never interpreted as consent.

## Required before live use

1. Integrate and deploy the reviewed source with the feature still off.
2. Obtain explicit operator approval before applying the grant-table/RPC migration and enabling the owner-only capability on the existing deployment.
3. Add and review a first-party explicit capability-consent/revocation page and persistence handler. Bind the chosen client to this account's provider-verified OAuth grants. Identity-scope OAuth consent alone is insufficient.
4. The owner explicitly approves the specific account/client capability through that page. No delegated tool may self-grant.
5. Refresh/scan the actual personal MCP connection, verify the three tools appear, then perform an authorized reversible write/readback/undo test. Until then, installed availability and live write success are unverified.

Core v7 tools can be used through a fresh personal remote MCP connection independently of these expanded-management activation steps. A metadata-only old `.app.json` ZIP cannot update its registered app's tool catalog.

## Local verification

Synthetic tests cover default-off/owner-only selection, missing/foreign grants, principal and workspace ownership, strict payloads, bounded output, management-only undo, request-bound proof on regrant/replacement/revoke, real MCP registration and dispatch, exact atomic RPC selection and no fallback after SQL authorization denial. PostgreSQL contention is covered by the separate batch-2 isolated CI. None of these fixtures uses production grants or real workspace data.

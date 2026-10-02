# Owner-only first-party management consent (source-only, default off)

## Existing-resource endpoint

`GET`/`POST /api/workspace?surface=owner-management-consent` reuses the existing Vercel function. The ordinary workspace handler is unchanged. Cloudflare imports the same API module. The 12-function deployment guard remains unchanged; no additional service or paid capacity is required by this source change.

`PJSDAS_OWNER_MANAGEMENT_CONSENT` must explicitly equal `enabled`; otherwise this surface returns 404 before authentication, provider lookup or storage access. This flag is independent of MCP execution activation. No value is set by this change.

## Explicit versioned decision

Only a verified first-party bearer session from a configured first-party Origin with current allowlist owner access can enter. After the provider verifies the bearer, a denial-only shape check requires a classifiable JWT with no client_id claim at all. Delegated, unknown-version and unclassifiable tokens fail before provider-client or grant access; token decoding never authenticates an identity. Approval clients are freshly fetched from the provider's current-user OAuth grants endpoint, using that same first-party session. Client metadata supplied in a body is never trusted.

GET returns the account, provider client names/IDs, exact existing management grant proof, versioned scope and its hash. The current v2 scope covers independent preparation, independent manual actions and application groups, with reversible archive and conflict-aware undo. It excludes other accounts, additional business domains, permanent deletion, security settings and external effects. Expanding that scope requires a new explicit consent version. It is not a custom OAuth identity scope.

The final POST requires `confirmed: true`, exact displayed `expectedAccountId`, client ID, consent version/hash, stable request UUID and exact expected grant ID/revision (or null for a new approval). The account assertion must match the verified session; it never selects an account. This prevents a stale consent page from approving for another account after a session switch. A stale grant, changed scope, unknown client or conflicting request fails closed.

Revocation requires an owned grant proof and can proceed after the OAuth connection was disconnected. The server does not rely on a now-absent provider grant to deny access reduction. The SQL target remains restricted to the verified user's grant.

## Transaction and audit

The service-role-only SECURITY INVOKER RPC locks the current owner allowlist row, serializes consent decisions for that account, and locks/checks the exact grant before mutation. Every committed decision writes an append-only audit event in the same transaction. Service role receives only SELECT/INSERT on that audit table, explicitly overriding possible default privileges. Revocation/regrant increments the existing management grant revision.

A repeated request ID with the same hash returns its historical receipt without another mutation or event. A different payload under the same ID conflicts. In particular, replaying an old approval after revocation never restores access. HTTP responses label this as a historical receipt and require a fresh read for current state; they do not claim the returned approval is still active. A lost RPC response, unexpected HTTP failure or malformed successful RPC result produces CONSENT_OUTCOME_UNCONFIRMED (503), with the original request ID and read-back/same-ID-only recovery guidance, never a false login failure or claim that nothing committed.

The provider lookup is an external preflight, not part of the database transaction. Supabase OAuth/session validation remains a separate boundary; the SQL proof guarantees concern this app's owner/capability grant rows, not atomic synchronization with the external provider.

## Verification and remaining gates

Synthetic HTTP tests cover disabled state, Origin, first-party/owner requirements, current account assertion, provider client validation, explicit confirmation/version/hash, malformed/oversized requests, exact CAS proof, disconnected-client revocation and unchanged default workspace routing.

The PGlite fixture executes the real SQL and verifies role privileges, first-party/provider/owner gates, CAS, immutable event permissions, idempotency, revoke/regrant and stale or foreign proofs. The separate real PostgreSQL multi-session script tests duplicate decision races, stale competing decisions and owner-revocation ordering. Until the exact-head CI job completes, new consent multi-session contention is NOT_RUN.

There is no user-facing expanded-consent page in this batch. Before activation, implement/review that page with exact account/client identity and the server-provided versioned scope before the final user-operated button; test session switching, stale responses, repeated clicks and uncertain outcomes. Then obtain explicit operator authorization for the live migration and owner-only flags, and the owner's explicit grant decision. No production migration, grant or flag has been applied here.

Provider contract: https://supabase.com/docs/reference/javascript/oauth-server-listgrants and the installed auth-js current-user `/user/oauth/grants` implementation. No client-registration or admin-client endpoint is used.

# Temporary review-token resource hook — approval required

The existing plugin completes provider login, but two host tool-refresh attempts failed and the host cannot select business v7 tools. This is not successful installed-host acceptance. Production has no custom access-token hook. Supabase's current issuer uses the user's `authenticated` audience by default, while TodayAction deliberately requires the canonical MCP resource. This explains a missing resource binding; the host's private token has not been extracted, so this remains a source/configuration diagnosis rather than a captured-token assertion.

## Proposed additional scope

Only the existing `yyrzwpoxlxpafdlbkdtg` project; no new client, plugin, paid service or public exposure. The prepared generator accepts the existing two-identity review manifest and its existing deadline; it cannot extend the lease implicitly. The pending operation installs one pure JSON PostgreSQL function and enables it as the project's Custom Access Token hook. This is an Auth configuration change plus a new function EXECUTE grant, and is **not approved by the earlier controlled-test authorization**.

The function changes claims only when both the fixed synthetic identity and its trusted Auth `app_metadata` match the exact project, lease, label, deadline and original OAuth client. The issuer, role and original audience must also match. It preserves `authenticated`, adds `https://todayaction.com/api/mcp`, and caps token expiry at the existing review deadline. First-party login tokens, other clients, other users, malformed inputs, expired leases and other audiences pass through unchanged. It grants no v7 consent, audience access, tables, scopes or other domain permissions. The resource-server checks remain unchanged.

The hook runs for token issuance at project level, so even a conditional function introduces an authentication availability dependency. Use SECURITY INVOKER, an empty search path, no table access, no network calls, and only the Auth service's EXECUTE permission. Preserve the existing schema permissions. Verify the baseline immediately before changing it; stop if an existing hook or unrelated configuration has appeared. Apply the function and its ACL in one transaction with `lock_timeout=2s` and `statement_timeout=15s`; do not retry a failed migration automatically.

## Execution and rollback

1. Freeze and hash the generated SQL and manifest. Confirm the original hook configuration is empty and the function absent. Read the original client registration without exposing its secret.
2. After explicit approval, install the exact function, read back definition and ACL, then use the existing logged-in Supabase administration session to enable only this hook. Do not edit the OAuth client or scopes.
3. Reconnect the synthetic identity through the original plugin's normal OAuth UI. Verify actual tool discovery, v7-only consent, read/write/undo, refresh, isolation and revocation. Direct SDK/backend tests do not substitute for this host journey.
4. On failure, completion or expiry: disable the hook first, verify its configuration is disabled, drop only the exact prepared function in the explicit timeout transaction, and verify absence. Revoke the two synthetic users' audience/v7/OAuth grants and sessions, ban the synthetic identities, remove temporary application flags, and verify denial. Never disconnect the user's original plugin account.

Native PostgreSQL and PGlite fixtures test identity/client/issuer/metadata mismatch, first-party login, unrelated users, audience formats, expiry capping, malformed expiry, lease expiry without sleeps, preservation of unknown claims, denied anon/authenticated invocation, no table permission, and removal without changes to unrelated fixture data. The existing token-binding tests separately preserve rejection of generic or foreign audiences.

This proposal does not enable normal-user access or public store publication. The business v7 review remains the only approved functional domain.

References: [Supabase hook security](https://supabase.com/docs/guides/auth/auth-hooks), [Custom token hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook), [issuer implementation](https://github.com/supabase/auth/blob/master/internal/tokens/service.go), [resource audience issue](https://github.com/supabase/auth/issues/2610).

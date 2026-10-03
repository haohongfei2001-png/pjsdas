# Consumer OAuth resource binding

Source change, 2026-10-03. Not an OAuth configuration change or a live grant.

The consumer contract requires issuer, expiry, account, client and MCP resource binding. Provider validation through Supabase `/auth/v1/user` remains the authentication boundary. After that succeeds, the consumer runtime additionally requires an OAuth client ID, matching subject and issuer, unexpired integer `exp`, valid optional `nbf`/`iat`, and an `aud` string or string array containing the server-configured canonical MCP resource. It never derives the expected resource from the incoming Host header. Decoding an unverified token cannot authenticate a request.

Tokens containing only Supabase's default `authenticated` audience cannot expose consumer management tools, including through guessed tool calls. Existing bounded core and separately gated owner capabilities retain their existing behavior. Resource binding does not replace the audience allowlist, feature flag or live account/client/domain consent checks.

## Activation gate

Before enabling consumer management, use the existing plugin's actual OAuth flow to verify that a provider-validated access token binds to `https://todayaction.com/api/mcp`, its actual registered client and the signed-in account. Do not paste tokens into reports or chat. A normal account session or generic `authenticated` audience is insufficient. If the current provider/client configuration cannot issue this claim, leave consumer management disabled and obtain approval for the specific OAuth configuration change. Do not infer a client ID from a plugin reference or broaden all tokens through a global hook.

Current provider documentation describes `client_id` and custom access-token hooks for audience customization; that is an available design path, not evidence that this project's configuration or installed host implements it. Recheck provider REST/RLS compatibility and refresh behavior with the approved client before any change.

- [Supabase OAuth token security](https://supabase.com/docs/guides/auth/oauth-server/token-security)
- [Supabase MCP authentication](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication)

## Validation

`tests/consumerMcpTokenBinding.test.ts` first reproduced consumer tools being exposed to a provider-valid token for a different resource. After the fix, synthetic request tests cover valid string/array audiences, disabled feature, provider rejection, wrong Host-derived resource, issuer/subject/client mismatch, expiry and optional time claims, and guessed direct calls before management data access. These tests do not claim real-host OAuth acceptance.

The local full unit suite passed 2,022 tests. Local macOS TypeScript compilation encountered the existing `RecordCorrectionReview.tsx` / `recordCorrectionReview.ts` module-resolution case collision; cloud Linux CI is the build gate. Preserve that local failure separately from cloud results.

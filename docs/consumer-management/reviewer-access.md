# Developer-operated reviewer access

Status: source preparation, not a created review account or completed host acceptance.

## Existing resources

Use Supabase project `yyrzwpoxlxpafdlbkdtg`, the existing website/deployment, original TodayAction plugin and verified original OAuth client. The public Auth settings were read on 2026-10-04: email and Google authentication are already enabled; email auto-confirmation is disabled. No authentication configuration was changed. Existing `production-certification` code provisions synthetic identities through its configured service credential; that credential must remain in the secret manager.

The dedicated first-party login route is `https://todayaction.com/?reviewer_login=1`. It uses the existing `signInWithPassword` provider and only accepts developer-created `ta-consumer-review-[a|b]-<uuid>@example.invalid` addresses. The format check prevents accidental personal-account use; it is not an access grant. Every existing audience, client, domain-consent and ownership check remains enforced. The page neither signs out nor replaces an existing personal session. Credentials are never URL parameters, logs, fixtures in the repository or package metadata.

## Minimum pending production authorization

Developer execution, no owner-operated A/B workflow:

1. Create exactly two new synthetic identities under the existing project, each with a generated random password, an explicit test-purpose app-metadata marker and distinct UUID. Use no email delivery. Record private recovery metadata before subsequent steps; never substitute an existing user if a create result is uncertain.
2. Insert only their two new beta audience rows, configure the exact two account IDs and verified existing client, and enable only the existing consumer onboarding/scoped-management switches. Keep allowlist/transactional mode and all other accounts unchanged. No OAuth client creation, callback edit or extra domain consent.
3. Use separate browser storage, normal password login, the original installed plugin OAuth flow and first-party business-v7 consent. Do not seed sessions or insert grants as a substitute for host acceptance. The reviewer login succeeds without creating a workspace; blank initialization and v7 approval remain explicit subsequent actions.
4. Execute the versioned five positive/three negative cases, reverse A/B roles, replay command IDs, race writes/revocation, verify fail-closed access after all flags are off, and capture synthetic-only desktop/mobile evidence. Record actual request/receipt boundaries, failures and retries honestly.
5. At completion/failure revoke these identities' domain and audience access, revoke sessions and prevent further sign-in; close the temporary flags and remove this test cohort/client configuration. Verify stale access is denied. Keep scoped synthetic receipts for diagnosis; no unrelated user deletion. Longer-lived reviewer access for platform review requires an explicit retention decision.

This document is an execution proposal, not approval. The owner confirms only new security-sensitive scope and irreplaceable publisher identity/login; the developer performs account creation, UUID lookup, login/switching, QA and cleanup.

## Reviewer instructions after authorization and successful host tests

Provide these privately through the existing portal's Review details, not the ZIP:

- Login URL: `https://todayaction.com/?reviewer_login=1`.
- Dedicated account and password: supplied by the developer through the secure review form; no real user's data.
- Sign in, then return to the original TodayAction plugin and complete the normal OAuth connection.
- Open the workspaces/authorization link and select only business management if not already explicitly granted for the demo. Run the cases in `plugins/todayaction/plugin.json`.
- Revocation entry: `https://todayaction.com/?scoped_access=1`; revocation remains available when admission is closed.

Do not submit this as ready until the account works outside the development network, no owner verification step is required, the installed catalog contains the expected tools, and all cases have real host receipts. Review credentials remain outside public files. Official requirements: [submission](https://developers.openai.com/plugins/deploy/submission), [remote MCP review](https://developers.openai.com/plugins/deploy/app-review). Existing Supabase behavior: [password authentication](https://supabase.com/docs/guides/auth/passwords).

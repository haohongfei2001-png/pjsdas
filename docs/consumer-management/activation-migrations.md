# Exact consumer migration plan — not applied

Read-only inspection of Supabase project `yyrzwpoxlxpafdlbkdtg` on 2026-10-03 used migration history, actual function bodies/signatures, role privileges, RLS, columns and grant constraints. [Machine-readable schema evidence](production-schema-2026-10-03.json) contains no workspace data or grant rows. Source reference: PR237 head `0b98402519cd4ddea0997835ed759f028cdf9352`.

## Already present: do not reapply

| Source file | Platform history | Structural evidence |
| --- | --- | --- |
| `20261002123812_consumer_management_atomic_grants.sql` | `20261002174410_consumer_management_atomic_grants` | Grant table columns/RLS and v2-only constraints match; trigger function body MD5 `6b4bdd6aae253333bbed6c87327c27bd`; commit wrapper body MD5 `cd0a9332d6210a7786acabbc4bb225af` exactly match source. |
| `20261002143625_owner_management_consent_audit.sql` | `20261002174430_owner_management_consent_audit` | Owner audit table columns/RLS match; consent function body MD5 `f1331355132980d02d2cc6cd5c34bcdd` exactly matches source. |

All three inspected baseline functions are SECURITY INVOKER with `search_path=public, pg_temp`; service_role can execute, anon/authenticated cannot. The current grant constraints permit only `workspace.manage` / version 2. The scoped-consent table and all consumer v3–v7/bootstrap entry functions are absent.

## Pending: apply only this ordered chain after explicit authorization

| Order | Exact repository file | Missing structure / change |
| --- | --- | --- |
| 1 | `20261002175431_opportunity_management_v3.sql` | Expand exact capability/version constraint; opportunity commit wrapper. |
| 2 | `20261002195807_planning_management_v4.sql` | Planning capability/version and commit wrapper; depends on v3. |
| 3 | `20261002211312_discovery_profile_management_v5.sql` | Discovery-profile capability/version and wrapper; depends on v4. |
| 4 | `20261002220516_private_reminder_management_v6.sql` | Private-reminder capability/version and wrapper; depends on v5. |
| 5 | `20261002234255_opportunity_management_raw_boundary.sql` | Exact compact evidence byte verifier and replacement v3 raw-preservation wrapper. |
| 6 | `20261003083410_scoped_management_consent_batch.sql` | Scoped-consent audit table and atomic multi-domain consent function. |
| 7 | `20261003091106_consumer_bootstrap_audience.sql` | Consumer empty-workspace initialization with locked audience verification. |
| 8 | `20261003104723_consumer_business_scoped_access.sql` | Distinct business v7 constraint/wrapper, five-choice consent replacement and v2/v7 replay fence in the existing v2 wrapper. |

There is no `db push` step. Timestamp mismatch alone is not a missing migration. Before application, re-read history and schema, compare the exact reviewed files, and halt on unexpected drift. Apply each reviewed migration through the platform migration mechanism in dependency order, recording the returned platform version and source SHA-256. Do not issue grants or mutate snapshots as part of schema application. If a later migration fails, preserve its error and leave consumer flags off; do not blindly replay the whole chain.

After application, recheck table columns, RLS, constraints, exact function signatures/bodies and role privileges against the reviewed chain. Replacing the v2 wrapper in step 8 is expected; it adds only the cross-family receipt refusal to valid existing v2 behavior. Do not claim schema installation from the source-derived health migration list.

## Separate operator decisions

The current user authorized engineering/merge/deployment but explicitly reserved live flags, audience, OAuth credentials and persistent permission expansion. Obtain concrete authorization for this migration chain and the following controlled test inputs before executing them:

- Keep `PJSDAS_AUDIENCE_MODE=allowlist`; identify exact synthetic test accounts to admit as beta. No public/legacy audience expansion.
- Enable `PJSDAS_CONSUMER_ONBOARDING=enabled` and `PJSDAS_CONSUMER_SCOPED_MANAGEMENT=enabled` only in the approved deployment. The existing consumer flag also gates its consent surface; do not enable unrelated owner flags.
- Use the verified existing plugin/OAuth client and existing resources. Do not create credentials, reconnect real users, modify paid plans or add external delivery.
- Each approved test user must explicitly choose scopes in the first-party page. Database migrations and operator activation never imply user consent. No direct grant insertion.

Then run the [real-host acceptance](plugin-delivery.md#real-host-acceptance-after-controlled-activation). Rollback means disabling the new runtime/onboarding flags and stopping new admission while retaining grants/audit/workspace/history for investigation. Do not drop tables, delete receipts or rewrite historical snapshots. Preserve a first-party path for owned revocation; do not leave users unable to revoke during an incident.

# Batch 2: transaction-bound authorization (source-only, not activated)

## Added
- Server-owned management grant identity and monotonically increasing revision. Revoke/regrant updates bump revision; deletion/recreation obtains a new UUID, preventing old requests from matching a replacement grant.
- `pjsdas_commit_management_workspace_v1` is a service-role-only, SECURITY INVOKER wrapper. It locks the exact account/client active grant with FOR SHARE, verifies UUID/revision/consent version, and invokes the existing authoritative commit RPC inside the same transaction. A concurrent grant revoke/update/delete must serialize with the held row lock. It also verifies an undo target is that account's committed management command.
- Gateway copies and binds the first observed grant ID/revision for the entire execute/undo request and all CAS retries. Every later read must match that proof; a revoked/regranted or replaced grant cannot revive an older in-flight request. The bound proof is carried into the atomic RPC. Management execution cannot fall back to the old generic RPC when grant evidence is absent or database authorization fails.
- Read-only grant resolver and pure first-party consent binding helpers. Initial authorization details must match the verified session and authorization request. Existing OAuth auto-redirect is never taken as expanded approval; the separate upgrade helper selects a client only from the current user's trusted provider grants. Delegated clients cannot approve their own access.

## Deliberately not connected
No production resolver is instantiated, no migration is applied to a live database, no persistent grant is issued, no new OAuth setting is configured, and no consent HTTP handler or public tool is activated. The migration alone creates no grant. Actual issuance/revocation UI and production activation remain separately reviewed and authorized steps.

## Verification
- Runtime tests cover regrant/replacement before execute/undo commit and after execute/undo CAS conflicts (including a resolver reusing mutable objects), strict grant shape, identity/revision, foreign user/client, wrong/missing provider consent, self-grant refusal, old-connection upgrade binding, exact RPC selection and no fallback after denial.
- `npm ci --prefix tests/sql && npm test --prefix tests/sql` runs the real migration/functions against in-memory PostgreSQL via pinned PGlite 0.5.8, with only synthetic users/data. It checks SQL syntax, execute/table privileges, account/client binding, current/stale/revoked/regranted identities, valid/foreign undo targets and replacement grant rejection.
- PGlite uses one backend. This test does not claim to validate real concurrent multi-session scheduling. A dedicated PostgreSQL concurrency exercise is still required before activation: (a) revoke commits before a queued mutation, which must reject without ledger changes; (b) mutation locks grant first, revocation must wait until mutation commits; (c) revoke/regrant/new ID prevents stale revision/identity reuse. Exact lock behavior follows PostgreSQL FOR SHARE vs UPDATE row locks.

## Packaging and dependencies
The migration was generated locally by pinned Supabase CLI 2.119.0. The CLI was not connected to a project. SQL fixture dependencies have their own isolated lockfile under tests/sql; they do not add a production runtime dependency. No secrets or real workspace content are included.

## Isolated concurrency CI

The Consumer Management SQL workflow runs on the existing GitHub Actions runner with a temporary PostgreSQL 17 service, `contents: read`, no secrets and a 10-minute job limit. It first runs the in-memory fixture, then a separate multi-session fixture using only the hard-coded synthetic loopback database identity. The runner rejects other hosts, database names and credentials and never resets an existing database. It observes actual PostgreSQL lock waits through `pg_stat_activity` before releasing blockers; it does not use sleeps to assume that revocation won a race.

Until that workflow has successfully completed for the exact candidate, multi-session contention remains NOT_RUN. Passing it establishes the tested ordering scenarios; it does not activate any production grant or migration.

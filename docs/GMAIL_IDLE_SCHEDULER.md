# UU06 Gmail idle scheduler — applied

Execution: `UU06-20260921-aem01`, bounded idle-scheduler increment.
Baseline: fresh remote main `db5a293951a18a7e6513e7ed2ca5b6e52700f19b`.
Implementation branch: `manager/uu06-idle-scheduler-20260921`, merged PR #103.
Merged runtime: `107795acbb17dbbd17ea9e5f1963c39d39a91957`.
Implementation writer: AEM executor `/root/pjsdas_uu06`; manager owns canonical publication.
Corrected migration is **applied**, production version `20260921065934`.
UU06 remains IN_PROGRESS; only this bounded idle-scheduler increment is published.

Previously, even zero eligible Gmail bindings caused the hourly scheduler to enqueue
a backend HTTP request. The deployed command adds exactly this predicate to that existing
request: an enabled `google_drive_connections` row with `revoked_at IS NULL` must
exist. This matches the worker claim predicate. It deliberately does not require
`uu06-v1` consent: enabled legacy bindings retain their authorized intake behavior.

`20260921062843_gmail_scheduler_skip_idle.sql` changes only the existing Gmail job's
command using `cron.alter_job`. It retains job ID/name, `5 * * * *` cadence, current
active/paused state, database/user/node, original Vault origin/token lookup, endpoint
`/api/automation-gmail`, empty JSON body and 20000 ms timeout. Discovery is untouched.
Missing/duplicate jobs or unexpected cadence fail rather than creating/reactivating
a job or silently changing its frequency. The old activation migration is not rerun.
No new function grants, source scope, mailbox opt-in, execution flag or paid resource
are introduced. This reduces idle backend wakes; it is not a live latency SLO fix.

## Verification

Run `scripts/verify-gmail-idle-scheduler.mjs` with isolated pinned PGlite 0.3.14
(`PJSDAS_PGLITE_MODULE` can identify the existing isolated module).

Actual PostgreSQL executes the migration and the resulting stored command against
synthetic `cron.alter_job`, `net.http_post` and Vault fixtures; it does not run the
pg_cron background extension, contact production, read real Vault values or send HTTP.
Assertions prove:

- Empty / disabled / revoked / NULL-enabled rows produce zero HTTP calls.
- An enabled, non-revoked legacy NULL-consent row produces one HTTP call.
- Several eligible rows still produce one HTTP call, never one per binding.
- Request URL, authorization identity, body and timeout equal the old synthetic request.
- Only the Gmail command changes; metadata and the entire Discovery row stay identical.
- Applying the migration enqueues nothing; a paused job remains paused, rerun is
  idempotent, missing jobs are not created, and schedule drift is rejected.

The fixture's old Gmail command MD5 is `e50ce09a4cfa70b7424aa46d65268c46` and
Discovery command MD5 is `1245da13ee3902ae7fc10e0b8ffef78d`, matching the manager's
06:29 UTC production metadata-only readback. Manager pre-apply and post-apply checks verified Discovery's command digest stayed
unchanged; the successful readback is recorded below. An
opt-in/revocation racing a scheduler statement is bounded by its database snapshot;
the existing worker rechecks authorization when claiming bindings. No claim of
transactional cancellation of an already-enqueued HTTP request is made.

The original candidate `9f09e3df69af73b89db1655a1fc7cb2a7b31e23e` passed local
SQL review and exact remote CI/browser. Its production apply attempt then failed with
SQLSTATE `42501`, permission denied on `cron.job` at `SELECT ... FOR UPDATE`.
The manager verified that the migration did not enter history and both original job
command digests/schedules remained unchanged. This was a real database privilege
error, not an automatic approval rejection, and is preserved as failed evidence.

Production metadata permits the migration role to SELECT `cron.job` and EXECUTE
`cron.alter_job`, but not directly UPDATE the table. The correction removes only the
unnecessary `FOR UPDATE`; strict single-job lookup and cadence checks remain, and the
supported command-only API is still the only write path. No privileges are granted.
The manager also verified the actual C API using an unchanged-command transaction
(`BEGIN` → existing command through `cron.alter_job` → `ROLLBACK`): it succeeded
without committing any configuration change. No command or Vault value was output.
The SQL harness now runs migration statements as a non-superuser role with exactly
SELECT-only catalog rights and API EXECUTE. It first proves the old lock fails without
changes, then proves the correction and safety cases pass. The synthetic API stub
uses a restricted SECURITY DEFINER to emulate the C extension's permitted internal
write path; production `cron.alter_job` is a C function, not SECURITY DEFINER. This
fixture does not claim to test pg_cron's C implementation or replace real apply checks.
The corrected SHA `de8d519a35fe14948e230870c2c8c6d0276ad2e4` passed independent
review and exact CI `35570662417` (717/717 and build) / Browser `35570662443` (35/35)
before manager production apply and merge.
There is still zero live opt-in in the last manager readback, the execution-control
flag remains off, cadence remains hourly, and actual usage/cost headroom is unknown.
This candidate does not certify Gmail p95/compensation or start UU07.

## Applied and exact-main verification — 2026-09-21

The manager applied corrected source migration
`20260921062843_gmail_scheduler_skip_idle.sql` as production history version
`20260921065934` / `gmail_scheduler_skip_idle`, then merged PR #103 at runtime
`107795acbb17dbbd17ea9e5f1963c39d39a91957`.

Live manager readback retained Gmail job 15, active, `5 * * * *`; its command MD5
is now `6f9a09b50bf3a08f87597287ea451e27` and both eligibility predicates are present.
Discovery job 16 remains active at `15 * * * *`, with unchanged command MD5
`1245da13ee3902ae7fc10e0b8ffef78d`. Source command identity, Vault identity and timeout
were preserved. Consent `20260921053337` and execution controls `20260921055432`
remain applied, with no binding or expanded grant enabled and controls flag still off.

The manager additionally ran a repeatable-read transaction: assert zero eligible
bindings, execute the already-stored Gmail command, assert returned row count 0 and
no increase in `net.http_request_queue`, then ROLLBACK. It succeeded without outputting
command/Vault values or sending HTTP. This real database path supplements the isolated
SQL harness without fabricating a live Gmail workload.

Natural pg_cron execution was then independently observed through metadata only:
job 15 started `2026-09-21 07:05:00.172696+00`, ended `07:05:00.185355+00`, status
`succeeded`. The exact `return_message = 'SELECT 0'` predicate was **false**; a bounded
follow-up found `btrim(return_message) = '0 rows'` **true**. Thus this pg_cron version
reported zero result rows in its own format; no raw response or job command was read
out. This is natural idle execution evidence, not mail intake/latency certification.

Exact runtime checks:

| Gate | Run | Result |
|---|---|---|
| CI | [35570999524](https://github.com/haohongfei2001-png/pjsdas/actions/runs/35570999524) | 717/717 and build PASS |
| Browser | [35570999455](https://github.com/haohongfei2001-png/pjsdas/actions/runs/35570999455) | 35/35 PASS |
| Deploy | [35570999520](https://github.com/haohongfei2001-png/pjsdas/actions/runs/35570999520) | SUCCESS |
| Production Self-Test | [35571134736](https://github.com/haohongfei2001-png/pjsdas/actions/runs/35571134736) | SUCCESS, canonical todayaction.com, ok=true |
| Release workflow | [35571158549](https://github.com/haohongfei2001-png/pjsdas/actions/runs/35571158549) | SUCCESS, release creation SKIPPED, publication disarmed |

Canonical `/api/health` and `/release-manifest.json` both report the exact runtime SHA.
MCP contract hash is `sha256:da18e6ce6716e6dc7bc341ae9d08e9777de7c4402fb3d1e2876dbf3159eec2b3`;
migration-set hash is `sha256:61cda69f2fedafae635b344a8a37a3c9766539eb63c034152c8aaa2f029a8466`.
Canonical frontend artifact digest remains
`sha256:96a822fda5ded3ecde7dcaa780f690f61bec1de0b3a2823f9925557332faac90`, consistent
with no frontend code change. Those are published identity/manifest observations,
not an independent rehash of every live asset. The self-test's optional authenticated
tool-list check was explicitly skipped; no private workspace or recruiting content
was read for verification.

This closes only the bounded idle-scheduler deployment checkpoint. UU06 and its
execution remain IN_PROGRESS: hourly cadence still cannot satisfy the frozen latency
requirements, zero live opt-in cannot certify source-to-commit SLO, the controls flag
remains off, and actual account usage/cost headroom remains unknown. The linked
Supabase organization plan is verified free, which is not a remaining-capacity measure.

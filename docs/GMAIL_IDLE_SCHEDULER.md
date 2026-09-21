# UU06 Gmail idle scheduler — candidate

Execution: `UU06-20260921-aem01`, bounded idle-scheduler increment.
Baseline: fresh remote main `db5a293951a18a7e6513e7ed2ca5b6e52700f19b`.
Branch: `manager/uu06-idle-scheduler-20260921`.
Writer: AEM executor `/root/pjsdas_uu06`; manager owns main and production apply.
Migration is **not applied** by this candidate. UU06 remains IN_PROGRESS.

Previously, even zero eligible Gmail bindings caused the hourly scheduler to enqueue
a backend HTTP request. The candidate adds exactly this predicate to that existing
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
06:29 UTC production metadata-only readback. The manager must recheck those facts
before apply and verify Discovery's command digest is unchanged afterward. An
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
Independent review and exact-candidate CI remain required for the corrected SHA.
There is still zero live opt-in in the last manager readback, the execution-control
flag remains off, cadence remains hourly, and actual usage/cost headroom is unknown.
This candidate does not certify Gmail p95/compensation or start UU07.

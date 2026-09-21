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

Independent review and exact-candidate CI remain required before manager publication.
There is still zero live opt-in in the last manager readback, the execution-control
flag remains off, cadence remains hourly, and actual usage/cost headroom is unknown.
This candidate does not certify Gmail p95/compensation or start UU07.

# Gmail execution controls — dormant candidate

This UU06 increment does not change cron, enable any binding, apply a migration,
create credentials or certify live latency. `PJSDAS_GMAIL_EXECUTION_CONTROLS`
is absent/false by default. Existing disabled behavior uses the previous endpoint path.

## Controlled path

After the additive consent migration, the unapplied execution-controls migration adds
an RLS-protected table with no direct anon/authenticated privileges. The existing
Vault-validated worker identity may call three bounded RPCs: begin, assert, finish.
Every empty/wrong token is rejected. There is no credential or source-scope expansion.

Begin locks one enabled non-revoked connection, grants a 60-second UUID lease, and
returns a fresh binding including its existing consent/cursor. A concurrent invocation
is coalesced before source access. Expired leases may be replaced. Before workspace
write the worker checks budget and live lease/binding version. Existing Drive CAS or
transactional authority remains the actual workspace write guard.

Finish atomically checks lease owner, expiry, connection version and enabled/revoked
state, updates only the successful run's continuation/history, stores whitelisted
aggregate metrics, and releases the lease. Failed/aborted runs cannot change cursor.
A lost finish response remains uncertain; retries never fall back to an unfenced write.
Consumed-message evidence makes a later source replay safe after a Drive commit whose
SQL acknowledgment was lost.

A binding that has ever entered controlled execution remains fenced from both old
v1 and v2 state-update RPCs. This persists after lease release or expiry, preventing a
late pre-upgrade worker from replacing newer continuation/history. An internal trigger invalidates an active lease when authorization or cursor fields
change, even if an RLS-authorized caller omits updated_at. It stores no credential
copy or fingerprint. Never-controlled
bindings retain their old behavior. The marker is deliberately not auto-deleted.

## Budget and observability

The controlled handler has a maximum 15-second monotonic invocation budget, including
claim and cleanup. It reserves up to 1 second to report failure; source I/O receives
an abort signal, further bindings defer, and write/finish have explicit budget guards.
Lease expiry provides recovery if cleanup itself fails. Abort cannot recall a request
already accepted by a remote service; CAS and the durable state fence remain required.

Only the last run's mode, status, server-measured lease-to-finish duration, bounded
received/accounted/unresolved counts, and a whitelisted error code are retained, plus
completed/failed/coalesced aggregate counters. Completion/failure counters represent
accepted lease-owned finishes; lost/expired finishes can be unrecorded, so these are
not advertised as a complete invocation failure rate. History mode additionally retains count,
sum/max source-to-commit milliseconds and buckets `<2m`, `2m..15m`, `>15m` for newly
consumed messages with valid source timestamps. Initial backfill and expired-history
recovery do not enter latency samples. Already consumed messages, invalid/future source
timestamps and synthetic coverage records are excluded. No mail body, address, subject,
message ID, URL, secret or arbitrary error text enters this metrics table.

These are observations, not a claimed p95 or SLO pass. Last-run buckets do not establish
long-term latency distribution; retained aggregate counters do not replace source samples.
Production currently has zero enabled Gmail bindings, so no live target was certified.

## Activation and rollback dependency

Schema-first deployment and exact candidate CI/browser checks are prerequisites.
The manager controls migration/main/deployment. Drain old invocations before enabling
the flag for the deployed worker; this increment does not enable it or alter the
hourly schedule. Cron cadence/plan/quota headroom remains separately unverified.

After a binding has been fenced, simply switching the flag off is not a functional
legacy rollback: old state updates fail closed. Prefer disabling processing while
repairing the controlled worker, then resume controlled execution. Any deliberate
fence reset requires drained invocations and an explicit recovery review of cursor and
consumption evidence; no automatic downgrade/reset procedure is included.

## Verification

- Controller tests exercise claim freshness, coalescing, missing-schema fail-closed,
  lost lease, bounded aborted I/O, deferred bindings and uncertain finish.
- Real worker fixtures verify dormant metrics, new-history sample accounting, duplicate
  exclusion, and separate initial/recovery modes.
- `scripts/verify-gmail-execution-controls.mjs` runs the actual consent/control SQL in an
  isolated PostgreSQL-compatible PGlite 0.3.14 environment. It verifies table denial,
  token rejection, coalescing, expiry/takeover, stale/duplicate/disabled finish, v1/v2
  late-writer fencing, error cursor preservation and telemetry field allowlisting.
  Set `PJSDAS_PGLITE_MODULE` to a pinned isolated installation if not on the module path.
  It never contacts a production database.

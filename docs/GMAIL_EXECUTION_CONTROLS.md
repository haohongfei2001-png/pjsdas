# Gmail execution controls — deployed, default-off

Current runtime `107795acbb17dbbd17ea9e5f1963c39d39a91957` and both prerequisite
schemas are deployed. The subsequent idle-scheduler migration `20260921065934`
adds an eligibility precondition to the existing Gmail cron command while preserving
hourly cadence and Discovery. See [idle-scheduler evidence](GMAIL_IDLE_SCHEDULER.md).
These changes enable no binding, create no credential and certify no live latency. `PJSDAS_GMAIL_EXECUTION_CONTROLS` remains
default-off/unactivated; its disabled behavior uses the previous endpoint path.
See [prior intake deployment evidence](ultimate-usability-v1/evidence/UU-06-runtime-072b2fe.md).

## Controlled path

The manager applied the default-NULL consent migration (production version
`20260921053337`) and execution-controls migration (`20260921055432`). Readback
confirmed zero enabled bindings, zero expanded grants and zero execution rows.
The deployed execution-controls schema provides
an RLS-protected table with no direct anon/authenticated privileges. The existing
Vault-validated worker identity may call three bounded RPCs: begin, assert, finish.
Every empty/wrong token is rejected. There is no credential or source-scope expansion.
Legacy v1 retains its production owner/service_role-only EXECUTE ACL; this migration
explicitly revokes PUBLIC/anon/authenticated access rather than reopening the old
entry point. V2 retains its existing token-gated anon compatibility.

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

Schema-first deployment and exact-main CI/browser/deploy/self-test passed for the
initial 072b2fe increment; the later 107795a idle-scheduler evidence is linked above. The manager controls any subsequent activation. Drain old invocations before
enabling the flag for the deployed worker; this increment does not enable it or alter
the hourly schedule. The manager verified the linked Supabase organization plan as
**free** without retaining billing details. Actual usage/quota headroom and other
backend cost headroom remain unknown; the plan label does not certify capacity for
a higher cadence.

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

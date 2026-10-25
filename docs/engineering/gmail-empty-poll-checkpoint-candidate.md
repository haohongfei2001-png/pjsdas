# Default-off empty Gmail history checkpoint candidate

This is an **offline-tested candidate, not production activation approval**. It
is not a general snapshot delta API, event store, mailbox writer, or timeout
increase. The eligible production fraction and production latency benefit are
unknown. Synthetic performance numbers are not production benchmarks.

## Exact first subset

Only the controlled UU06 worker, transactional workspace, an existing backfill
boundary, complete history retrieval, zero fetched messages, zero unavailable
IDs, zero generated semantic records, no recovery/fallback/continuation, and an
unchanged numeric Gmail history cursor. Legacy polling and reconciliation cannot
choose this path. The server constructs the callback with the original claimed
user and execution token; no client/model parameter enables it. SQL independently
checks current consent, readonly scope, binding generation, cursor, absence of
continuation, lease and checked-at bounds. Lease expiry is checked again **after**
the workspace row lock. Original authority locks serialize with revocation.

The existing semantic application remains unchanged (including its snapshot
clone). The optimization avoids full snapshot upload, JSONB assignment and TOAST
rewrite only for this subset; it does not eliminate all snapshot reads/CPU. SQL
JSONPath checks of boundary and run-ID collision still detoast/read the base.
Only a definitive `NOT_ELIGIBLE` permits the existing full-write fallback. An
uncertain transport/error/malformed receipt never starts another mutation.

## Storage and logical contract

- Workspace `revision` remains the logical CAS fence; new
  `materialized_revision` marks the snapshot's physical base.
- New ledger `gmail_empty_poll_run` is dedicated server-created evidence. Generic
  full-writer provenance cannot populate it. Each successful empty poll atomically
  increments revision and adds its original command/compensation/receipt plus
  canonical run, without assigning `snapshot`.
- All run rows are retained: source health needs history, recent windows, counts,
  healthy streaks, and freshness. No replacement with a single heartbeat.
- Readers first capture snapshot + both revisions in one row response, then
  fetch immutable evidence in `(materialized_revision, observed_revision]`.
  Owner/workspace, ordering, contiguous revisions, canonical run identity and a
  maximum of 256 are checked; missing, duplicated or truncated evidence fails.
  Evidence survives materialization, so a racing full write cannot invalidate a
  captured older read window. Pending run IDs may not already exist in the base.
- Full writers atomically absorb pending evidence and advance the marker.
  Legacy v1/v2 **SQL full results** return the actual merged snapshot. Guarded
  writers compare logical preimages while retaining original admission checks.
  Historical prefix rewrites with pending evidence fail closed; drain first.
- v3/v4 cannot return a changed snapshot through their metadata-only contract:
  unaware input is rejected with `40001`. Aware input succeeds unchanged.
- With overlay reads enabled, the gateway selects the actual snapshot for
  v2/guarded RPCs and refuses a missing one. Their response may therefore be
  larger. v3/v4 and the empty checkpoint stay metadata-only. This does **not**
  promise compatibility with an old backend that projects away the SQL snapshot
  and echoes its raw input. Such old backends cannot coexist after enablement.
- 256 pending records cause `NOT_ELIGIBLE`, not truncation: the aware full-write
  fallback absorbs all 256 and retains their immutable audit rows.
- The v1 canonical source policy is frozen (10-minute cadence/20-minute SLA).
  Future default-policy changes make the current worker ineligible until a new
  contract is reviewed; they do not invalidate historical pending v1 evidence.
- FNV32 IDs retain the existing algorithm. Real collisions are detected in the
  raw base and pending records; they do not create duplicate timeline IDs.

## Exact schema and permissions delta

Migration: `20261025122330_gmail_empty_poll_checkpoint_candidate.sql`.

Two added columns, two CHECK constraints and one partial ledger index. Existing
rows initialize their marker to their existing revision. No role, table grant,
RLS policy, credential, subscription, or security-definer permission is added.

Five new functions are SECURITY INVOKER with explicit search paths. PUBLIC,
`anon`, and `authenticated` execution is revoked; only existing `service_role`
is granted execution:

1. `pjsdas_empty_gmail_run_v1(text,text,text)`
2. `pjsdas_merge_empty_gmail_runs_v1(uuid,jsonb,bigint,bigint,jsonb,boolean)`
3. `pjsdas_logical_workspace_snapshot_v1(pjsdas_workspaces)`
4. `pjsdas_drain_empty_gmail_runs_v1(uuid,bigint)`
5. `pjsdas_checkpoint_empty_gmail_poll_v1(uuid,uuid,text,text,bigint,text,text,jsonb)`

Ten existing functions have explicit full-body redefinitions, retaining their
signatures, ownership, ACLs, SECURITY mode and original guards:
`pjsdas_commit_workspace`, `_v2`, `_v3`, `pjsdas_bootstrap_workspace`, and the
planning, discovery_profile, private_reminder, opportunity, consumer_business,
and discovery `pjsdas_commit_*_workspace_v1` functions. Management v2 and AI
capture already delegate to v2; v4 already delegates to v3. No runtime source
rewriting is used.

## Deployment and rollback gates (not performed by this candidate)

Both flags default OFF. `PJSDAS_GMAIL_EMPTY_CHECKPOINT_READS` controls compatible
reads and merged-result handling. `PJSDAS_GMAIL_EMPTY_CHECKPOINTS` enables only
the controlled worker. Writer ON with reads OFF is a configuration error.

1. Obtain explicit production approval for the complete migration, replacement
   functions/ACL diff, app rollout and controlled enablement—not just one RPC.
2. With writers OFF, apply/review the additive migration and deploy compatible
   readers/writers to **every** backend process. Enable reads, verify no stale
   instances/direct raw-snapshot consumers, then separately enable the worker.
   Flags OFF works with the old schema; reads ON requires the migration. A read
   failure never silently falls back to a raw snapshot.
3. Rollback first disables checkpoint writers while retaining readers. Drain
   each pending workspace under exact expected revision, resolve conflicts by
   fresh readback, retain the maintenance outcome in the private operation log,
   verify no pending windows and no active checkpoint writers, then disable
   readers or return to an older application.
4. Drain advances **both revision and marker by one**. This is a maintenance CAS
   fence, not a fabricated Gmail run/business command; original command receipts
   are untouched. This materialized revision has no command-ledger row. Future
   overlay windows start above the new marker, so they remain contiguous.
   Repeated already-drained calls do not increment again. A lost drain response
   is resolved by marker/revision readback. The RPC returns outcome + revision.
5. This fence is essential: without it, an in-flight old raw v3 snapshot carrying
   the pre-drain revision could overwrite newly materialized audit records.
   Native tests prove such v1–v4 requests now conflict. Pending=0 alone was not a
   safe rollback proof. Retain the additive schema/new SQL functions during app
   rollback; reverting SQL definitions is a separate reviewed migration.

Immutable ledger retention is required for captured read windows and receipt
recovery. No retention/deletion job is introduced. Any future pruning requires
its own bounded reader/receipt compatibility design.

## Verification

- Unit/worker fixtures cover exact semantic-run/source-health equivalence,
  default-off old schema, writer-off/read-on rollback, strict subset rejection,
  original lease/user binding, canonical hash, definitive fallback, no duplicate
  write/cursor advance after uncertain failure, and malformed receipts.
- `node --import tsx tests/sql/gmail-empty-checkpoint.mjs` runs against a
  disposable native PG17 database. It verifies migration rollback/catalog ACLs,
  actual TypeScript store + SQL run equivalence, frozen-read absorption races,
  v1–v4 and management v2–v7/Discovery compatibility, lease/consent/CAS lock
  orderings, pending limits, ID collisions, crash rollback, drain fence and
  subsequent writes. The fake HTTP adapter in this fixture is **not** claimed
  as a real PostgREST test.
- `node --import tsx tests/sql/gmail-empty-checkpoint-http.mjs` requires Docker
  and pinned `postgrest/postgrest:v14.5`; it is wired into the existing SQL CI
  HTTP job. It covers actual HTTP role denial, small checkpoint body/receipt,
  actual store overlay/merged v2 response, lost-response recovery, HTTP rollback
  and the stale-reader drain fence. Its status must be recorded separately.
- Both require the existing isolated loopback `TA_MANAGEMENT_SQL_TEST_URL`
  fixture and synthetic credentials. No production payloads are fixtures.

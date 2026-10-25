# Metadata-only workspace commit: staged IO mitigation

Date: 2026-10-25 UTC. Production execution was explicitly approved by the owner on 2026-10-25;
execution still requires the recovery, ACL and rollout checks below.

## Finding and limits

Read-only production diagnostics found that, since the statistics reset at
2026-10-24 12:26:35 UTC, the tracked `pjsdas_commit_workspace_v2` PostgREST call
accounted for all 615,864 recorded temporary-write blocks (8,192 bytes/block).
224 calls averaged about 4,741 ms. Five of six observed query cancellations in
05:45–06:45 UTC referred to this call. Cancellation code 57014 alone does not
establish a timeout. This is not a measurement of all system IO or remaining
Supabase Disk IO budget.

The caller already projects outcome/workspace_id/revision/receipt. Nevertheless,
the v2 PL/pgSQL set-returning function includes the full JSONB snapshot in each
`RETURN NEXT`. PostgreSQL materializes that result before the external projection,
and a large fresh input spills above `work_mem` (observed setting: 2,184 kB).
Replay/conflict can retain a compressed stored TOAST representation and do not
necessarily spill; do not infer identical IO costs for all three outcomes.
See [PostgreSQL 17 control structures](https://www.postgresql.org/docs/17/plpgsql-control-structures.html#PLPGSQL-STATEMENTS-RETURNING).
This is a concrete avoidable spill mechanism, not proof that all platform IO is
caused by this one operation.

## Change and controlled rollout

- Add `pjsdas_commit_workspace_v3` with the same 13 input arguments and mutation,
  CAS, idempotency, receipt, and row-lock behavior, but only four metadata output
  columns. It does not call v2. Existing v2 and guarded wrappers remain unchanged.
- The new function is SECURITY DEFINER with fixed search_path; revoke PUBLIC,
  anon, authenticated execution and grant only existing service_role. This is a
  **new persistent privileged entrypoint** and requires explicit migration/ACL
  review before production execution. No new role/table/RLS policy is created.
- Client selection is staged OFF by default. Only set
  `PJSDAS_WORKSPACE_COMMIT_METADATA_ONLY=1` after the approved migration and exact
  ACL/read-only function checks. Management, discovery and AI confirmation keep
  their current guarded RPCs regardless of this switch.
- No automatic v2 fallback on v3 errors: an uncertain response must never trigger
  another write. Existing readback handles conflict/replay; first COMMITTED uses
  the already submitted snapshot.
- Turning the switch off returns the client to the unchanged v2. No snapshot
  restore, data rewrite, work_mem increase, service pause or paid upgrade is needed.

## Verification gates

The new isolated fixture compares all three outcomes, hash-reuse rejection,
permissions and original v2 compatibility; its PostgreSQL 17 mode uses synthetic
large snapshots and EXPLAIN ANALYZE/BUFFERS to compare spill. It runs in the
existing PostgreSQL CI service, not a new resource or production database.

Local PostgreSQL 17 initialized, but Unix socket creation was denied. The normal
escalation path also failed at sandbox setup; no restriction was bypassed.
Therefore native local spill measurements are unavailable. Remote PostgreSQL results supply the native evidence below.

## Native PostgreSQL evidence

Exact head `ff6b10e3`, [SQL CI run 40171288302](https://github.com/haohongfei2001-png/pjsdas/actions/runs/40171288302), passed on PostgreSQL 17.
For the same approximately 25 MB synthetic JSONB with `work_mem=2184kB`:

| Outcome | v2 temporary read/write blocks | v3 temporary read/write blocks |
| --- | ---: | ---: |
| COMMITTED | 3296 / 3296 | 0 / 0 |
| ALREADY_APPLIED | 0 / 0 | 0 / 0 |
| CONFLICT | 0 / 0 | 0 / 0 |

First-commit execution was 151.66 ms vs 114.099 ms in this one synthetic
measurement, not a production speed guarantee. The first fixture incorrectly
required all v2 paths to spill; actual replay evidence corrected that assumption.
Native lock/CAS, receipt replay and ACL checks also passed.

## Recovery scope and execution gate

This candidate only adds one function and its execution ACL; it does not invoke
that function, alter existing tables/functions/policies, or migrate business rows.
Capture the existing v2 definition/ACL and relevant catalog preimage privately,
prove v3 absent and the expected base definition unchanged before installation,
and verify the same originals after installation. The isolated SQL fixture also
rolls back installation in an explicit transaction and verifies v3 is absent and
the original catalogs unchanged. This is scoped DDL recovery, **not** evidence of
a fresh full-production snapshot backup or disaster-recovery restore.

Use bounded, atomic installation and retain v2. Operational rollback turns the
client switch OFF; leave the new unused function installed rather than restore a
whole workspace or delete data. A schema removal, if separately needed, must
first prove no callers/dependencies and use the saved exact preimage; do not
issue a broad restore or CASCADE. Never upload production backup data to CI.

At this evidence checkpoint, production remains unchanged, migration unapplied
and the client switch OFF. Record later execution separately from these tests.

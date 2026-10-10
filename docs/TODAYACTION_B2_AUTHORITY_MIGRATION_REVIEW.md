# B2 Discovery authority boundary

This is a migration candidate, not a production execution record. B2 acceptance still requires the actual query/source/command/readback chain and a subsequent scheduled run.

## Exact access changes

- Existing `pjsdas_authorization_grants` gains an immutable UUID and an update revision. Existing owner/client/source/capability keys and current granted/revoked values remain unchanged. No grant is inserted by the migration.
- Existing `google_drive_connections` gains a Discovery consent generation. Only opt-in, revocation or Google subject changes rotate it. Ordinary telemetry and same-subject credential rotation preserve it. The migration does not enable automation.
- No table ACL, RLS policy, capability, account, credential or source-reading permission changes.
- Two new functions are executable only by the existing `service_role`: the versioned Discovery claim projection and the protected Discovery commit. New trigger functions revoke public/anonymous/authenticated execution. No new anonymous endpoint is granted.
- The claim projection retains the existing worker-token validation and opt-in filtering. Its extra output is consent-generation metadata. Existing v1 callers remain compatible.
- The commit function locks the original consent or source-scoped delegated grant, then invokes the existing `pjsdas_commit_workspace_v2` within the same transaction. It does not introduce another snapshot writer or ledger. Receipt authorization metadata comes from the locked row.

## Ordering and compatibility

Apply the reviewed additive migration before the matching application deploy. The new application fails closed if its guard RPC, admission proof or existing backend authorization is unavailable; it never retries through the unguarded RPC. A paused/revoked/replaced authority cannot be replaced during a CAS retry.

Existing grant/connection rows receive metadata only. Historical workspace snapshots, profile notes, source records, Undo compensation and original command receipts are not migrated or rewritten. Old clients ignore the additive fields. The service-only claim requires the already configured backend credential; this change does not provision one.

The single-backend SQL fixture verifies unchanged table ACL/RLS, preserved existing state, exact owner/client/source checks, pause/resume and revoke/regrant generations, ledger replay, CAS, and denial without a valid proof. The separate PostgreSQL fixture uses four real sessions for writer-first, revoke-first and active-again ABA ordering. Both are part of the existing SQL gate. A local PGlite pass alone does not certify lock contention.

## Rollback

Prefer rolling back the UI while retaining a backend that enforces this guard. An older backend can still call its old SnapshotWrite/v2 route: leaving the additive SQL installed alone does not protect that route. Before any backend rollback, suspend both scheduler Discovery writes and delegated Discovery ingestion through the existing deployment controls, or retain the guard-capable backend. Scheduler opt-in alone is not a switch for delegated MCP ingestion.

Leave the additive authorization metadata and functions installed. This preserves grant generations, revocation history and original receipts, and avoids destructive schema rollback. No rollback step deletes jobs, user preferences, grant rows or ledger entries. Verify Discovery writes remain suspended before declaring an older backend rollback safe; this document does not claim a production pause has occurred.

Before production migration, review exact candidate permissions and verify the existing service role already has its normal connection/grant table permissions. Missing permissions must fail closed; do not add table privileges or credentials as an automatic repair. Production activation and any access expansion require their applicable authorization review.

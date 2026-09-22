# CGR-01 — Authoritative Command Foundation

State: **READY — NOT_STARTED**

## User-visible outcome

Normal connected Web changes save through typed authoritative server commands. Retries, account switching, conflicts and safe Undo no longer behave as whole-workspace synchronization problems.

## Scope

- Inventory all daily connected mutation/snapshot callers.
- Implement typed server commands for ordinary mutation families.
- Server-side authorization/domain execution with durable structured receipts.
- Idempotent recovery when commit outcome is unknown.
- Account-scoped cache/drafts/pending operations.
- Object-aware conflict handling and dependency-aware Undo.
- Command lifecycle observability.

## Non-goals

- No whole database/service rewrite.
- No broad UI redesign beyond status/error surfaces needed to prove the foundation.
- No source/model expansion beyond command proof.
- No native iPhone/UU-08/external action authority.

## Preserved invariants

- Opportunity / Process / Action / Prep semantics remain authoritative.
- ScheduleNode occurrence/version identity and temporal precision remain authoritative.
- Deterministic Decision Rules/ranking remain single-source domain logic.
- Semantic Intake policy, DecisionRequest, provenance and source authorization are not bypassed.
- Supabase transactional workspace remains connected-mode authority.
- CAS, command ledger, receipts, idempotency and exact-SHA/security gates remain mandatory.
- No external application/withdrawal/email/Offer authority is added.

## Architecture changes

- Client command → authoritative server execution → transaction → receipt → projection.
- CAS remains final guard but not the only product conflict model.
- IndexedDB becomes account-scoped client infrastructure.
- Snapshot replacement is limited to named import/migration/recovery compatibility.

## Migration

- Introduce commands compatibly; map and migrate caller-by-caller.
- Shadow/compare where safe.
- Preserve stable identities/history; no bulk workspace rewrite.

## Legacy retirement

- Retire ordinary daily whole-snapshot mutation callers after command proof.
- Document every remaining snapshot caller and bounded purpose.

## Required tests

- Command/domain/authorization goldens.
- Lost-response receipt recovery and replay idempotency.
- Concurrent unrelated commands both survive; same-object conflict fails safely.
- Account switch/cache isolation.
- Undo after unrelated revision succeeds; dependent Undo fails safely.
- Stale snapshot cannot erase newer fields.

## Continuous real-user journeys

- Complete/reschedule/resolve through real server command and verify projection.
- Server commits but response drops; recover without duplicate.
- Another source changes unrelated opportunity; user command still succeeds.
- Switch accounts without prior-account render/upload.
- Undo after unrelated later mutation.

## Visual / responsive evidence

- Truthful pending/success/outcome-unknown/conflict/account/Undo states on wide and narrow layouts; no new full UI generation.

## Production evidence

- Exact-SHA bounded production command canary using safe/reversible data; existing security/deploy gates green; no publication.

## Failure / degraded scenarios

- Offline.
- Timeout after commit.
- Expired session.
- Unrelated revision.
- Same-object conflict.
- Duplicate replay.
- Restart with pending command.
- Unauthorized command.

## Rollback

- Disable new caller/fall back to last compatible authoritative server path without stale snapshot restore.
- Compensate test mutations and preserve ledger/receipts.

## Exact exit criteria

- All ordinary connected Web daily mutation families in scope use authoritative commands.
- No normal success UI before authoritative receipt.
- Outcome-unknown recovery is idempotent.
- Account-scoped cache/pending behavior proven.
- Object-aware conflict/Undo journeys pass.
- Remaining snapshot paths explicitly bounded.
- Exact-SHA production evidence proves the real command boundary.
- Completion report leads with user-visible reliability improvement.

## Owner decision points

- Stop only for irreversible data/permission, new cost/privacy boundary, protected external authority or materially different product policy. Command/cache/library choices are delegated.

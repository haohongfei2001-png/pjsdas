# CGR-00 — Contract & Scope Freeze

State: **COMPLETE — DESIGN REGISTERED**

## User-visible outcome

No runtime change. The package creates a finite outcome-driven forward contract and prevents accidental UU-08 continuation.

## Scope

- Register all canonical CGR files and six phase contracts.
- Freeze product responsibility, target experience, technical architecture, validation, migration and retirement.
- Pause UU-08/09 execution order while preserving completed UU history.
- Record exact remote-main registration baseline.

## Non-goals

- No runtime/schema/config/permission/automation/real-data mutation.
- No UI/component/native implementation.
- No release publication.

## Preserved invariants

- Opportunity / Process / Action / Prep semantics remain authoritative.
- ScheduleNode occurrence/version identity and temporal precision remain authoritative.
- Deterministic Decision Rules/ranking remain single-source domain logic.
- Semantic Intake policy, DecisionRequest, provenance and source authorization are not bypassed.
- Supabase transactional workspace remains connected-mode authority.
- CAS, command ledger, receipts, idempotency and exact-SHA/security gates remain mandatory.
- No external application/withdrawal/email/Offer authority is added.

## Architecture changes

- Documentation only; no runtime architecture change.

## Migration

- None; later migration rules are registered only.

## Legacy retirement

- None; classify/freeze future retirement conditions only.

## Required tests

- Changed-file set must be docs only.
- All requested canonical files and CGR-00..05 exist.
- Old UU status prevents automatic UU-08/09.
- CGR status ends CGR-01 READY — NOT_STARTED with no authorization.

## Continuous real-user journeys

- A future executor reading remote main + STATUS can identify CGR-01 as the only possible next phase and still must stop without a new instruction.

## Visual / responsive evidence

- Freeze reference requirements only; no disposable prototype is required or accepted as runtime evidence.

## Production evidence

- Repository/main registration evidence only; no deploy/release proves product capability in this phase.

## Failure / degraded scenarios

- If remote main moves during registration, re-read/rebase without overwriting newer work.
- If any runtime/config/schema/data file would change, abort.

## Rollback

- Docs-only revert; never touch production runtime/data.

## Exact exit criteria

- All canonical files are on remote main.
- UU-00..07 history preserved; UU-08/09 paused.
- No runtime/config/schema/permission/data file changed.
- CGR-00 COMPLETE; CGR-01 READY — NOT_STARTED; later phases blocked.
- Remote main and both STATUS files are re-read after merge.

## Owner decision points

- No further owner decision beyond this registration authorization.

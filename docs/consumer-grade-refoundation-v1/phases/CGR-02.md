# CGR-02 — Today Vertical Slice

State: **BLOCKED — NOT_STARTED**

## User-visible outcome

The user can go Today → Tell PJSDAS → see exact understanding → authoritative save → UI projection → second active client → safe Undo in one production-grade flow.

## Scope

- Final-direction App shell/router/session boundaries for the slice.
- Production Today composition.
- Final-direction tokens/accessibility primitives used by the slice.
- Contextual Tell PJSDAS and per-item interpretation/save feedback.
- Projection without app remount.
- Measured active-client revision/change mechanism.
- Loading/offline/pending/conflict/Undo UX.

## Non-goals

- Do not migrate all other surfaces yet.
- Component library alone cannot close phase.
- No AppV9 + anotherPolish layering.
- No native iPhone.

## Preserved invariants

- Opportunity / Process / Action / Prep semantics remain authoritative.
- ScheduleNode occurrence/version identity and temporal precision remain authoritative.
- Deterministic Decision Rules/ranking remain single-source domain logic.
- Semantic Intake policy, DecisionRequest, provenance and source authorization are not bypassed.
- Supabase transactional workspace remains connected-mode authority.
- CAS, command ledger, receipts, idempotency and exact-SHA/security gates remain mandatory.
- No external application/withdrawal/email/Offer authority is added.

## Architecture changes

- SessionBoundary/router/query cache/command client become production boundaries.
- Today consumes canonical read/domain truth.
- New UI owns one isolated token/primitives system.

## Migration

- Run slice on real production contracts.
- Migrate Tell PJSDAS slice to CGR-01 command path.
- Preserve stable routes/object identities for later migration.

## Legacy retirement

- Remove old Today state/UI/CSS/write code once unused.
- Name temporary adapters and CGR-03 retirement conditions.

## Required tests

- Real browser client→server→receipt→projection E2E.
- Cross-client propagation timing.
- Draft/context preservation during refresh.
- Undo/outcome-unknown recovery.
- Keyboard/focus/accessibility.
- Visual regression across Today states.

## Continuous real-user journeys

- Canonical full Today/Tell/save/project/cross-client/Undo.
- Same journey with unrelated second-client mutation.
- Offline pending then exact-once reconnect.
- Ambiguity creates DecisionRequest.
- Future fixed event stays protected and is not a premature primary action.

## Visual / responsive evidence

- Reviewed wide Mac, phone-class and intermediate references.
- Dense/long-title fixtures, large text/zoom, safe area, soft keyboard, no overflow/occlusion.
- Review hierarchy/typography/density/state clarity, not only pixel stability.

## Production evidence

- Exact-SHA todayaction.com canary.
- Healthy active-client propagation p95 <= 5s in defined environment.
- Existing gates + slice journey green; publication remains disarmed.

## Failure / degraded scenarios

- Initial load/cache refresh.
- Offline.
- No interpretation candidate.
- Business ambiguity.
- Unknown commit outcome.
- Session expiry.
- Same-object conflict.
- Delayed/lost client notification.

## Rollback

- Surface may roll back only without stale data or unsafe mutation authority.
- Commands/receipts remain truth and new ledger/history is preserved.

## Exact exit criteria

- Complete canonical journey passes in production architecture.
- Save state truthful in success/pending/unknown cases.
- Visual/responsive/accessibility evidence passes.
- Shell/primitives are production foundations, not disposable prototype.
- No AppV9/anotherPolish pattern.
- Migrated legacy Today path retired or explicitly bounded.

## Owner decision points

- Only genuinely different product composition with no objective winner or new cost/privacy/permission boundary. Pixel/component decisions are delegated.

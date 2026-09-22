# CGR-03 — Opportunity Workspace

State: **BLOCKED — NOT_STARTED**

## User-visible outcome

Today, Opportunities, Detail, Decisions, Prep context and Settings become one coherent production workspace with consistent navigation, saves, visual language and failure behavior; obsolete daily layers are removed.

## Scope

- Migrate Opportunities list.
- Migrate Detail with identity/state/next node/action/judgment/full history/prep/provenance.
- Contextual Decisions.
- Prep in opportunity context.
- Settings around account/connections/reminders/preferences/data/privacy/support.
- Preserve filters/selection/scroll and dense performance.

## Non-goals

- No broad new recruiting features.
- No new permissions/native app.
- No domain redesign for view shortcuts.
- No indefinite old/new parallel UI.

## Preserved invariants

- Opportunity / Process / Action / Prep semantics remain authoritative.
- ScheduleNode occurrence/version identity and temporal precision remain authoritative.
- Deterministic Decision Rules/ranking remain single-source domain logic.
- Semantic Intake policy, DecisionRequest, provenance and source authorization are not bypassed.
- Supabase transactional workspace remains connected-mode authority.
- CAS, command ledger, receipts, idempotency and exact-SHA/security gates remain mandatory.
- No external application/withdrawal/email/Offer authority is added.

## Architecture changes

- All daily surfaces use CGR shell/query/command/primitives.
- List/detail use shared domain read models.
- Settings reports capability/freshness, not storage topology.

## Migration

- One complete surface family at a time.
- Keep semantic routes/object identities/history/provenance.

## Legacy retirement

- Delete old UI/CSS/daily mutation entrypoints after zero-consumer proof.
- Remove obsolete authority/conflict wording.
- No dormant normal V-generation app path.

## Required tests

- Dense list/search/filter/navigation.
- List/detail semantic consistency.
- Full-history behavior.
- Decision resolution.
- Prep context.
- Settings freshness/session.
- Visual/accessibility regressions.

## Continuous real-user journeys

- Find role in hundreds-opportunity workspace, inspect/act/return with state preserved.
- Correct/reschedule schedule node and verify Today/list/detail consistency.
- Resolve same-company ambiguity and return context.
- Open prep and return without losing state.
- Recover source authorization problem from Settings.

## Visual / responsive evidence

- Empty/normal/dense Opportunities, detail, decisions, prep, settings and degraded states.
- Wide/narrow, long bilingual, large text, keyboard.
- No legacy CSS bleed.

## Production evidence

- Exact-SHA canary across migrated daily surfaces.
- Dense-workspace performance/interaction evidence.
- Existing gates green; publication disarmed.

## Failure / degraded scenarios

- Dense data.
- Stale/partial read model.
- History load failure.
- Session expiry mid-action.
- Decision expiry.
- Source freshness stale.
- Back/refresh/direct link.

## Rollback

- May use last compatible read UI while preserving authoritative command/data semantics.
- Never resurrect whole-snapshot normal mutation.

## Exact exit criteria

- All named surfaces use CGR architecture.
- Dense journeys pass.
- Today/list/detail conclusions consistent.
- Normal Settings hides storage-authority complexity.
- Migrated legacy UI/CSS/write paths deleted or explicitly bounded.
- Visual/responsive/accessibility covers full daily workspace.

## Owner decision points

- Only product-direction, new permission/cost/privacy or irreversible data changes. Ordinary layout/migration choices delegated.

# CGR-04 — Natural Intake & Automation Closure

State: IN_PROGRESS — BOUNDED ENGINEERING OVERLAP; CGR-03 PRODUCTION_PENDING_EXTERNAL

## User-visible outcome

PJSDAS can accept ordinary recruiting updates from Web, Gmail, PAIA/current-chat, and other already authorized owner sources through one coherent interpretation and feedback model.

The user can tell whether a source is healthy, whether content was understood, whether a true business ambiguity remains, and whether a limitation is a normal capability boundary.

A capability is not complete merely because an adapter, flag, poll, tool, or unsupported fallback exists.

## Scope

- unify contextual interpretation across Web, Gmail, and PAIA/current-chat;
- strengthen natural-language/entity/occurrence interpretation where current rule-only handling is insufficient;
- preserve deterministic policy/authorization after interpretation;
- carry useful context without conflating quoted/hypothetical text with current assertions;
- classify source outcomes into transport health, interpretation failure, business ambiguity/conflict, and normal capability boundary;
- improve user feedback and recovery;
- verify promised source capabilities end-to-end;
- preserve Gmail cursor/lease/replay/continuation;
- add observability for received -> interpreted -> committed -> projected -> delivered where applicable;
- close or truthfully scope reminder/external delivery promises represented in active product surfaces.

## Non-goals

- no new external recruiting action authority;
- no arbitrary link/attachment browsing unless explicitly accepted within privacy boundaries;
- no automatic permission expansion;
- no new paid model/service without owner approval;
- no unrelated source for feature-count optics;
- no iPhone implementation.

## Preserved invariants

Semantic Intake policy kernel, source authorization, statement-mode safety, stable identity resolution, DecisionRequest, transaction/idempotency/provenance, Gmail transport cursor/lease/replay, and all external-action limits.

## Architecture changes

All natural-language sources converge on the shared interpretation pipeline in TECHNICAL_ARCHITECTURE.md.

Interpretation may use stronger model-assisted, deterministic, or hybrid methods. Final business authorization, temporal precision, object existence, idempotency, and mutation remain deterministic/server authoritative.

Source capability status becomes a user-impact read model, not a single aggregate unresolved counter.

## Migration

Run new interpretation in shadow on synthetic/redacted replay before changing autonomous commit coverage.

For each source/event class:

1. compare old/new interpretation;
2. measure coverage and unsafe-write risk;
3. keep policy authority unchanged;
4. enable new interpretation for the authorized class;
5. monitor production canary;
6. retire obsolete source-specific interpretation branches.

## Legacy retirement

- retire redundant Web/Gmail/PAIA parsing paths once shared interpretation covers them;
- delete capability flags/status wording that imply end-to-end completion without evidence;
- retire aggregate unresolved classifications that mix normal capability boundaries with actionable failure;
- remove dormant user-facing promises intentionally not supported, or complete them truthfully if already part of frozen product responsibility.

## Required tests

Questions/quotes/examples/hypotheticals remain no-write; mixed current statement + quoted thread; same-company/multi-role ambiguity; multiple occurrences; date-only vs exact-time preservation; reschedule supersession; replay/idempotency; Gmail continuation/cursor/lease; PAIA/current-chat source identity and authorization; partial interpretation; unsupported attachment/link boundary classification; model/parser failure; hallucination resistance/fail-closed business validation; source status taxonomy; and user feedback for each outcome class.

## Continuous real-user journeys

1. Web free-form statement updates the correct opportunity/occurrence and reports the exact result.
2. Gmail reschedule message containing quoted old thread updates one existing occurrence, preserves history, and does not duplicate old time.
3. Ambiguous Gmail/current-chat statement produces one concrete DecisionRequest rather than a guessed update.
4. A source poll succeeds but interpretation fails, and the UI reports interpretation failure rather than healthy completion.
5. A normal unsupported boundary is explained without adding a permanent actionable error count.
6. The same fact arriving from two authorized sources deduplicates without losing provenance.
7. PAIA/current-chat authorized owner input reaches the same command/read-model/receipt path as Web.

## Visual / responsive evidence

Tell PJSDAS mixed-result feedback, source health vs interpretation issue vs decision vs capability-boundary states, recovery actions, dense exception state where needed, desktop/narrow/large-text layouts, and keyboard/screen-reader semantics for decisions/recovery.

## Production evidence

For every source described as active to the user, show real production transport, interpretation outcome, authoritative commit/DecisionRequest, UI projection, dedupe/replay, and recovery evidence.

If a user-facing promise includes external reminder delivery, at least one actual authorized delivery path must be proven. Unsupported or a capability flag cannot substitute for delivery.

## Failure / degraded scenarios

OAuth/source revocation, delayed scheduler, partial retrieval, attachment/link outside capability, parser/model unavailable, low-confidence interpretation, same fact from multiple sources, stale source version, duplicate replay, downstream command failure, and external delivery failure where applicable.

## Rollback

Use per-source/per-event interpreter kill switches. Continue safe observation intake where possible. Fall back to prior safe interpretation or DecisionRequest/read-only handling without weakening authorization. Preserve evidence and cursor state.

## Exact exit criteria

- active promised sources share one interpretation/policy/command architecture;
- transport health and interpretation completeness are separately visible/observable;
- normal capability boundaries are not counted as unresolved business failures;
- critical real journeys pass without guessed writes;
- dedupe/provenance remain intact;
- user-facing capability claims match production evidence;
- obsolete source-specific interpretation/status paths are retired;
- required production canaries pass;
- no new privacy/cost/permission boundary was crossed without owner approval;
- STATUS.md marks CGR-04 COMPLETE and CGR-05 READY, without starting CGR-05.

## Owner decision points

Required before adopting a new paid model/service, sending raw private content to a new processor, expanding OAuth/source permissions, enabling external consequential actions, or materially expanding collected Gmail/link/attachment content. Ordinary parser/model orchestration under existing approved boundaries is delegated.

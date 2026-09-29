# TodayAction Owner UX Recovery / Decision Debt Quarantine

Bounded follow-up started 2026-09-29 from remote `main@e9a9c3f0971a1909b60f79604e0020f24e603068`.
This is a new product-semantics repair, not a reopening of a PCR package.
One writer owns the code branch. No production workspace write, Gmail cursor edit,
IndexedDB clear, or paid-plan change is part of verification.

## Observed production aggregate

Read-only SQL on the single authoritative workspace confirmed 363 open
`DecisionRequest` rows, all sourced from Gmail: 173
`missing_required_field`, 117 `ambiguous_target`, 69 `low_confidence`,
and 4 `ambiguous_occurrence`. All 117 target-ambiguity candidates lacked
company/role text in their bound candidate. These counts are a point-in-time
readback; normal Gmail automation can advance the workspace revision.
The owner reported six actual Today tasks and a persistent local/authoritative
warning. The latter cannot be assigned a subtype from the server aggregate.

## Product rule

A visible decision must have a current source, a specific existing business
target, 2–4 distinguishable choices, and at least one choice that can change
bounded internal business state. Missing facts and low-confidence Gmail parser
output remain ingestion/coverage debt. Ambiguity is offered only when all
credible targets fit the choices and selecting one can finish the operation.
Existing requests, receipts, source ledger entries, and timeline provenance
are retained. Exact replay groups retain each original request identity.

Today uses only this actionable read model. Historical Gmail debt is reachable
through Settings → History & audit → Historical review / Data quality, then a
collapsed summary in Decisions. It is not a Today task or bulk CTA.

Gmail's producer now retains a common company/role anchor for credible
multi-target mail, suppresses unanswerable requests, records interpretation
failure in the source ledger, and keeps exact source/candidate/reason replay
idempotent. A selected target raises only object confidence; event and time
uncertainty remain guarded.

## Divergence rule

The connected sync path compares local checkpoint, local projection, remote
fingerprint, pending command count, and the IndexedDB projection journal.
Differences are classified as equal, order only, derived cache metadata,
server-only historical ingestion evidence, pending operations, or unproven.
Only a fresh equivalence proof with zero pending operations can reconcile the
local cache. The recovery probe cannot create or push a remote workspace.
Settings exposes the read-only classification and keeps both copies when
equivalence is not proven. The current owner Chrome profile requires an
in-profile readback to identify its actual subtype; server SQL alone cannot
prove the local state.

## Gates

- Unit/build: full suite, TypeScript and production build.
- Browser: owner-like dense IndexedDB journey, current decision choices,
  warning deduplication, and preserved history on reload.
- Matrix: Chromium, mobile Chromium, WebKit and Firefox where the runner is
  available; record environment failures without treating them as a pass.
- Independent review, PR-head CI/Browser, and merged exact-main checks before
  calling the follow-up complete.

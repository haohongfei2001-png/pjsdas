# TodayAction Post-Closure Reliability v1 — Canonical Status

Package: `TODAYACTION-POST-CLOSURE-RELIABILITY-v1`

Status: **CLOSURE_CANDIDATE — COMPLETE_WITH_UNRESOLVED after final documentation gates**

Baseline: `main@c93a0fca9ef9b8eec8e234557f525445c0ef6b20`

Historical boundaries:
- Consumer-Grade Refoundation v1 remains **COMPLETE — STABLE CONSUMER-GRADE BASELINE**.
- UU-08 / UU-09 remain **HOLD — NOT_AUTHORIZED**.
- Release publication remains disarmed/separate.
- Existing Reliability Closure and Active-Unresolved packages retain their own
  historical receipts and truth; this package does not rewrite them.

Current phase: **PCR-07 — bounded closure and final receipt**

Current writer: **reliability/pcr07-bounded-closure-v1**

Production claim: **P0 verified on exact runtime a8d9840; Repair 02 committed 38 settlements once (CAS 841 → 842), readback 843, read-only idempotency 0. No further production write authorized.**

## Phase queue

| Phase | State | Purpose |
| --- | --- | --- |
| PCR-01 | COMPLETE | exact-main closure of merged PR #185 history/startup P0 and any already-authorized bounded follow-through |
| PCR-02 | COMPLETE | PR #188 recovery slice merged; exact-main d19 CI/Browser/Matrix/Pages/Self-Test and deployed readonly startup verified; late-read race tracked in PCR-05 |
| PCR-03 | COMPLETE | PR #189 merged6c77d62; exact-main CI/Browser/Matrix/Pages/Self-Test plus7 deployed readonly startup checks PASS |
| PCR-04 | COMPLETE_BOUNDED | PR190 read model and PR191 narrow procedural assertion repair exact-main verified; ambiguous historical records preserved |
| PCR-05 | COMPLETE | PR192 exact main85e2 CI/Browser/Matrix/Pages/Self-Test, deployed startup and isolated cache convergence PASS |
| PCR-06 | COMPLETE | fresh readonly revision934 confirms classes and reference integrity; permanent regression mappings recorded |
| PCR-07 | CLOSURE_CANDIDATE | final documentation gates/review/main verification required |

## Authorization boundary

The owner authorizes the complete PCR-01..07 engineering queue to continue
without repeated approval for ordinary code, tests, CI, review fixes, browser
verification and documentation.

This authorization does **not** authorize:
- new permissions or OAuth scopes;
- new paid services/commitments;
- release publication;
- external recruiting actions;
- destructive production/history/cursor rewrites;
- arbitrary private workspace mutation;
- a new product direction, UU-08/09, native iPhone implementation or another CGR.

If a phase reaches only an external/owner/prohibited gate, record it as deferred
and continue to the next dependency-safe phase. Do not falsely mark the gate PASS.

## PCR-01 closure evidence

- P0 final-head 4046223 / merge c93, exact-main CI/Browser/Matrix/Pages/Self-Test
  and real deployed startup probe passed. Docs-only a8 has fresh applicable gates
  and frontend/backend identity; Matrix/VoiceOver evidence is inherited from the
  identical runtime source.
- [P0 receipt](../todayaction-active-unresolved-reduction-v1/P0-HISTORY-STARTUP-RECEIPT.md).
- [Repair 02 receipt](../todayaction-active-unresolved-reduction-v1/REPAIR-02-PRODUCTION-SETTLEMENT-RECEIPT.md):
  baseline1374 60/60, parser45/15, exact38ignored, revision841 unchanged;
  write1375 oneattempt841→842; readback843 retains all3747priorrows; idempotency1377
  22/22, parser7/15, zero settlement, revision843 unchanged.
- Production remains 163 active unresolved at that readback; protected/parser-gap
  records were not cleared. This is bounded repair completion, not zero debt.
- Existing one-write authorization is **consumed**. PCR-02..07 grants engineering
  and read-only verification only.

## PCR-02 verified evidence

[Recovery audit](PCR-02-RECOVERY-AUDIT.md): PR #188 final head c85781a, latest
Codex clean review 5874738441; merged main d19e5b5236d24f9f04f1ce6ad8cc901ddcd3fcac.
Exact-main CI 36455446215, Browser 36455446172, Matrix 36455446248, Pages
36455446488, Self-Test 36455651129, Brand 36455651080 and Live Visual
36455651021 all SUCCESS. Health 1384 returned exact d19. Actual deployed bundle
with complete readonly revision-847 snapshot passed seven route/reload/restart
cases, zero errors and zero network writes. Normal Gmail advanced revision to 848;
Repair 02 settlement command count remains exactly one. No further write allowed.

The valid first-head Codex P2 duplicate clear was repaired and its thread resolved.
Seven recovery regressions and the existing P0 suite pass. The distinct late
account-read revival defect remains PCR-05 work; this phase closure does not
claim that it is fixed or that the entire package is complete.

## PCR-03 candidate evidence

[History Undo audit](PCR-03-HISTORY-UNDO-AUDIT.md): six new domain regressions
failed against the verified base. Generic Undo previously reopened prior completed
and elapsed nodes and lost an in-progress prior state. New command compensation
records its exact changed occurrences; generic status changes preserve historical
terminal facts. Local Undo validates and writes under one IndexedDB transaction;
connected/MCP paths preserve exact compensation and existing CAS dependency checks.
Eleven real browser regressions pass, including subsequent-edit refusal and durable
Today/Schedule/job-detail reload/restart. Unit 205 files / 996 tests, type and build
pass; full remote gates/latest Codex/exact-main verification remain required.
PCR-04..07 are still pending. No production data mutation is authorized.

PCR-03 further audit reproduced local deletion of a history-backed event committing
invalid durable references. Three new regressions fail on the initial candidate.
Local/connected deletion now refuses completed or elapsed history before any
workspace write; snapshot validation is unchanged. Future-event deletion remains
available. Delete Undo restores only changed nodes and every removed action,
retaining unaffected superseded evidence and rejecting later edits. Full gates and
review must be refreshed for the final repaired head.

The required reimport audit also reproduced removal of elapsed legacy evidence
and retention of a completed node with a missing process reference. Two retention
regressions and a valid-fixture reference regression fail before the repair.
Reimport now preserves effective elapsed history and validates the complete
proposed snapshot inside the existing atomic transaction before replacement.
Invalid proposals abort with raw stores unchanged. Latest head gates/review must
be refreshed; no additional production workspace write is permitted.


## PCR-03 exact-main closure

PR #189 final02c83ce independently reviewed with fresh context; complete receipt
PRcomment5876707647, no actionable P1/P2. Merge6c77d6289851f28a2981c72df57b6fedf6d40f40:
CI36470718351, Browser36470718228, Matrix36470718175, Pages36470718161,
Production Self-Test36470940662 all PASS. Actual deployed bundle manifest exact6c77;
readonly full prior production snapshot847: Today/Schedule/Library navigation,
reload and fresh-page restart7/7 PASS, zero page errors and zero write requests.
No production mutation performed. Snapshot data are private and not committed.

## Owner dense-account correctness (not yet production fixed)

Readonly current860 retains384actions/358decisions. Private851 classification
established6selectedactions plus358open decisions; current read-model candidate
projects6actions/0today decisions,344exact replay groups retaining358records, and
no past floating-date node in upcoming. Full inbox remains available. Parser
instruction-fragment amplification and account cache order/late-read race remain
explicit follow-on defects; this slice does not claim their resolution.

## PCR-04 read-model verified; parser follow-through active

PR190 merged c364af0e40682b52d7d26d51fc1e7b6dad282c3c after all seven head
gates and fresh independent review5877608040. Exact-main CI36478992590,
Browser36478992621, Matrix36478992612, Pages36478992574 and Self-Test36479209703
passed. Health1419 and deployed manifest match exact main. Actual deployed
readonly snapshot847 passes seven startup/reload/restart checks, six Today rows,
zero generic decision rows and358/358durable decisions retained. Receipt5878108183.

[Parser follow-through](PCR-04-GMAIL-ASSERTIONS.md) remains a bounded candidate.
PCR05 cache ordering and account read races, PCR06 and PCR07 are still pending.


## PCR-04 parser exact-main verification

PR191 final9af087e clean independent source review5878948382; merged
5d9e52fff0f22f8bc44435ddf398060ccf0c9b65. Exact-main CI36485927929,
Browser36485927916, Matrix36485927988, Pages36485927924 and Self-Test36486141368
PASS. Health1430 matches exact main. Deployed readonly startup7/7PASS, six Today
rows, zero generic decision rows, 358/358 raw/durable requests retained.
Closure5879255951. Narrow complete procedural grammar preserves unknown/mixed
assertions; historical ambiguous requests are not automatically reprocessed.

## PCR-05 candidate

[Cache convergence and races](PCR-05-CACHE-CONVERGENCE.md). Private prior/current
snapshot equivalence now succeeds across real IndexedDB ordering while content
changes remain conflicts. Real account sign-out, late commands, overlapping reads,
local edits and partial transaction failure are covered. No production mutation.
Full latest-head gates, independent review and exact-main production verification
remain required; PCR06/PCR07 are not complete.

## Latest PCR05–07 evidence (supersedes candidate notes above)

PR192 merged85e2f568; clean source review5880288013; exact-main closure
[receipt5884480345](https://github.com/haohongfei2001-png/pjsdas/pull/192#issuecomment-5884480345).
Seven deployed startup checks and isolated847→851 cache convergence PASS; six
Today rows and358 decisions retained, zero errors or production writes.
[Classification](PCR-06-INTEGRITY-CLASSIFICATION.md) and
[bounded closure](PCR-07-BOUNDED-CLOSURE.md) preserve historical ambiguity and
resolved database-read deferral (fresh revision934 verified). Final documentation gates remain
pending; no claim of direct owner-browser inspection or zero historical debt.

The checked-in PCR07 candidate is a pre-merge snapshot. The final exact-main
receipt in [PR193](https://github.com/haohongfei2001-png/pjsdas/pull/193) governs
transition to COMPLETE_WITH_UNRESOLVED after applicable gates and identity checks.
Current revision934 has388actions/363decisions; saved fixture358 remains separate
historical evidence. No current Today count is inferred from aggregate totals.

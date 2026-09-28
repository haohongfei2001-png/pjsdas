# TodayAction Post-Closure Reliability v1 — Canonical Status

Package: `TODAYACTION-POST-CLOSURE-RELIABILITY-v1`

Status: **ACTIVE — WHOLE PACKAGE PREAUTHORIZED FOR DEPENDENCY-SAFE ENGINEERING**

Baseline: `main@c93a0fca9ef9b8eec8e234557f525445c0ef6b20`

Historical boundaries:
- Consumer-Grade Refoundation v1 remains **COMPLETE — STABLE CONSUMER-GRADE BASELINE**.
- UU-08 / UU-09 remain **HOLD — NOT_AUTHORIZED**.
- Release publication remains disarmed/separate.
- Existing Reliability Closure and Active-Unresolved packages retain their own
  historical receipts and truth; this package does not rewrite them.

Current phase: **PCR-03 — Schedule/history mutation semantics audit**

Current writer: **reliability/pcr03-history-undo-v1 — exact occurrence compensation**

Production claim: **P0 verified on exact runtime a8d9840; Repair 02 committed 38 settlements once (CAS 841 → 842), readback 843, read-only idempotency 0. No further production write authorized.**

## Phase queue

| Phase | State | Purpose |
| --- | --- | --- |
| PCR-01 | COMPLETE | exact-main closure of merged PR #185 history/startup P0 and any already-authorized bounded follow-through |
| PCR-02 | COMPLETE | PR #188 recovery slice merged; exact-main d19 CI/Browser/Matrix/Pages/Self-Test and deployed readonly startup verified; late-read race tracked in PCR-05 |
| PCR-03 | IN_PROGRESS | reproduced historical Undo/reopen mutation; bounded compensation candidate and durable local/connected regressions |
| PCR-04 | PLANNED | action-intent correctness across UI/API/MCP paths |
| PCR-05 | PLANNED | connected-mode restart/reload/recovery hardening |
| PCR-06 | PLANNED | read-only production integrity classification + regression binding |
| PCR-07 | PLANNED | bounded reliability closure |

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
Eight real browser regressions pass, including subsequent-edit refusal and durable
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

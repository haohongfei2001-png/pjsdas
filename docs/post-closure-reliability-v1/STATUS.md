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

Current phase: **PCR-02 — startup and recovery invariant audit**

Current writer: **reliability/pcr02-account-recovery-v1 — bounded account-boundary recovery**

Production claim: **P0 verified on exact runtime a8d9840; Repair 02 committed 38 settlements once (CAS 841 → 842), readback 843, read-only idempotency 0. No further production write authorized.**

## Phase queue

| Phase | State | Purpose |
| --- | --- | --- |
| PCR-01 | COMPLETE | exact-main closure of merged PR #185 history/startup P0 and any already-authorized bounded follow-through |
| PCR-02 | IN_PROGRESS | account-cache recovery, atomic clear and serialized auth transitions; seven regressions; full gates pending |
| PCR-03 | PLANNED | Schedule/history mutation semantics audit |
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

## PCR-02 current evidence

[Recovery audit](PCR-02-RECOVERY-AUDIT.md): actual auth expiry + failed cache clear
left stale account UI; a third-store synchronous clear failure committed partial
data loss. Candidate repair enters root recovery and aborts the full clear
transaction. Seven new browser regressions plus two existing account journeys pass;
982 unit/type/build pass. Remote full gates/review and exact-main verification
remain required. PCR-03..07 are still pending; no further production write allowed.

First-head Codex P2 duplicate Settings/auth-listener clear was valid: the queue now
serializes both paths and latches failures until Retry. Its real one-shot failure
regression fails before the repair. Independent probes confirmed two later work
items: late authoritative reads revive signed-out cache (PCR-05), and task Undo
rewrites historical completed/elapsed nodes (PCR-03). Neither is marked complete.

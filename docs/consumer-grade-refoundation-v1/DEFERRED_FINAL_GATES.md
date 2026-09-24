# Deferred Final Gates — PJSDAS Consumer-Grade Refoundation v1

These gates remain mandatory for phase/package certification but do not stall independent engineering in the frozen CGR-00..CGR-05 plan.

A deferred item is never PASS. Production/runtime claims remain exact-SHA claims.

## Open gates

### DFG-CGR-002 — CGR-04 current-live source certification

- **Owner phase:** CGR-04 — Natural Intake & Automation Closure.
- **State:** PRODUCTION_PENDING_EXTERNAL.
- **Engineering runtime:** `0acf71aca95708cd46cc9f50011e62a3a6ca23cf`.
- **Engineering evidence:** exact-main CI `35909962934`, Browser E2E `35909962931`, and real VoiceOver/visual `35909963042` all passed; see `receipts/CGR-04-ENGINEERING.md`.
- **Current condition:** production API and frontend both served exact integrated runtime `0c70dcc6780a0be4d2ba2623700b549a46ac9342` on 2026-09-24. Read-only production metadata audit later the same day verified that Gmail automation is enabled with a committed history cursor, no pending page/history/messages, no latest error, and a fresh successful history-mode run that received 2 records, accounted for 2, left 0 unresolved, and completed in about 8.3 s. The corresponding two Gmail messages were independently read from the connected mailbox and were GitHub/Vercel development notifications rather than recruiting facts; PJSDAS recorded ingestion/audit state without inventing an Opportunity or Process. The production ledger also shows committed `gmail_semantic_intake` receipts and, in the preceding two hours, real DecisionRequest/semantic-receipt affected-object evidence. This proves current-live Gmail transport plus fail-closed authoritative intake, but it does **not** by itself close the frozen source canary: recruiting-fact UI projection, replay/dedupe/recovery, Web, and PAIA/current-chat production journeys remain required.
- **Still required:** on the exact deployed integrated runtime, certify every source actively promised to users across real transport, interpretation outcome, authoritative commit or DecisionRequest, UI projection, dedupe/replay, and recovery. Preserve source permissions and private-data boundaries; an unsupported reminder/attachment/link capability must remain truthfully scoped.
- **Non-blocked work:** dependency-safe CGR-05 engineering.
- **Final effect:** CGR-04 cannot become COMPLETE and the package cannot receive final certification until this gate passes.

## Closed gates

### DFG-CGR-001 — CGR-03 exact-production deployment and browser canary

- **State:** PASS on certified runtime `0c70dcc6780a0be4d2ba2623700b549a46ac9342`.
- **Evidence:** production API and frontend release manifest exposed that same exact SHA; exact-main CI `35945015086` and Browser E2E `35945015110` passed; frozen headless production canary `35945236292` passed list/detail/deep-link/decision/action/Undo with second-session verification. The isolated synthetic account and access grant were removed. See `receipts/CGR-03.md`.
- **Earlier failure preserved:** `35943406168` failed before identity creation because the workflow lacked its browser runner; it did not certify production behavior.

## Rules

- Append future external-only production gates here rather than using them as package-level pauses.
- Do not create new paid commitments, permissions, external recruiting actions, or publication merely to close a gate.
- Prefer a later stable exact integrated deployment to execute every still-applicable frozen canary contained in that runtime; each phase still needs its own recorded evidence.
- If a delayed canary exposes a real defect, repair the earliest affected behavior and invalidate/re-run downstream evidence that depended on the defect.
- Once all automatable CGR work is exhausted, remaining deferred gates become the final convergence wait set.

# Deferred Final Gates — PJSDAS Consumer-Grade Refoundation v1

These gates remain mandatory for phase/package certification but do not stall independent engineering in the frozen CGR-00..CGR-05 plan.

A deferred item is never PASS. Production/runtime claims remain exact-SHA claims.

## Open gates

None.

Owner Amendment `OWNER_AMENDMENT_2026-09-25.md` removed the environment-dependent fresh natural recruiting-Gmail event from the package exit criteria. The event remains registered as post-closure observation `OBS-CGR-001` in `POST_CLOSURE_OBSERVATIONS.md`. This is not a PASS claim for an event that did not occur.

## Closed / declassified gates

### DFG-CGR-002 — CGR-04 current-live source certification

- **State:** CLOSED_BY_OWNER_AMENDMENT — RECLASSIFIED_TO_POST_CLOSURE_OBSERVATION.
- **Certified final runtime:** `58e9f7f4bd584139ffeb8c17a3ee6c8c15d94c3a`.
- **Evidence retained:** Vercel production and Pages exact-SHA deployment; CI `36029890017`; Browser `36029889958` 71/71 clean; macOS visual + real VoiceOver `36029889938`; Production Self-Test `36030107858`; one-shot production certification `36030107785`; repaired-runtime Gmail transport/accounting/fail-safe run with 12/12 real non-recruiting messages, 0 unresolved, and no guessed business object.
- **Truth boundary retained:** the unavailable fresh natural recruiting-email event did not occur before closure and is not represented as passing. Production MCP/current-chat is certified; delegated ChatGPT-host OAuth and authorized PAIA transport remain uncertified/unavailable, and PAIA remains inactive without a delegated grant.
- **Follow-up:** `OBS-CGR-001` checks the first naturally arriving real recruiting Gmail message when practical. A material defect discovered later becomes a baseline defect; it does not retroactively fabricate or erase the closure evidence.

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

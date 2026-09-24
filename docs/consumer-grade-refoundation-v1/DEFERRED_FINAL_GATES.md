# Deferred Final Gates — PJSDAS Consumer-Grade Refoundation v1

These gates remain mandatory for phase/package certification but do not stall independent engineering in the frozen CGR-00..CGR-05 plan.

A deferred item is never PASS. Production/runtime claims remain exact-SHA claims.

## Open gates

### DFG-CGR-002 — CGR-04 current-live source certification

- **Owner phase:** CGR-04 — Natural Intake & Automation Closure.
- **State:** PRODUCTION_PENDING_EXTERNAL.
- **Engineering runtime:** `0acf71aca95708cd46cc9f50011e62a3a6ca23cf`.
- **Engineering evidence:** exact-main CI `35909962934`, Browser E2E `35909962931`, and real VoiceOver/visual `35909963042` all passed; see `receipts/CGR-04-ENGINEERING.md`.
- **Current condition:** production still serves the older stable exact runtime `0c70dcc6780a0be4d2ba2623700b549a46ac9342`; latest product-runtime repair is main `58bd9dcbcc01b0a52b1e093a966e5992970f7bde`, which cannot yet be production-certified because the deployment provider hit its daily capacity limit. Read-only production metadata audit proved live Gmail history transport, cursor/accounting and fail-closed handling for a non-recruiting batch. A real Southern Asset Management written-test reminder then exposed a CGR-04 interpretation defect on the old runtime: one source message with no matching Opportunity produced unrelated active-opportunity choices and five open DecisionRequests, including conditional-text false positives. PR #146 repaired identity-free target resolution, conditional completion/future-interview parsing, duplicate unresolved fragments and a repeated connected sign-out race; exact-main CI `35965614599` and Browser E2E `35965614627` passed. The older Gmail observation is retained as diagnosis evidence, not final PASS.
- **Prepared final batch:** after automatable work is exhausted, deploy one stable exact integrated main SHA. On that same SHA: (1) rerun the existing CGR-03 production browser canary for Web capture/DecisionRequest/cross-session behavior; (2) verify a fresh real Gmail recruiting input on the repaired runtime across transport -> interpretation -> one bounded write/DecisionRequest -> UI projection -> replay/recovery; (3) run the prepared CGR-04 production MCP canary for real `/api/mcp` current-chat semantics, second-session projection, replay idempotency and bounded decision resolution; (4) verify PAIA truthfully. There are currently no active delegated authorization grants, so the canary must prove PAIA no-grant `AUTH_FORBIDDEN`/no-write behavior; an authorized PAIA production path is required only if an actual PAIA grant is established and the source is described as active. Preserve source permissions and private-data boundaries; do not send a synthetic recruiting email or fabricate a delegated grant merely to close certification.
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

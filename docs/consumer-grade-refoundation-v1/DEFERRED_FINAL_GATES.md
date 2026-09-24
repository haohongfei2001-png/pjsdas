# Deferred Final Gates — PJSDAS Consumer-Grade Refoundation v1

These gates remain mandatory for phase/package certification but do not stall independent engineering in the frozen CGR-00..CGR-05 plan.

A deferred item is never PASS. Production/runtime claims remain exact-SHA claims.

## Open gates

### DFG-CGR-002 — CGR-04 current-live source certification

- **Owner phase:** CGR-04 — Natural Intake & Automation Closure.
- **State:** PRODUCTION_PENDING_EXTERNAL.
- **Certified final runtime:** `58e9f7f4bd584139ffeb8c17a3ee6c8c15d94c3a`.
- **Exact-production evidence already PASS:** Vercel production and Pages exact-SHA deployment; CI `36029890017`; Browser `36029889958` with 71/71 clean and no retry/flaky; macOS visual + real VoiceOver `36029889938`; Production Self-Test `36030107858`; one-shot production certification `36030107785`. CGR-02 command/receipt/Undo, CGR-03 Web/list/detail/deep-link/DecisionRequest/action/Undo/cross-session, and CGR-04 production MCP/current-chat/replay/decision-resolution all pass with verified synthetic cleanup. PAIA has no active delegated grant and correctly returns no-grant fail-closed behavior; do not describe it as active or fabricate a grant.
- **Repaired-runtime Gmail live evidence:** a production history run beginning 2026-09-24 16:50 UTC received 12 real messages, accounted 12, left 0 unresolved, had no pending continuation or latest error, and kept all history lag below 15 minutes. Independent mailbox readback identified the batch as development/CI notifications rather than recruiting facts. The authoritative receipt affected only 13 ingestion/audit timeline objects and created no Opportunity, Process, Action or DecisionRequest. This is valid live transport/accounting/fail-safe evidence on the repaired runtime.
- **Only remaining requirement:** wait for the first naturally arriving real recruiting Gmail input on the repaired runtime and verify transport -> interpretation -> one bounded authoritative update or DecisionRequest -> UI projection -> replay/dedupe/recovery. In particular, identity-free input must not offer unrelated Opportunity targets, and conditional completion/future-stage language must not become false facts. Do not send a synthetic recruiting email, replay the already-consumed defective historical message, expand Gmail/OAuth permission, or change real recruiting state merely to manufacture PASS.
- **Current-chat/PAIA scope truth:** production `/api/mcp` boundary is certified, but the canary records `delegatedHostOAuthCertified:false` and `authorizedPaiaTransportCertified:false`. The current ChatGPT environment exposes no PJSDAS/Todayaction connector, and production has no active PAIA delegated authorization grant. Those unavailable/inactive host capabilities must remain truthfully scoped rather than being fabricated as PASS.
- **Non-blocked work:** none inside frozen CGR-00..CGR-05; all automatable final-convergence work is exhausted.
- **Final effect:** CGR-04 cannot become COMPLETE and CGR-05/package cannot receive final certification until the fresh real recruiting Gmail requirement above passes.

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

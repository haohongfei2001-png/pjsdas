# Deferred Final Gates — PJSDAS Consumer-Grade Refoundation v1

These gates remain mandatory for phase/package certification but do not stall independent engineering in the frozen CGR-00..CGR-05 plan.

A deferred item is never PASS. Production/runtime claims remain exact-SHA claims.

## Open gates

### DFG-CGR-001 — CGR-03 exact-production deployment and browser canary

- **Owner phase:** CGR-03 — Opportunity Workspace.
- **State:** PRODUCTION_PENDING_EXTERNAL.
- **Engineering runtime:** `2ebd8358dae4999eb16dbd66393ae2029062385d`.
- **Engineering evidence:** exact-main CI `35895579807`, Browser E2E `35895579623`, real VoiceOver/visual `35895579943` all passed.
- **External blocker:** Vercel deployment rate limit; production still serves prior CGR-02 runtime `408faba1b34f31614dba8c5ec84b656c8dca9866`.
- **Still required:** exact deployed runtime identity plus the frozen CGR-03 production browser canary and any cleanup/receipt required by the phase contract.
- **Non-blocked work:** CGR-04 engineering and, after its engineering closure, all dependency-safe CGR-05 automatable certification/simplification work.
- **Final effect:** CGR-03 cannot become COMPLETE and CGR-05/package final certification cannot close until this gate passes.

### DFG-CGR-002 — CGR-04 current-live source certification

- **Owner phase:** CGR-04 — Natural Intake & Automation Closure.
- **State:** PRODUCTION_PENDING_EXTERNAL.
- **Engineering runtime:** `0acf71aca95708cd46cc9f50011e62a3a6ca23cf`.
- **Engineering evidence:** exact-main CI `35909962934`, Browser E2E `35909962931`, and real VoiceOver/visual `35909963042` all passed; see `receipts/CGR-04-ENGINEERING.md`.
- **External blocker:** production still serves prior CGR-02 runtime `408faba1b34f31614dba8c5ec84b656c8dca9866` while Vercel deployment capacity is rate limited. No current-live CGR-04 source canary was run against the integrated SHA.
- **Still required:** on the exact deployed integrated runtime, certify every source actively promised to users across real transport, interpretation outcome, authoritative commit or DecisionRequest, UI projection, dedupe/replay, and recovery. Preserve source permissions and private-data boundaries; an unsupported reminder/attachment/link capability must remain truthfully scoped.
- **Non-blocked work:** dependency-safe CGR-05 engineering.
- **Final effect:** CGR-04 cannot become COMPLETE and the package cannot receive final certification until this gate passes.

## Rules

- Append future external-only production gates here rather than using them as package-level pauses.
- Do not create new paid commitments, permissions, external recruiting actions, or publication merely to close a gate.
- Prefer a later stable exact integrated deployment to execute every still-applicable frozen canary contained in that runtime; each phase still needs its own recorded evidence.
- If a delayed canary exposes a real defect, repair the earliest affected behavior and invalidate/re-run downstream evidence that depended on the defect.
- Once all automatable CGR work is exhausted, remaining deferred gates become the final convergence wait set.

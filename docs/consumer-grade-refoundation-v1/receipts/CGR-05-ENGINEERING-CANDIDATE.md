# CGR-05 — Integrated engineering candidate

State: ENGINEERING_INTEGRATED / FINAL_CERTIFICATION_IN_PROGRESS — not COMPLETE.

## User-visible result and remaining work

Connected Web actions that previously relied on routine whole-workspace uploads now use scoped, account-bound commands and durable receipts. Manual and background sync preserve an unsynced local edit as pending instead of uploading unrelated workspace state or claiming a false save. A signed proposal, Process Event or Discovery change cannot silently fall back to a broad connected write. A connected sign-out checks for pending local changes before clearing the account cache.

This removes a daily dual-write authority, but it does not yet certify a consumer-grade baseline. The two-hour connected-session gate has passed; broad route-level visual and screen-reader review, account-isolation and degraded/reliability convergence, final legacy/CSS audit, and exact deployed production journeys remain open.

## Exact engineering evidence

- Integration PR: #137, candidate `e78b24d523425791e8503eb21aa9d42c1dafe4a8`, integrated main `8d4da747305f97b1d86709bc9d9d138082ccfd4c`.
- Candidate full CI/build/security: `35942483468` PASS; Browser E2E: `35942511137` PASS.
- Exact-main CI/build/security: `35942856418` PASS; Browser E2E: `35942856408` PASS. The existing command, cross-client, dense-workspace, failure and account-isolation journeys remain in that Browser E2E portfolio.
- macOS visual and real VoiceOver Today/capture journey: `35940801520` PASS at `119afe53cdaebf3a7abf1bb37f41d62bb85cad8a`. Subsequent candidate changes before integration were test/docs/workflow/policy only; the product runtime is the same.
- Two-hour synthetic connected browser session: `35942876277` PASS at exact integrated main; the `synthetic-connected-soak` job completed successfully after the full two-hour run. The earlier six-second local smoke remains only test-path evidence and is not counted as certification.
- Routine connected snapshot purpose rejection, reviewed migration/recovery exception, first-party-only permissions, stale-baseline conflict and lost-response recovery are covered in focused regression and the exact-main suite; details are in `../CGR05_LEGACY_AUDIT.md`.

## Open gates and boundaries

- CGR-03 production certification is closed by successful canary `35945236292`. CGR-04 current-live source certification and CGR-05 final production convergence remain open under `../DEFERRED_FINAL_GATES.md` and the phase contract. Production API and frontend serve runtime `0c70dcc6780a0be4d2ba2623700b549a46ac9342`; the subsequent two main commits are documentation-only.
- CGR-05 final production, source-capability, visual-craft, accessibility, account-isolation and degraded/reliability evidence remains incomplete. Long-session is PASS. Static deployed-runtime readback also confirms routine connected whole-snapshot authority is retired: only `migration_recovery` can commit a snapshot, ordinary connected `push_local` becomes `local_pending`, and `NotificationPasteDock` is removed. This static evidence does not substitute for remaining production journeys.
- The release guard ran disarmed at exact main `35943014173`; its release-creation steps were skipped. No publication is authorized or claimed.
- If a delayed canary finds a real defect, repair the earliest affected phase and revalidate affected downstream evidence before claiming completion.

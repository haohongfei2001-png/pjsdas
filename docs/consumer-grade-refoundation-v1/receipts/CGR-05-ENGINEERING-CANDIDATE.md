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
- Final cross-browser RC hardening: run `35961179744` PASS on main `d8302bee2c7a9b8ead2e7fe81fa144df161f1489` with Chromium 10/10, Firefox 10/10, WebKit 10/10, and mobile Chromium 2/2. The only change from the certified product tree was the temporary workflow trigger used to launch this pre-existing frozen matrix; no runtime or test assertion changed. The trigger is removed immediately after evidence capture.
- Expanded real macOS VoiceOver certification: branch run `35962080966` PASS with 2/2 real VoiceOver journeys plus the macOS visual job. It preserves the existing Today/capture journey and adds Opportunities/detail plus Settings primary-route semantics. An earlier branch run `35961563541` had Today/capture PASS but the new route test failed because the test assumed the VoiceOver cursor would repeat the company name after detail focus; its spoken output already contained real detail semantics (`结论`, `阶段`, `面试`, `流程结果`, recovery/navigation controls). The corrected assertion checks those spoken detail semantics while DOM identity remains strict; no accessibility requirement was removed.
- Routine connected snapshot purpose rejection, reviewed migration/recovery exception, first-party-only permissions, stale-baseline conflict and lost-response recovery are covered in focused regression and the exact-main suite; details are in `../CGR05_LEGACY_AUDIT.md`.

## Open gates and boundaries

- CGR-03 historical production certification is closed by successful canary `35945236292`. CGR-04 current-live source certification and CGR-05 final production convergence remain open under `../DEFERRED_FINAL_GATES.md` and the phase contract. Production still serves runtime `0c70dcc6780a0be4d2ba2623700b549a46ac9342`, but later main contains real product-runtime repairs through `58bd9dcbcc01b0a52b1e093a966e5992970f7bde`; the old deployment is therefore not sufficient for final certification.
- CGR-05 final production and current-live source-capability evidence remain incomplete. Long-session, the frozen cross-browser RC matrix, dense workspace, account isolation, lost-response/conflict recovery, keyboard, narrow/large-text browser checks, routine connected write retirement, and real VoiceOver coverage for Today/capture/Opportunities/detail/Settings all have passing engineering evidence. PR #146 also repaired the repeatedly reproduced sign-out-after-local-pending race and passed exact-main CI/Browser without relying on the prior retry. Existing screenshots were re-reviewed for Today desktop/phone/dense, Opportunity 320px large text, and degraded-source Settings; no new blocking craft defect is established from those artifacts. Fixed controls visible mid-page in full-page mobile captures are a screenshot-composition limitation unless reproduced in an actual viewport journey; existing mobile viewport assertions pass. This artifact review is not represented as independent human visual-craft evidence and does not substitute for remaining production journeys.
- The release guard ran disarmed at exact main `35943014173`; its release-creation steps were skipped. No publication is authorized or claimed.
- If a delayed canary finds a real defect, repair the earliest affected phase and revalidate affected downstream evidence before claiming completion.

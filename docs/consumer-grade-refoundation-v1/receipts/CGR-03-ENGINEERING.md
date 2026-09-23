# CGR-03 — engineering closure; production certification pending

status: `ENGINEERING_COMPLETE / PRODUCTION_PENDING_EXTERNAL`

## User-visible result and limit

The integrated Web workspace now lets a user scan hundreds of opportunities, open a detailed role, understand progress and verified preparation, resolve a real ambiguity, complete an action with Undo, and return to the prior list or detail context. Earlier daily surfaces split these tasks across inconsistent routes and exposed internal module language. Ended opportunities retain their records without recommending stale actions. The browser journeys cover dense and narrow layouts, large text, long history, missing deep links, source loss, and recovery wording.

These are engineering and controlled browser results. A real production account journey on the new runtime, production deep links, and CGR-03 production mutation/decision canaries remain **pending**, not PASS. No release publication occurred.

## Exact integrated engineering evidence

- Opportunity Workspace PR #127 merged at `5c5d5e5d6c1641a43d53e31d9bc45ba538b445a7`; real VoiceOver follow-up PR #131 merged at final engineering runtime main `2ebd8358dae4999eb16dbd66393ae2029062385d`.
- Final candidate #127 head `7cbea8da031f71c29586ceb18606aed27e58b346`: CI `35893815927` and Browser E2E `35893815972` SUCCESS after integration with CGR-02's final main.
- Repair candidate #131 head `5516b0cfc5b60b376b02d7a21307336496c79b4a`: CI `35895061308`, Browser E2E `35895061376`, and real macOS VoiceOver/visual `35895114369` SUCCESS. The prior exact-main VoiceOver failure `35894336408` is preserved: the test's backward cursor command repeatedly found the Close button; its focused-input cursor navigation was repaired without removing the spoken-label or saved-result checks.
- Final exact runtime main `2ebd8358dae4999eb16dbd66393ae2029062385d`: CI `35895579807`, Browser E2E `35895579623`, and real VoiceOver/visual `35895579943` SUCCESS. Required authorization, command integrity, identity, migration, privacy, and browser regressions remain in those checks.
- Controlled browser evidence covers 240 mixed-language opportunities, list search/filter/Back/focus, source-backed decisions, occurrence action, complete history, broken source recovery, ended/stale actions, 320px/390px layouts, and 200% text. Reviewed visual artifacts use synthetic data. Dead AppV5 routing and 187 unconsumed legacy CSS rules were retired; the CSS bundle decreased from 135.37 kB to 119.05 kB. The actual mobile overlap failure and its reviewed visual baseline update remain visible in CI history.
- A manual headless production browser canary workflow and synthetic-account fixture are integrated but unexecuted. Its no-network `--plan` passed locally. It requires matching API/frontend exact SHA, a temporary isolated account, list/detail/deep-link/decision/action/Undo journeys, second-session reads, and revocation/cleanup.

## External certification and next phase boundary

Vercel status for final engineering SHA `2ebd8358dae4999eb16dbd66393ae2029062385d` is `Deployment rate limited — retry in 24 hours`. Canonical production `https://todayaction.com` still serves runtime `408faba1b34f31614dba8c5ec84b656c8dca9866`; no CGR-03 production evidence is attributed to the new code. The rate limit is an external deployment capacity condition, not a product PASS. When capacity returns, certify the newest stable exact integrated main SHA and execute the frozen CGR-03 canary against that runtime. A canary product defect stops forward engineering for repair.

Under `EXECUTION_PROTOCOL.md`, CGR-04 may begin its already frozen engineering work as the only one-phase overlap. CGR-03 remains production-pending and CGR-05 cannot start while the earliest pending production gate is open. Publication remains a separate owner decision.

This documentation-only receipt records the runtime SHA above; it does not itself create a new certified runtime.

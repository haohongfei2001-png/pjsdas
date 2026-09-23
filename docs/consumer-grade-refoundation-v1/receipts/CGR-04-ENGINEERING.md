# CGR-04 — Natural Intake & Automation Closure, engineering receipt

verdict: ENGINEERING_COMPLETE / PRODUCTION_PENDING_EXTERNAL

candidate_pr: #133

candidate_head: `8428810c466df6e18897700c84086e0bd721c0f4`

candidate_ci: `CI run 35909272335 / SUCCESS`

candidate_browser: `Browser E2E run 35909272300 / SUCCESS`

merged_runtime_main: `0acf71aca95708cd46cc9f50011e62a3a6ca23cf`

exact_main_ci: `CI run 35909962934 / SUCCESS`

exact_main_browser: `Browser E2E run 35909962931 / SUCCESS`

exact_main_voiceover: `CGR-02 VoiceOver run 35909963042 / SUCCESS`

## Engineering outcome

The active Web, Gmail, PAIA and current-chat adapters continue through the shared Semantic Intake authorization, policy, transaction and receipt path. Web and Gmail now keep explicit quoted history out of current assertions and explain excluded context. A submitted application for a company whose name contains “测试” no longer becomes an assessment invite. Gmail source outcomes distinguish transport gaps, interpretation failure, business ambiguity and normal capability boundaries, including in the active Settings view. A completed poll can report interpretation failure without pretending the input was committed.

## Verification

- Exact candidate CI and all 67 headless browser journeys passed. The affected journeys include quoted old mail rescheduling one occurrence, undated Gmail interpretation failure with no guessed write, same-company identity safety, mixed current/quoted Web receipt, and narrow enlarged-text mobile capture with a screenshot artifact.
- Existing shared-kernel tests preserve source authorization, DecisionRequest, dedupe/provenance across PAIA/current-chat, replay/idempotency, Gmail cursor/lease/continuation, and no-write statement modes. No OAuth permission, data collection, paid processor, external recruiting action, or publication expanded.
- The initial narrow-screen test used a hidden desktop button. The corrected test uses the real mobile control; the failed run is retained as evidence.

## Deferred production evidence

CGR-03's exact deployed runtime and browser canary remain pending because production still serves an older SHA. CGR-04 also requires real current-live source transport, interpretation, command/DecisionRequest, UI projection, replay/dedupe and recovery canaries for each actively promised source. These are not PASS. This engineering receipt does not mark CGR-04 COMPLETE or authorize publication. CGR-05 dependency-safe engineering is next after this exact-main closure; every deferred production gate remains mandatory for final certification.

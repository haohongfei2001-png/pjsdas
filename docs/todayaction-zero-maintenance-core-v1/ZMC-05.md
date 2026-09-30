# ZMC-05 — Quiet Today consumer surface

## Product behavior

Today keeps usable saved tasks visible through a temporary background read failure. A small, unaccented freshness line explains that the displayed records are saved; it offers no maintenance action and carries no alert role. An empty workspace whose first authoritative read fails has one retry button inside its empty state. A genuinely blocked local state retains one compact Settings entry; its recovery remains governed by the safe convergence policy in ZMC-02.

The selected hard deadline or fixed commitment conflict has one actionable notice inside the relevant task or node panel. The notice does not span the whole Today grid and follows the selected mobile panel. Normal refresh has no visible banner. Historical unresolved arrangement counts and their maintenance shortcut are absent from Today; Schedule still provides a deliberate route to the retained history.

## Regression evidence

Before the change, a verified-cache read failure showed an orange status with a retry action, and a hard deadline warning occupied the grid above both panels. The new browser assertions failed on that prior behavior. The green headless Chromium checks cover first-read failure, cached failure, dense retained decisions, hard deadline placement, fixed overlap placement, mobile panel visibility, and Schedule access to historical occurrences.

The final candidate passed 208 unit files / 1095 tests, build and type check, 152 headless Chromium browser tests, and 5/5 Today UI tests. PR #201 exact head `71a6e6ea0b24bafe950e7ffea5d21a336dd06d96` passed CI, Browser, Firefox/WebKit Matrix, VoiceOver, visual, UI, brand, rollback, Vercel, and independent review with no actionable findings. The UI gate initially caught a test assertion that failed against its old baseline; the final head uses version-specific assertions and passed. Merged main `5c2b02adb8cde0537bc0b41f32c068b4541d2802` has the same tree as the reviewed head (`fbb666304fb865504a11d7248715848af8c6fabb`). Merged-main CI, Browser, Matrix, VoiceOver, deployment, production self-test, and certifications succeeded. Production release manifest and API health returned that exact merge SHA.

No historical schedule or decision record is deleted. No production business record is mutated.

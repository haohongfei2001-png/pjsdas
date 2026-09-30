# ZMC v1 status

Package: TODAYACTION-ZERO-MAINTENANCE-CORE-v1
Baseline: remote `main@a98358a0565c0200fc7da73dce6e747050ced771`
Phase: ZMC-00 through ZMC-07 merged and exact-main verified. ZMC-08 settings/recovery is in progress; see [ZMC-01.md](ZMC-01.md), [ZMC-02.md](ZMC-02.md), [ZMC-03.md](ZMC-03.md), [ZMC-04.md](ZMC-04.md), [ZMC-05.md](ZMC-05.md), [ZMC-06.md](ZMC-06.md), [ZMC-07.md](ZMC-07.md), and [ZMC-08.md](ZMC-08.md).
Next: complete ZMC-08 gates, then ZMC-09 owner-like dense acceptance. The package remains open until all owner completion gates are verified.

Latest verified main before ZMC-05: `175265b687dc6846136d1ba8f6b03183c5a46593`, tree `fbc894cb7208a5051e935358f92e32a29e5aab48`. PR #200 passed full CI, Browser, Matrix, VoiceOver, visual, UI, brand, rollback, Vercel, and independent review. Production release manifest and API health returned that exact merge SHA.

Latest verified main before ZMC-06: `5c2b02adb8cde0537bc0b41f32c068b4541d2802`, tree `fbb666304fb865504a11d7248715848af8c6fabb`. PR #201 exact head passed CI, Browser, Matrix, VoiceOver, visual, UI, brand, rollback, Vercel, and independent review. Merged-main CI, Browser, Matrix, VoiceOver, deployment, production self-test, and certifications succeeded. Production release manifest and API health returned that exact merge SHA. Open issue #62 remains unrelated to this phase.

Latest verified main before ZMC-07: `8ac7640b449da122a4da11ed828099344ac45b25`, tree `e7cd192740048fa847cfa63e9e354668760c20ab`. PR #202 exact head passed CI, Browser, Matrix, UI, brand, VoiceOver, rollback, Vercel, and independent review. Merged-main CI, Browser, Matrix, deployment, production self-test, and certifications succeeded. Production release manifest and API health returned that exact merge SHA.

Latest verified main before ZMC-08: `612bdf5d04fe46079748fe8479202c72863bfd4f`, tree `75e92490de96f43fd9efb8e532cf0195f9adefaf`. PR #203 exact head passed CI, Browser, Matrix, UI, brand, VoiceOver, rollback, Vercel, and independent review. Merged-main CI, Browser, Matrix, VoiceOver, deployment, production self-test, and certifications succeeded. Production release manifest and API health returned that exact merge SHA. Open issue #62 is unrelated to this phase; there are no open PRs at phase start.

Remote baseline readback on 2026-09-30: no open PR; CI, Browser, Matrix, VoiceOver, production self-test, and verified release succeeded for `a98358a0`. `https://todayaction.com/release-manifest.json` and `/api/health` both returned that exact commit. Open issue #62 concerns immutable GitHub Releases and is unrelated to this package.

Known engineering debt at registration: hardcoded Web 180-minute capacity; no durable time preference; all due/doing/protected actions can enter Today outside the plan; connected sync still contains whole-workspace conflict choices; offline capture remains a draft rather than a complete background command; routine settings expose sync mechanics. These are open defects, not closed by this registration.

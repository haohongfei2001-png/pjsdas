# ZMC v1 status

Package: TODAYACTION-ZERO-MAINTENANCE-CORE-v1
Baseline: remote `main@a98358a0565c0200fc7da73dce6e747050ced771`
Phase: ZMC-00 through ZMC-03 merged and exact-main verified. ZMC-04 typed merge/conflict policy is in progress; see [ZMC-01.md](ZMC-01.md), [ZMC-02.md](ZMC-02.md), [ZMC-03.md](ZMC-03.md), and [ZMC-04.md](ZMC-04.md).
Next: complete ZMC-04 gates, then ZMC-05 quiet Today. The package remains open until all owner completion gates are verified.

Remote baseline readback on 2026-09-30: no open PR; CI, Browser, Matrix, VoiceOver, production self-test, and verified release succeeded for `a98358a0`. `https://todayaction.com/release-manifest.json` and `/api/health` both returned that exact commit. Open issue #62 concerns immutable GitHub Releases and is unrelated to this package.

Known engineering debt at registration: hardcoded Web 180-minute capacity; no durable time preference; all due/doing/protected actions can enter Today outside the plan; connected sync still contains whole-workspace conflict choices; offline capture remains a draft rather than a complete background command; routine settings expose sync mechanics. These are open defects, not closed by this registration.

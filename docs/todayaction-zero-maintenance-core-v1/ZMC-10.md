# ZMC-10 — Final reliability closure

## Exact source and product boundary

This closure starts from remote `main@7bb31bb34e4d905d8eee6e435ec9bb6931aabfe7`, the merged ZMC-09 product tree `74a63695e66d17acdabb1f89f8676db44ecf7cb4`. GitHub had no open PR at the phase boundary. The canonical [product intent](../consumer-grade-refoundation-v1/PRODUCT_INTENT.md) and [technical architecture](../consumer-grade-refoundation-v1/TECHNICAL_ARCHITECTURE.md) still require a small useful Today, server-confirmed business commands, safe local intent recovery, and source/audit preservation. The only open repository issue was #62, about immutable GitHub Releases before a public release; it does not describe a remaining TodayAction consumer defect in this package.

## Verified release boundary

PR [#205](https://github.com/haohongfei2001-png/pjsdas/pull/205) exact head `61f3399752acab77f422ebbfc68cad830701ec6e` passed full CI, headless Chromium Browser, Firefox/WebKit Matrix, UI, brand, visual, Vercel preview, and three real VoiceOver journeys on macOS 14 Chromium. Its fresh independent review reported no actionable regression. A first Matrix run exposed a real sign-out/background-refresh race; the sign-out operation lock was fixed and the next exact-head Matrix passed. The tests were not weakened.

The PR merged to `main@7bb31bb34e4d905d8eee6e435ec9bb6931aabfe7`. The merged-main CI, Browser, Firefox/WebKit Matrix, real VoiceOver, GitHub Pages deployment, production self-test, brand and visual checks, CGR production certification, reliability certification, and verified release all completed successfully. Read-only requests to `https://todayaction.com/release-manifest.json` and `https://todayaction.com/api/health` both returned the exact merge SHA; API health returned `ok`. These are release and availability proofs, not a claim that the private owner browser profile was inspected.

## Consumer acceptance

The permanent [ZMC-09 regression ledger](ZMC-09.md) connects all 18 owner-reported failure classes to red-before evidence and green-after tests. Its real headless persistent-browser journey starts with 384 actions, 358 retained historical Gmail decisions, 300 schedule nodes, and a six-hour capacity. Today stays a small actionable set. A Gmail server update, stale browser cache, offline command, separate-device command, browser process restart, and reconnect converge with one stable command ID; a controlled same-object stale write fails closed. The Schedule cancellation journey proves that a committed server receipt remains confirmed when local projection is blocked, with no duplicate business command and no exposed internal error code. Audit records and provenance remain intact.

The acceptance uses synthetic account data. The baseline read-only production aggregate had 363 open Gmail-origin DecisionRequests (173 missing field, 117 ambiguous target, 69 low confidence, four ambiguous occurrence) beside six real Today tasks. Earlier phase receipts document the parser generation gates and classification changes; no production business records were deleted or rewritten to make the UI appear clean. The exact subtype of the existing owner Chrome profile's local difference remains a read-only diagnostic question. This phase does not claim to have auto-converged that particular profile without its evidence, and it does not clear IndexedDB or choose a side for the owner.

## Disposition

The ZMC-00 through ZMC-09 engineering and release gates are complete. No additional reproducible consumer defect emerged from the final remote-main, open-issue, canonical-document, and production-runtime audit. Keep the owner-profile diagnostic path available for read-only classification if that profile is revisited; a genuine local edit or pending operation must continue to fail closed. No production workspace write, historical deletion, Gmail cursor/scope change, external action, purchase, or paid-plan change was made for this closure.

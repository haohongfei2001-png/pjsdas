# TodayAction Active Unresolved Reduction v1

Package: `TODAYACTION-ACTIVE-UNRESOLVED-REDUCTION-v1`

Purpose: reduce false-positive active unresolved debt without manufacturing false-green Coverage.

Initial production read-only baseline:
- active unresolved: 177
- Gmail: 123
- GPT monitor: 54
- unlinked unresolved: 134
- live-process ambiguity: 30
- semantic decision open: 12
- transport gap active: 1

First bounded repair:
- settle only legacy Gmail records whose entire unresolved reason is a historical capability-boundary marker:
  - link-only unsupported;
  - attachment-only unsupported;
  - attachment + link unsupported.
- require no issueKinds, no linked Opportunity/Event/Action, no company/role identity and no stronger later semantic decision.
- preserve the original ingestion ledger.
- do not clear quoted/forwarded ambiguity, fragment/body limits, transport gaps, open decisions or live-process ambiguity.

Read-only production audit predicts 31 exact legacy capability-only records are eligible. This is a projection only until the exact deployed code is exercised with `dryRun=1`.

No production workspace write is authorized by this package phase.

# B3 bounded imported interview reschedule

This is the next original-plan A19 slice after PR274, based on merged main
`82d5f3e80b0984166bba03e0a051c9538770ca84`. It is not a certificate for all
Unified Intake or A19. Product/test candidate `0ae5aabac43fe69d32e0d80957a44e7709af4414`
has tree `116c4dc13132e116c333e9b8a3234fd2bf05ca89`. A subsequent test-only
transport correction is `d6252520bd6e286bef876b38358e2a1247c4320f`, tree
`9ec61a51529a35602f147c0f15c1a8082887ac4e`; these are the final full-tested
product/test bytes. This evidence file is added afterward.

## Supported source contract

The existing explicit outer import request must select the supplied source body.
The added grammar is one known-job Chinese interview reschedule line:

`公司 岗位 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30`

Both dates must include a year and clock. Chinese dates or hyphenated dates and
colon clocks are accepted; timezone comes from the already trusted context.
The source body is bounded to 2048 characters. Every remaining token must match
the finite grammar. Only one current scheduled interview with the exact old
instant is supported. Both old/new appointments must not be past at interpretation.
There is no inference from import time about source-message ordering and no
assumption that a reschedule must move later. Source zone suffixes, duration,
ranges, relative dates, rounds, extra lines, source instructions and unknown
qualifiers stay unresolved. Withdrawn or absent outer intent never authorizes
source operations. Completed/cancelled/abandoned/closed cases do not revive.

An exact match produces the existing `occurrence_rescheduled` candidate and
existing domain command. Occurrence identity and supersession history remain;
no new ProcessEvent or Action is created. Semantic receipts, compensation,
principal authorization, revision locks and the normal commit path are retained.

## Authoritative binding

The existing `target.scheduleNodeId` is intentionally a latest-version alias.
Its compatibility meaning is unchanged. The additive, optional paired fields
`expectedScheduleNodeId` and `expectedStartAt` bind this slice to the exact
arrangement it interpreted. The strict gateway DTO requires both fields together.
The authoritative snapshot validates occurrence/job/node identity, current state,
no-end datetime shape, normalized offset-aware start instant, and unambiguous
retained history. An old instant appearing again in the same or another retained
interview occurrence cannot establish source chronology and remains unresolved.

The whole observation is preflighted before any semantic receipt, decision or
business mutation. A stale bound input returns NO_WRITE/changed=false. The
mutation point checks again, so earlier candidates or a later confirmation
cannot bypass the precondition. Committed identical-input replay remains a
no-mutation receipt replay. A fresh duplicate source after the reschedule no
longer matches the old current time and does not append a version.

Both identity and instant are necessary: actual domain Undo removes the newer
version, after which deterministic version IDs can be reused for a different
instant. This ABA was reproduced with the real domain command/compensation path.

## Evidence status

- On exact unchanged main82, five corrected new tests failed: missing adapter,
  missing DTO fields, stale node accepted, actual Undo ABA accepted, and a
  contradictory occurrence/node alias accepted. The original logs are retained.
  An earlier test fixture used an input ID shorter than the existing gateway
  minimum; that fixture was corrected before the exact-main RED was rerun.
- Candidate implementation made those five tests pass. The final small contract
  now has 78 passing cases, including stale/ABA, ambiguous history, authority,
  schema pairing, equivalent offsets, replay, compensation, decision confirm,
  mixed-input atomicity, finite grammar, terminal state and legacy compatibility.
- The preceding 76-case candidate plus existing notice/Gmail/semantic regression
  suites passed 246 tests under UTC. Those 76 also passed under Asia/Shanghai;
  type checking passed. The final two history/identity-bound tests passed in the
  78-case run. These are targeted results, not a full-suite acceptance claim.
- One combined browser journey was added for existing invitation → bound
  reschedule → reload → duplicate/old-source no-write, using the existing
  synthetic transport and real gateway/domain. It has not yet executed.
- Independent review is CLEAN for both runtime and final test-only delta. Seven
  independent targeted cases passed. A real authoritative executor probe verified
  stale repeated input: NO_WRITE, revision unchanged, zero commit RPC/ledger,
  receipt lookup not found; valid replay: one commit only; changed payload under
  an already committed command ID: COMMAND_ID_REUSED. The browser fixture now
  mirrors this changed=false path instead of falsely incrementing its revision,
  and the new journey asserts unchanged revision and receipt count.
- One frozen UTC full run on d625252 passed **342 files / 4052 tests** first time
  in 24.64 seconds. The sequential production build passed, finishing at
  2026-10-18 01:53:39 UTC; the existing >500KB chunk warning remains visible.
  No full-suite failure was retried or replaced with a narrower green result.
- Playwright discovery lists all 32 cases across four projects in the modified
  browser test file. Actual official browser CI remains pending. Local Chromium
  is unavailable under the platform permission boundary and has not been
  launched. No original test threshold or required gate was changed.

# B3 bounded explicit notice import candidate

This is a separate, unaccepted candidate on merged PR270/main
`456a74140b4be83f5f715ac2ca4e1e36ac215a56`. It is not a complete A19 certificate.

## Supported contract

An explicit outer request to import/save/record a following quoted or forwarded
recruiting notice may select the first source layer as data. Plain quotes,
questions, examples, hypotheticals, rewrite requests and source commands do not
grant user intent, actor identity, permission or personal operations. An unquoted
first-party tail is not discarded to make the import writable.
Current Chinese wrappers are anchored `请导入/请保存/请记录` requests naming the
following notice, plus equivalent bounded English import/save/record wrappers.
The source header names the exact known company and role separated by whitespace.

This bounded adapter supports known-job interview, written-test and assessment
invitations with a full, unambiguous absolute date. It uses the supplied timezone,
keeps date-only/deadline meaning, and does not infer a year or resolve relative
source dates from paste time. Unsupported timezone, clock ranges, latest-start,
round/reschedule identity and contradictory weekday/meridiem stay unresolved.

Meeting metadata is deliberately narrow: one isolated ASCII HTTPS URL without
credentials (at most 500 characters), and optionally `线上`, `视频`, or `会议室` /
`Room` followed by an ASCII room identifier. Arbitrary location prose and postal
addresses are unresolved. They cannot be removed as opaque metadata because they
may qualify the notice as another person's, an example, or a different timezone.
Comma-separated URL suffixes remain visible to validation; Unicode URL suffixes
are unresolved rather than silently encoded and discarded.

The latest matching occurrence may be reused, including a completed/cancelled
occurrence without reopening it. Ambiguous matches, older superseded arrangements,
different meeting facts, and unverified source chronology that would regress an
advanced/closed process yield zero candidates. Conflicting times/kinds for one
job, an unsupported batch fragment, or more than 12 final candidates rejects the
whole batch. Existing gateway schema, authority/lease, domain interpretation,
receipts, projection and compensation remain unchanged.

## Evidence provenance

The development executor rolled back to an older filesystem snapshot on
2026-10-17. The previous unpushed candidate and local logs were no longer present.
This candidate was reconstructed against the verified remote main tree. Previous
3698/3718-test results do not cover these bytes and are not claimed as acceptance.

- A reconstructed pre-fix metadata candidate produced eight real `APPLIED` results
  where gateway-validated `applySemanticIntake` must return `NO_WRITE`.
- After the bounded metadata fix, all 20 initial cases passed, including the eight
  negative controls and supported room/URL positives.
- Reconstructed contract plus existing B1/completion suites: 172 tests passed
  (120 new cases and 52 existing cases). The first run's one test-fixture failure
  used overlapping company/role labels (`1` versus `10`); the corrected boundary
  fixture uses distinct alphabetic labels without changing assertions.
- Independent review reproduced five half-day-precision failures: a standalone
  morning/afternoon constraint was discarded, including a conflicting batch.
  Requiring a supported datetime whenever a meridiem is supplied closes this
  class; the reviewer's original five negatives, ten meridiem controls and 13
  authority/identity/lifecycle/type controls independently pass (28/28). The
  bounded code review is CLEAN. Both real RED records remain evidence.
- Initial `1ba76f7` local full unit suite: 336 files / 3775 tests passed first attempt in 24.82s.
  TypeScript build-mode checking and production build passed. The existing
  >500KB chunk warning remains; no limit was changed. This build regenerated its
  usual release identity; only the committed unbound fallback is retained in the
  source change. Full official CI acceptance is pending.
- Initial `1ba76f7` official Browser run
  [39077249303](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39077249303)
  passed first attempt: 3 isolation, 7 deadline UI, 284 core and 73 dense tests.
  The six new notice cases and the added held-hydration case all passed without
  retry. [Artifact 12118385964](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39077249303/artifacts/12118385964)
  preserves the results. These results do not cover the subsequent timezone fix.

The browser cases use the real gateway DTO and domain core behind a synthetic
transport, with authoritative and local business deltas, repeated import after
reload, source/outer-intent negative controls, and 320/390/1440px screenshots.
No real account input, mail, application or paid discovery is exercised.

## First official CI exposed a legacy Tell timezone defect

The first exact-head CI for `1ba76f75e3d8c6cd7bb20dabb8893c2ed4ef8770`
([run 39077249280](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39077249280))
failed one new Tell/import/Gmail equivalence assertion: 335 files / 3774 tests
passed and the remaining timestamp differed by exactly eight hours. The previous
local full result ran on a Shanghai-time host. Its success does not replace the
official failure; the expected timestamp is unchanged.

Separate Node processes under `TZ=UTC` and `TZ=Asia/Shanghai` reproduced four
failures each in eight initial controls. Imported notice and Gmail timestamps
were stable, but the older direct Tell adapter copied its legacy parser's
host-local date despite receiving an explicit timezone. It also accepted empty
or invalid zones. The Web boundary now resolves timed process events against the
supplied timezone or the actual workspace preference, without inventing a host
fallback. Unresolvable dates, invalid zones and unsupported explicit source-zone
qualifiers remain unresolved. Gmail and other legacy-parser consumers are not
changed. This is deliberately conservative: formerly guessed partial dates and
unsupported clock spellings are not claimed as supported equivalents.

Independent review reproduced actual event/node miswrites for attached `+0900`,
`+09`, `北京时间`, `ET`, `(HKT)`, `(AEST)` and compound named-zone qualifiers.
The final pure Web time adapter uses a finite residual grammar after an anchored
known company/title header and represented date/clock. Unknown source qualifiers
are rejected rather than removed under a growing timezone-name list. Normal
time-field labels remain positive controls. The original failures are retained.

Deadline controls also exposed an older completion classifier error: a full date
placed “前完成面试” beyond its short obligation guard. Explicit deadline
instructions are now excluded from completion receipts. The original source
actually completed an existing node for a future deadline instruction. Tests now
cover that existing-occurrence case, genuine completed statements, and same-job
completed/deadline mixtures that require clarification instead of partial writes.
A legitimate new deadline may be applied while the existing node remains
scheduled; that case is not mislabeled as `NO_WRITE`.

Review also caught marker-only (`面试已经` / `面试刚刚`) completion regressions
and differently scoped `面试前完成了`. Completion now requires an anchored full
word order, an appropriate completion predicate and genuine past evidence.
The four actual failing controls remain recorded. A planning branch without a
reliable timezone also stops unresolved rather than falling back to host-local
legacy deadlines.

At this stage, 88 additional pure/domain controls plus the original 172 targeted
cases pass in separate UTC and Shanghai Node processes (260 each). Type checking
passes. Independent closure review checks the four fixed source/test hashes,
runs the 88 new cases in both host zones, and reports CLEAN for this bounded
change. A single frozen full suite in UTC then passes 338 files / 3863 tests on
its first attempt (67.06s), followed by one successful production build. The
existing >500KB chunk warning is retained. Only the build-generated release
identity is restored to its committed unbound fallback, as in the initial build.
Official browser/CI acceptance for the new commit is pending; initial `1ba76f7`
results are not substituted for the additional bytes.

## Separate main browser fixture race

Main Browser run [39074418800](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39074418800)
was successful overall but had 276 core passes and one flaky test; dense 73 and
the three B1 cases passed first attempt. Original PR270 exact-head first-pass
acceptance remains a separate historical result. The original failure is kept in
[artifact 12116868327](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39074418800/artifacts/12116868327).

The blocked-projection test tried to modify fixture action `A-action-1` before
its initial authoritative projection existed locally. The trace records its IDB
read failing before the command's snapshot read and before the semantic command
was sent. Seeing the `Saving` label did not establish fixture hydration.

Only this existing-task race test now establishes actual fixture visibility
before opening capture. A held-read variant proves the fixture is absent until
its response is released. All owner-field conflict, blocked projection, retained
draft and stable receipt/reload assertions remain; no post-Save readiness delay
or B1 first-write wait is added. Both variants passed first attempt in initial
`1ba76f7` Browser run 39077249303; the later timezone candidate still needs its
own browser acceptance.

## Remaining scope

General quoted job descriptions, richer forwarded headers/source timestamps,
general rescheduling and unsupported round identity still require dedicated
interpretation and acceptance. A17 genuine first search plus a subsequent
scheduler-triggered run remains pending. Paid Discovery stays OFF.

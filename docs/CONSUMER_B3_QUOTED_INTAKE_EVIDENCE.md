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
- Fresh full unit suite: 336 files / 3775 tests passed first attempt in 24.82s.
  TypeScript build-mode checking and production build passed. The existing
  >500KB chunk warning remains; no limit was changed. This build regenerated its
  usual release identity; only the committed unbound fallback is retained in the
  source change. Full official CI acceptance is pending.
- Browser discovery finds all 25 tests across the two relevant files, including
  six new notice cases and the added held-hydration case. These new browser
  journeys have not yet executed; discovery is not browser acceptance.

The browser cases use the real gateway DTO and domain core behind a synthetic
transport, with authoritative and local business deltas, repeated import after
reload, source/outer-intent negative controls, and 320/390/1440px screenshots.
No real account input, mail, application or paid discovery is exercised.

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
or B1 first-write wait is added. Its new browser acceptance remains pending.

## Remaining scope

General quoted job descriptions, richer forwarded headers/source timestamps,
general rescheduling and unsupported round identity still require dedicated
interpretation and acceptance. A17 genuine first search plus a subsequent
scheduler-triggered run remains pending. Paid Discovery stays OFF.

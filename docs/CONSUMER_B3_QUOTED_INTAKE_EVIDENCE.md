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
Official CI for `6990166711abf1fbbce74b32b2823cb2574b3f52`
([39079212459](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39079212459))
passed all 338 files / 3863 tests on its first attempt, followed by type checking,
audit, build and the existing standby dry-run. Brand and UI Review also passed.
Its Browser run did not pass; that real failure is recorded below. Initial
`1ba76f7` results are not substituted for the additional bytes.

## Browser compatibility correction batch

The first exact-`6990166` Browser run
[39079212483](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39079212483)
passed isolation and deadline UI, then 276 core tests passed and eight failed
on both their first and retry attempts. Dense tests did not run. The
[original artifact](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39079212483/artifacts/12118920698)
has SHA256 `9d9a1e5137cd4589c99254d1fe83f02c907e67848e94352285cb7efa8247a099`.
No browser assertion or wait is changed to close these failures.

Seven failures had the same product cause: the new preparation-time guard also
blocked untimed explicit tasks such as `事项：整理面试材料`. The eighth was the
existing contextual completed statement `这次面试已经完成了。`, omitted from the
finite completion grammar. The existing affected browser input inventory has
19 literal input sites and nine unique strings, plus a reused const input.
These were moved into a small compatibility matrix, not rewritten in the browser
suite. After fixing an initial gateway test-fixture omission, the unchanged
`6990166` production code produces 13 deterministic failures and 14 passes.

The correction preserves the legacy general-task title/confidence path for
untimed preparation, but never copies its manufactured host-midnight deadline.
Independent review demonstrated that hidden default in both UTC and Shanghai;
the domain requested a decision rather than persisting that case. Three more
real controls proved that unsupported relative/dotted-date time claims cannot
be disguised as untimed tasks.

The pure Web planning boundary now supports a deliberately finite schedule form:
an optional task label, one full absolute or supported relative date prefix,
an optional `HH:mm` / `H时mm` clock, then a preparation verb and task text.
Unresolved calendar/duration/placement/qualifier forms keep their original input
and request clarification. Plain preparation tasks have no timezone dependency.
Whole-input source-time validation remains in force: review caught three source
zone suffixes lost by prefix-only resolution, and all three original failures
are retained as regressions. Shared legacy parsers and Gmail remain unchanged.

Completion accepts the optional demonstrative `这次` before the event name while
retaining the required past evidence, complete predicate and full anchoring.
Missing predicates, before-event obligations, conditions and negation still fail
closed. Existing unit, browser and original timezone assertions are retained.
Final independent review reports CLEAN, including 34 assertion groups and the
original counterexamples in UTC and Shanghai. The final local frozen batch then
passes 340 files / 3930 tests in UTC on its first attempt (59.08s), followed by one
successful production build. The original chunk warning remains unchanged;
only this build's generated release identity is restored to the committed
unbound fallback. This correction still awaits new exact-head official CI.

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

## New deterministic Tell whole-input admission — 2026-10-22

Canonical §8/A18 requires resolving the intended message before saving a subset.
The real Web adapter previously accepted a supported submission clause beside an
unresolved unknown-job interview clause: local and connected calls returned
APPLIED, while offline admission returned QUEUED. Three new adapter regressions
were RED before this correction, with actual interpretation/domain code.

New deterministic Tell admission now returns NO_WRITE before local replacement,
remote command dispatch or offline queueing whenever interpretation has unresolved
fragments. The full draft remains available and the message states that none of
it was saved. Typed manual candidates and intentionally ignored quoted context
are not blocked by this guard. This is conservative: unsupported prose remains
unresolved; it does not claim broad natural-language understanding.

For an existing uncertain command, incomplete interpretation permits receipt-only
recovery, not resend. Absent/failed lookup preserves the original pending envelope;
a committed receipt retains existing safe projection behavior. Receipt-only reads
do not join another same-ID resend flight. This does not retroactively quarantine
legacy outbox entries or change Gmail historical receipt/reconciliation behavior.

Tests cover local/connected/offline no-subset admission, positive quoted context,
existing receipt recovery, absent/failed receipt reads, and a concurrent held writer.
This is a separate slice after PR282; exact-head release gates remain required.

Local integrated verification: 363 files / 4,576 tests, TypeScript checks and
production build passed. Independent review found no remaining caller-path blocker.


## Bounded nonassertive submission protection — 2026-10-22

Actual Tell entrypoint regressions exposed negated, prohibited, failed and
question-form submissions being promoted by a positive keyword into facts.
Local replacement, connected dispatch and offline admission were all affected.
The current correction classifies unquoted current text first, treats exact
paired known identity labels literally, and preserves unsupported/negative
submission intent as non-writing rather than guessing success. It also avoids
queuing or dispatching nonasserting observations, while allowing receipt-only
recovery of an already uncertain operation.

Positive controls preserve actual success statements, the existing confirmation
requirement for less explicit submission wording, literal qualifier words in
company/role labels, quoted old questions, explicit imported notices with URL
query parameters, and mixed-message all-or-nothing admission. Independent review
found and corrected an overbroad URL question check and repeated-identity-token
masking; both retain regression coverage. These are finite conservative guards,
not general semantic understanding or a claim that every paraphrase is solved.

PR286 combines these admission fixes with saved-timezone parity. Hosted checks
must pass on the final exact head before merge; model activation and A17 remain
separate outstanding boundaries.

Browser verification additionally caught a real contextual-completion regression:
a strict fully recognized “这次面试已经完成了。” still carried unresolved debt
from the older parser. The correction consumes only the same strictly recognized
completion clause; unknown sibling clauses remain whole-message blockers. Actual
local/connected/offline regressions were RED before the correction. The unchanged
CGR-03 browser assertion still requires a genuinely completed schedule occurrence.
Quoted/withdrawn browser cases now require zero additional command admission,
revision, receipt or data change, rather than expecting an empty server command;
their successful import, repeat, reload and rescheduling assertions remain intact.

## Contextual completion ownership — 2026-10-22

A two-job actual-entrypoint probe demonstrated that a generic completion could
fall through from selected job A (already completed or missing interview) to B's
scheduled interview. Both local and connected domain execution reproduced the
wrong-job mutation; offline admission queued the wrong target. The former
single-interview browser fixture could not detect this.

The selected existing opportunity now constrains both preview and submission.
Missing, conflicting or ambiguous context never becomes global fallback. The
authoritative semantic batch rechecks candidate occurrence ownership before any
business write, receipt or decision, and delayed decision execution rechecks the
latest occurrence owner at the mutation point. Multiple active rounds within A
still require a decision, without offering B. Context is not authorization and
cannot bypass the existing account lease or authoritative workspace snapshot.

Pending command envelopes remain frozen. Changing context permits receipt-only
lookup, not resending or retargeting; absent/failed receipts preserve the pending
operation. Late or background A success cannot consume an identical-text B draft
or present A's success as B's. Ownership bookkeeping is memory-only and stores no
new raw text; unknown ownership after reload retains the existing draft rather
than inventing a cross-refresh guarantee. Existing background replay stays bound
to the originally authorized envelope and passes the new authoritative guard.

Regression coverage includes local/connected/offline two-job paths, missing and
completed A, terminal latest versions, multiple A rounds, explicit conflicting
identities, mixed-message rejection, forged cross-job IDs, delayed decision
ownership changes, mismatched accounts, receipt recovery and background draft
cleanup. Browser cases retain genuine schedule-state assertions and add held
A-request → B-view → original-receipt recovery with B text and schedule unchanged.
No paid capability, production migration, credential or resolved capture geometry was changed.

### Bootstrap capture continuity

The previous head's UI trace showed the provisional Today `+` being replaced by
its resolved-layout counterpart during the first native click. No editor mounted;
this was not an autofocus failure or an AI-model failure. Today now retains one
capture DOM parent across initial/unavailable and resolved workspace states, and
keeps the provisional layout still through a primary pointer press until the
native click completes. Immediate input remains available; the resolved layout,
44px target and focus assertions are unchanged. Controlled browser regressions
cover node identity, pointer-down/read-resolution/pointer-up, and an already open
editor's draft/focus through resolution. They require hosted browser execution;
source review and unit/build success alone are not browser-pass evidence. This
fix addresses Today freshness transitions, not every possible app-loading mount.

### Default-off AI preview parity for existing interview reschedules

The AI candidate allowlist now represents the existing bounded imported-notice
reschedule flow, rather than creating another interview for an existing one.
Admission still requires explicit outer import intent, one complete absolute
old/new time notice, one current scheduled interview, exact company/role, the
saved workspace timezone, and trusted latest-node/old-time preconditions.
The existing whole-message intake parser proves that bounded notice; matching
timestamp substrings alone do not remove negation, alternatives, foreign timezones,
rounds, durations or other unresolved qualifiers. Unsupported natural-language
reschedules still require clarification. This is not general model-quality evidence.

Stable opportunity/occurrence/node IDs are supplied only by the authenticated
server snapshot. The model receives no inventory, selected IDs or stored notes.
The verified whole notice permits exactly its reschedule candidate, not unrelated
manual tasks or a substituted new invitation. Imported timing remains
source_explicit. No actual original employer-message timestamp is invented;
existing processing/audit time is not evidence of when the employer sent it.
Completion/cancellation remain outside the AI allowlist, rather than guessing an
actual completion/cancellation timestamp.

Selected context now travels through explicit preview identity, immutable input
binding, stored observation and confirmation. A different selected job invalidates
the preview and requires another explicit request. Composer recovery with changed
or unknown legacy context only looks up the original receipt; it cannot resend it
as the current input. Successful legacy receipt reconciliation preserves an
unknown-owner same-text draft and does not claim that draft was saved. Existing
background reconnect may still replay the original authorized frozen command;
that is distinct from a changed-context composer's receipt-only confirmation.
Only context IDs were added to existing pending metadata, not additional raw-text
storage or a cross-refresh draft ownership guarantee.

Offline evidence covers whole-clause rejection, foreign/ambiguous/terminal/stale
occurrences, provider-ID rejection, exact candidate coverage, source provenance,
selected-context identity, legacy receipt lookup, and the real preview handler to
authoritative confirmation, replay, Undo and lost-CAS path. The local full suite
passes 365 suites / 4718 tests with types and production build. AI-enabled browser
fixtures separately exercise job switching and successful explicit/background
legacy recovery; hosted execution is required before they count as browser passes.
All transports in this evidence are synthetic. No provider activation, paid call,
production SQL activation, new credential, permission or capture geometry changed.
The canonical A17 live funded discovery/scheduled-run evidence and real AI quality
acceptance remain open; this bounded parity does not close those release gates.

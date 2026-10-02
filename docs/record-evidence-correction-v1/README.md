# Record evidence correction

Base: main `40382632`. Status: candidate; exact-head CI, browser evidence and review required before publication. This change contains no production business-data edits or private source fixtures.

## Approved behavior

Jobs uses eight exclusive filters: 全部, 待投递, 已投递, 收到笔试, 收到面试, 流程结束, 时间截止, 无截止日期. All retains every opportunity. Applied progress wins over application expiry; assessment is not silently relabeled written test; AI interviews are interviews; a legitimate Offer is a distinct result within Process ended. Unsubmitted future dated, expired/closed, and unknown-date jobs are separate. Disputed process stages remain in All with an explicit verification label. An abandoned job with no positive application evidence is not represented as an expired or completed application.

The Calendar unknown-deadline group uses the same projection, including jobs without a ScheduleNode. It creates no artificial node, date, completion or reminder. Historical undated completions remain separate.

## Safety boundary

- Mail matching cannot join a location and another name across punctuation. Multiword company/role identity remains supported. Generic year/cohort recruiting labels cannot supply specific role evidence.
- Recruitment procedures, hypothetical/third-party/negative statements and marketing mentions are not direct outcome evidence. Mail needs a real assertion; user-authored progress shorthand retains its separate explicit-input contract.
- Interpretation failures, including fragment/body bounds, hold business-changing candidates at the shared Gmail batch boundary. Accounting a source as unresolved is not permission to commit a prefix.
- `invalidate_process_event` requires exact terminal event, source receipt, per-fact mutation ownership and the reviewed event timestamp. It appends an invalidation and correction receipt, retains the original record, blocks replay of the revoked source fact, and changes only projections still owned by that event. Remaining valid event evidence is reprojected; absent a supported prior stage, durable `unknown` is displayed as 阶段待核实. Later independent/manual progress is retained. Legacy evidence lacking ownership fails closed.
- New process-event Undo captures exact stage/projection ownership. It cannot overwrite later edited projection state; independently replaced projection owners are retained. Old receipts without ownership cannot delete a still-effective event and leave stale terminal mirrors behind.
- `correct_application_deadline` is limited to active, confirmed-unsubmitted opportunities. All owner data is compared exactly through a bounded canonical comparison token, followed by the existing transactional workspace CAS. Submitted/ambiguous records and completed history are protected.
- Deadline corrections record source authority, URL, verification time and bounded evidence. Weak evidence cannot replace explicit user/official owners. Set/clear updates unfinished application actions and appends ScheduleNode versions. Old times remain historical; unknown creates no replacement appointment/reminder. Later explicit canonical reschedule/set/undo follows the same authority, rather than a parallel override.

## Supported read/write surfaces

The existing authenticated `apply_user_command` exposes the two bounded corrections. It uses the same domain reducer, command ledger and workspace compare-and-swap as ordinary explicit commands. There is no direct SQL or unrestricted patch endpoint.

Existing `get_workspace_integrity` adds a read-only canonical expired/closed-unsubmitted audit with total/truncation counts, source URLs, node/action IDs, application protection and exact comparison tokens. `list_opportunities(includeFacts=true)` adds bounded deadline and process-fact audit details. Plugin catalogs that cache old tool schemas need the supported refresh/authenticated route before writes can be issued; an old reviewed posting-refresh command is not substituted for this correction.

## Verification record

The first prevention fixture produced 12 failures on the base. Synthetic regressions cover conditional/general offers, punctuation and year-role identity collisions, multiword identities, truncation, audit-preserving correction, stale ownership, repeat/replay, later independent events, stage Undo, all eight categories, source timezone/date-only boundaries, legacy date clear/set, stronger source protection, exact workspace CAS, and correction-to-set/undo/reschedule coherence.

At an intermediate checkpoint, all 221 unit files / 1,262 tests, TypeScript and a production build passed. Final counts are recorded after the final candidate is frozen. The new real-browser journeys exercise desktop/mobile categories, correction history, routed detail, reload, Calendar unknown dates and atomic stale-correction refusal. The full Browser and Firefox/WebKit Matrix gates include these journeys.

Local Chromium cannot launch in this executor because its socket operation is denied, including after a permitted escalation retry. Those attempts did not execute browser assertions. Remote CI must supply the actual browser results and pixels; no local browser pass is claimed.

## Follow-up safety checkpoint

After the first published candidate, independent review verified all prior parser,
set/undo/reschedule and timezone repairs. The next local checkpoint additionally:

- attributes a corrected date to its actual verified source, and a later user date
  to user command evidence rather than an invented website URL;
- permits lower-authority published fallback dates where no stronger owner exists,
  while retaining stronger explicit evidence and confirmed-closed availability;
- prevents ordinary event deletion or source Undo from erasing invalidated audit
  records, and prevents old deadline Undo from overwriting a newer correction;
- retires obsolete reminder intents using the existing cancellation outbox;
- reports protected submitted/ambiguous expired owners separately in the read audit.

Local verification: 221 unit files / 1,267 tests and TypeScript passed. This checkpoint
still requires source review and exact-head remote gates. The GitHub plugin began
returning HTTP 401 on both artifact and harmless repository reads at 08:54 UTC, so
this follow-up was not published and no merge/deployment/data correction occurred.
The last published candidate remains PR215 at `14f139e50c84f4cc7dbab849bb7a7a3146af2b51`.

## Browser compatibility correction

The first full remote run at `14f139e` passed 180 Chromium cases and 184
Firefox/WebKit cases, but exposed three stale expectations and one related UI
regression: undated unsubmitted fixtures now belong to No deadline, and the new
Schedule shortcut accidentally revealed past diagnostics in Upcoming. The
follow-up keeps those diagnostics hidden in Upcoming and preserves the new
unknown-deadline shortcut. Existing quota/localization/past-history assertions
remain, with explicit separation assertions added; no fixture or gate is removed.

After the follow-up source changes, local verification again passed all 221 unit
files / 1,267 tests, TypeScript and the production build. GitHub access recovered;
the final remote browser gates and independent source review remain required.

Independent review additionally found and reproduced fallback-source upgrade,
Undo provenance/ownership, and old-version reminder cancellation gaps. The final
batch restores source provenance via appended versions, compares exact Undo
owners, distinguishes independent identical-date commands from repeated asserted
source facts, permits stronger fallback evidence, and withdraws reminders across
all versions of a corrected occurrence. Regression coverage retains the existing
Gmail replay/receipt recovery contract. Final local verification: 221 unit files /
1,270 tests, TypeScript, and production build. Remote exact-head gates are pending.

## Dense projection performance follow-up

At remote `55b0f3a`, Chromium passed 183 core + 67 dense cases; Firefox/WebKit
passed 186 core + 134 dense cases. The Matrix's final performance step detected
reschedule acknowledgement p95 of 113 ms against the retained 100 ms budget
(settled 130/150 ms, durable 7/100 ms, no command long tasks). No gate was relaxed.

The unknown-deadline projection had repeated whole-history/owner scans for each
job. A projection-local owner index now partitions the exact records read by the
unchanged classifier once. It retains per-owner order, never mutates source data,
and introduces no persistent or cross-account cache. Differential tests compare
all categories and resolved deadlines in dense and corrected workspaces. Local
50-sample dense Schedule projection measurements improved from approximately
51 ms median / 70 ms p95 to 38 ms / 45 ms; these are CPU projection observations,
not a substitute for the exact-head real-browser acknowledgement gate.

Local follow-up verification: 221 files / 1,272 tests, TypeScript and production
build passed. Independent review found no correctness issue; 7,680 differential
category/deadline comparisons across 20 modified dense snapshots passed. Remote
exact-head browser/performance verification remains required.

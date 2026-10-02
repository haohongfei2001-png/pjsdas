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

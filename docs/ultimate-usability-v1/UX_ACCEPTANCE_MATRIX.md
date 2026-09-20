# Ultimate Usability v1 — UX Acceptance Matrix

## Hard product gates

- Five-second next-action comprehension on representative scenarios: target ≥90%.
- Next hard schedule node identified without navigating away from Today: target ≥95%.
- Facts satisfying the auto-write contract should avoid second confirmation: target ≥95%.
- Median manual maintenance actions for already-covered facts: 0.
- No Attention=0 / empty stats / latest-sync filler on daily surfaces.
- 390×844 default type shows full next action + at least one upcoming node.
- Mac/iPhone share business semantics while using platform-appropriate navigation.
- Wrong account/opportunity/occurrence automatic write: release blocker.
- Time elapsed may never imply completion without evidence.
- Date-only must never become source-claimed 23:59.
- Replay may not create duplicate facts.
- UI may not report durable success before receipt/persistence.

## Performance targets

- input accepted feedback p95 <300 ms;
- cached Today usable p95 <1 s;
- online fact to durable receipt p95 <5 s;
- committed change visible to another online client p95 <5 s;
- Gmail normal path target p95 <2 min from readable message to visible business projection;
- compensation target ≤15 min for missed push notifications.

## Accessibility

- text contrast ≥4.5:1;
- primary targets ≥44×44;
- visible focus;
- VoiceOver/screen-reader semantics;
- keyboard access;
- Reduce Motion;
- large-text layouts;
- state not encoded only by color.

## Golden journeys

G01 unique “written test completed” → one atomic fact, waiting result, no second confirmation.  
G02 Gmail + GPT same completion → one event, multiple evidence refs, one follow-up.  
G03 same company two roles → ask which role, write neither first.  
G04 two interview rounds → distinct occurrences, future round stays active.  
G05 “I plan to do assessment tomorrow” → user plan, not employer deadline.  
G06 “deadline Tuesday” → date precision preserved, no fake 23:59.  
G07 employer reschedule → same occurrence new version, reminders/conflicts recalc.  
G08 old mail arrives late → no process/time regression.  
G09 explicit rejection → close only matched process.  
G10 posting closes after interview → posting closed, process remains active.  
G11 explicit internal abandonment → owner-amended direct internal update + Undo when safe.  
G12 rewrite/example text → no business write.  
G13 “interview ended, felt average” → completion + subjective note, no rejection inference.  
G14 relative date replay → resolve from original message time/timezone.  
G15 node time passed without evidence → elapsed_unresolved.  
G16 exam starts in 10 min + 40 min prep → join/check wins.  
G17 two overlapping events → concrete DecisionRequest.  
G18 empty 7-day window + interview in 20 days → show next known node, no empty calendar.  
G19 archived Gmail within supported coverage → still discovered.  
G20 pagination/CAS/history reset → no missed consumption; safe recovery.  
G21 one mail with test window + submission deadline → preserve distinct temporal semantics.  
G22 decisive attachment unsupported → explicit coverage gap, no invented time.  
G23 response lost after commit → same command receipt, no duplicate.  
G24 phone offline input + Mac unrelated update → safe merge, no stale snapshot overwrite.  
G25 undo after unrelated update → compensating field/object write preserves unrelated data.  
G26 undo with dependent decisions → explain impact, do not blindly revert.  
G27 external task fired/paused/deleted → does not imply recruiting completion.  
G28 external task lacks pause permission → state capability truthfully.  
G29 Gmail auth expired + Today empty → warn coverage may be stale.  
G30 background update during editing/detail → draft/route/scroll/focus preserved.  
G31 malicious email instruction → no permission expansion / external action.  
G32 account switch → no cache/draft/source/notification cross-account leakage.  
G33 real interview tomorrow + unknown fit score → committed event stays protected.  
G34 many newly discovered jobs → Opportunity pool grows without flooding Today.  
G35 large text/screen reader/reduced motion → complete reachable journey.  
G36 DST ambiguous fixed event → explicit timezone resolution or clarification.

Every golden journey must assert:

- durable post-condition;
- user-visible language/state;
- source accounting;
- notification/outbox effect when relevant.

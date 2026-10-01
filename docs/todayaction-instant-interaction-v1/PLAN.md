# TODAYACTION-INSTANT-INTERACTION-v1

## Bounded scope and baseline

GitHub main verified at ae3b4e57365439ffda074c30780e2cc12687fdd7, tree 562a5acc77975531e6c31ab0ac79c58f29398418. No open PR. Single writer; prior PCR/ZMC packages stay closed. No production workspace writes, owner profile changes, paid plan changes, or new external authorization.

Production read-only aggregate: revision 1204; JSONB text 4,574,542 bytes; actions 320, decisions 346, schedule nodes 276, timeline 3940. Twenty-four-hour existing traffic: workspace read avg 860ms/p95 1345ms; user lookup avg 478ms; grant lookup avg 532ms; commit RPC avg 6036ms/p95 9465ms. These are different request families and include upstream transport; they are not a per-click trace.

## Delivery gates

- Stable command identity and durable, account-scoped outbox plus exact optimistic entity projection.
- Immediate completion/submission/capacity/occurrence operations and Undo, with independent operations accepted while earlier confirmation is in flight.
- Compact ordinary command and receipt responses, affected entity/field preconditions and read-model invalidation. Full snapshots restricted to requested recovery/read paths.
- Incremental IndexedDB transactions and selector updates; historical audit never cloned on the interaction path.
- Receipt-first restart recovery; precise business rejection rollback; conflicting fields fail closed; original command provenance retained.
- Dense synthetic browser budget: acknowledgement p95 <=100ms, settled p95 <=150ms, durable outbox p95 <=100ms, no ordinary-command long task >50ms. Compare shorter and 3900+ row audit histories.
- Full unit/type/build, Chromium Browser, Firefox/WebKit Matrix, performance, independent review, exact-head CI and exact-main deployment/readback.

## Phase A / Phase B

Keep authoritative snapshot storage and existing CAS/ledger/security. Project the commit RPC response with PostgREST select to avoid returning JSONB again; use the already evaluated snapshot for COMMITTED. Compact receipt lookup reads the ledger without a workspace fetch. Preserve online identity and grant checks on every request; no authorization TTL or stale grant acceptance. Profile before considering additive entity storage; no unmeasured database rewrite.

## Red before

A warmed synthetic owner workspace with a delayed 3s command took 4013ms to show the changed Today capacity, failing the 150ms settlement gate. Evidence retained outside the repository with the package receipts.

## Implementation decisions

- IndexedDB v13 journals exact original commands, optimistic entity preimages, dependency identities and projection proofs. Outbox and affected stores commit atomically; the existing account-scoped mirror supports crash-window recovery.
- Confirmations settle only affected fields, including compact-delta omitted-field preservation and server-clock differences. Related queued edits overlay earlier confirmations; rejection unwinds dependent edits atomically in dependency order. Genuine unrecorded field edits stay intact.
- Ordinary receipt recovery checks the ledger before sending anything. Confirmed-but-blocked projection uses an explicitly requested read-only full snapshot; a business outcome never becomes unknown because local projection fails.
- Consumer read models retain immutable historical evidence without cloning its multi-MB payload. Only changed arrays receive new references; connected hot operations emit one incremental event and avoid workspace replacement/manual reload.
- Optional timing events contain timing/payload byte counts only: durable outbox, IndexedDB write, Today/Schedule selector, RTT and server execution. Responses expose Server-Timing; compact receipt lookup fetches ledger only. Every request still performs online identity and authorization checks.

## Review corrections

The first independent read-only review found three correctness issues: unchanged commands leaving permanent pending entries; rejection under later dependent optimistic edits; and a confirmed blocked delta having no snapshot recovery route. The no-op finding was resolved by confirming explicit saves against authoritative state, including when the local projection is unchanged; empty acknowledgements retire their outbox entry. Dependent rollback and snapshot recovery were repaired and covered by browser regressions. Additional regressions cover differing server clocks, Undo before confirmation, Undo journal crash before the local transaction, and safe projection recovery after equivalence returns.


## Local verification before PR

- 210 unit files / 1135 tests passed; type check and production build passed.
- 24 Chromium command/recovery cases passed before the additional three-dependent-edit ordering regression.
- Dense performance: capacity acknowledgement p95 43ms / settled 59ms; completion 68ms; Undo 48ms; durable outbox 10ms. Submission settled 64ms, complete occurrence 64ms, cancel 61ms, reschedule 55ms. No long tasks >50ms. 100-row versus 3940-row capacity settled 54ms versus 59ms.
- A further independent review found explicit-save suppression and legacy verification scripts depending on snapshots. Explicit saves now always journal and confirm; integrity canaries explicitly request their compatibility snapshot contract. No production canary was executed.
- Background refresh defers full read/fingerprint work while ordinary commands are unresolved; existing persisted conflicts still reclassify at current authoritative revisions. Today and Schedule share the producer-normalized snapshot without cloning; only selectors needed by the current surface run. Timezone validation and formatters use bounded caches.


## Final review recovery corrections

- 401/403 preserve stable durable intent and optimistic local state; reconnect/sign-in recovery checks receipts before retrying the original identity. Authentication failure is distinct from definitive business rejection.
- Completion feedback is command scoped; unrelated capacity/schedule rejection gets a compact separate notice and preserves completion Undo.
- Verified operational proof deltas compact at a 64-row threshold under metadata/proof locks with captured sequence checks. Original journals and business/audit stores remain intact. Diagnostics keep read-only classification by default.
- The hot command journal uses an account/state index and direct identity lookups; retained confirmed archives are not loaded for ordinary clicks. The additive v13 migration also upgrades any preview v12 store.

## Final local gates after review repairs

- Full 1135 unit tests and type check passed after journal-index, projection-proof and readonly-history repairs. Dense recovery 21 cases passed; connected Schedule/offline/restart and cancellation-with-genuine-edit regressions passed.
- Final production build performance passed both formal suites: 4.44 MB / 3940 timeline rows, capacity acknowledgement p95 29ms and settled 44ms; completion and Undo settled 32ms. Submission/complete/cancel/reschedule acknowledgement p95 32/30/29/27ms and settled 40/46/46/45ms; durable p95 18/14/13/12ms. No observed command long task exceeded 50ms. Short history and dense history capacity settled p95 were both 44ms.
- Existing browser expectations now distinguish immediate durable optimistic state from later server confirmation. Exact command identity, authoritative outcome, reload audit equality and conflict retention assertions remain in place.
- Final cloud exact-head gates and the fresh independent read-only review remain required before merge; this local receipt is not package closure.

## Account-boundary review correction

Recovery exports and journal read APIs are restricted to the current synchronous account lease. Retained confirmed and unresolved journals remain quarantined for their original account; switching or signing out clears only the derived proof chain along with the pre-existing active workspace cache. Other/anonymous accounts cannot export prior command payloads or preimages. An account-boundary browser regression verifies no cross-account export and exact journal retention on return. The checked-in generated release fallback remains unbound; build-generated identities are never committed. VoiceOver preparation uses Node 24 and one bounded macOS Focus-setup retry; the real screen-reader journey is still required.

## Background-read race correction

A full refresh can start before a click and resume after its outbox reservation. Hot intent is now journaled before the first asynchronous journal lookup. Background reads recheck pending after local export, network response, and before expensive fingerprint/validation/proof work; an arriving ordinary command defers the read without creating a business conflict. Existing genuine persisted conflicts still refresh classification against current remote state. An asynchronous-export race regression verifies no subsequent remote read or projection. Performance evidence records command/Undo time windows plus all long-task timestamps; the 50ms command gate is unchanged.

After these repairs, 22 dense Chromium safety cases and both production-build performance suites passed locally. Dense capacity acknowledgement/settled p95 29/44ms; completion/Undo 32ms; submitted/complete/cancel/reschedule acknowledgement p95 27/27/38/27ms and settled 42/44/54/42ms. No command long task exceeded 50ms. Exact-head cloud and fresh independent review are still required.

## Frozen-runtime gate alignment

Schedule Undo now checks its original journal by direct account/command identity; retained archives are not scanned. Background IDB export checks the read lease after asynchronous store reads and before full clone/validation; proof verification also rechecks its guard before serialization. Account-return polling retries only the expected lease-invalidation transient and still requires the exact preserved title.

Dense latency/recovery journeys use `playwright.instant.config.mts`: production React runtime with source-module probes, no video encoder, failure screenshot/trace retained. The development StrictMode safety suite remains complete and mandatory, followed by the separate dense runtime suite in Chromium and Firefox/WebKit. The fully built/minified artifact performance suite remains mandatory. Original 100/150/100/50ms gates are unchanged. This separates intentional development render duplication from consumer performance without dropping a test.

Local final receipt: 1136 unit tests/type check, 44 production-runtime Chromium/WebKit dense safety cases, 13 account-race cases and both built-artifact performance suites passed. Latest domain settled p95 38/46/46/45ms, with no command long task above 50ms. Native local Firefox cannot open its temporary profile; the pinned cloud Firefox container remains the mandatory platform gate.

## Compensation and proof-order review corrections

A fresh independent review found user Undo incorrectly using a raw inverse. Submission compensation retains a newly created Process and resets its stage/progress; capacity compensation retains materialized preferences. A new browser regression failed before the correction because the local Process had been deleted. Undo now runs the same domain compensation on the bounded object closure, retaining original timeline and provenance. Compact authenticated receipts carry exact compensation evidence for supported hot commands, including authoritative clock values; restart reconstruction uses the same path. Definitive rejection rollback remains the exact inverse of an unaccepted local change. Captured whole-node compensation rejects genuine edits to otherwise unchanged node fields.

Cloud Firefox exposed an order-sensitive comparison after derived proof compaction. Both empty-proof and accumulated-proof comparisons now normalize unique-ID collection order and require exact facts/audit. Compaction stores that same normalized canonical proof. The browser regression deliberately reverses captured action/node order before compaction, then verifies the new baseline and genuine-edit refusal.

Local correction receipt: 210 unit files / 1142 tests and type check passed; 48 dense Chromium/WebKit cases passed, including submission without an existing Process, server-clock differences, receipt/restart recovery and capacity without existing preferences. Full final exact-head cloud gates, built-artifact budgets and fresh independent review remain required.

## Deterministic full-suite fixtures

The complete cloud safety suite ran near UTC midnight. Several older Today fixtures implicitly expected 30-minute tasks to fit the day while fewer than 30 physical minutes remained. Those scenarios now fix Date at a known fixture work window; animation frames, timers, measurements and all business assertions remain unchanged. Explicit deadline/planning tests retain their own clocks. Restart and second-client pages use the same fixture clock. Legacy response-loss/history mocks now return exact domain compensation evidence and use the actual compensation kernel instead of a manual status-only Undo.

The real VoiceOver Schedule journey repeatedly stalled in the OS-wide Item Chooser before entering web content. It now brings the cloud test page forward and aligns the actual VoiceOver cursor to the same keyboard-focused node. Detail focus is asserted before cursor alignment; all real spoken-node/title/date/heading assertions remain mandatory. No local visible browser or owner profile is involved. Fresh final cloud gates and review certify these harness corrections.

## Recovery checkpoint review correction

The next full independent review found that successful explicit snapshot recovery installed the authoritative cache without advancing its account checkpoint. A new red-before browser assertion observed txn:1204 after recovering txn:1205. Recovery now records authoritative and materialized fingerprints plus the current version before retiring the confirmed intent, with account and monotonic-version guards. A subsequent immediate edit to the same object uses baseRevision 1205 and survives reload. Chromium/WebKit recovery regressions, all 1142 unit tests and type check passed. An additional near-midnight presentation fixture now uses the same known physical work window; its original stored-fact and localized-label assertions pass.

The preceding cloud head passed all three real VoiceOver scenarios and its core Firefox/WebKit routes. Its complete Browser suite found only that remaining clock-sensitive presentation fixture. The final head must still pass every complete gate and a fresh independent review before merge.

## Failed-local-intent quarantine and bounded Today history

The fresh review identified a journal-read failure before atomic local persistence: the failed click's mirror could later replay. The reservation/read/write failure window now archives rejection before removing its mirror, or retains a closed conflict mirror when archival is unavailable. Known server rejection also remains closed if rollback/read/archive fails, including dependent intents; recovery and queued dispatch respect that durable quarantine. Eight Chromium/WebKit fault regressions passed, preserving original command identities and preventing replay across reload.

Two legacy browser scenarios now distinguish optimistic UI settlement from subsequent receipt recovery before asserting receipt counts or introducing a later authoritative edit. Their original no-duplicate-command, Undo and unrelated-fact assertions remain unchanged.

The exact-head cloud performance suite found two 51ms tasks on dense Today. Today now reads only current-day completion evidence through a bounded cached view, maintained by changed timeline IDs. Full audit remains intact; the full Schedule/history view is unchanged. Capacity changes reuse the unchanged schedule projection. Current-day rollover and historical-row updates are covered. Built-artifact local dense p95 acknowledgement/settlement is 28/44ms, completion/Undo 32ms, durable write 12ms, with no >50ms task. Final exact-head cloud gates and independent review remain required.

## Comprehensive recovery review corrections

A fresh full-package read-only review reproduced six defects. Settlement now walks the transitive command/Undo dependency closure. Confirmed parents retry compact receipts before snapshot fallback, avoiding a pending-child deadlock after a transient projection failure. Definitive rejection with failed rollback retains a durable `rollback_pending` disposition/root and invalidates optimistic projection trust until precise rollback succeeds; related quarantined predecessors are terminal for dispatch, while independent paused intents resume through receipt-first recovery. Undo preparation archives a rejected tombstone before removing its mirror. Missing-journal crash reservations check receipts before requiring local entities, and only a fingerprint-proven account-cleared empty cache can hydrate through a guarded authoritative read. No genuine edits are overwritten.

Seven new dense browser regressions exercise those six findings, including command and Undo reservations across synthetic cache clearing. All 68 Chromium/WebKit dense cases passed. An additional realistic clock-separated child-rejection regression failed before correction because it restored an optimistic parent timestamp; rollback now retains the confirmed predecessor's field evidence. The complete audit, command identities, receipt recovery and account-scoped journal remain retained.

VoiceOver web entry uses the actual keyboard-focused web control rather than the OS Item Chooser on every route, keeping all spoken-context assertions. The cloud runner's Item Chooser hung until its VoiceOver fixture timed out and stopped the service; this replaces that unstable setup path without weakening screen-reader verification. No local owner browser was opened or changed. Final frozen-head full cloud gates, strict performance and a new independent review remain required.

## Final dependency recovery and compact ordinary-client corrections

The next comprehensive read-only review reproduced seven concrete defects. Mirror reservations now retain original entity preimages and parent identities before any asynchronous preparation; missing journals cannot infer ownership from a genuine newer local edit. Proven cleared-cache recovery reads receipts first and installs the authoritative baseline, all retained overlays and their journal dispositions in one transaction. Confirmed parent fields are rebased without discarding unconfirmed children. Rollback obligations participate in predecessor ordering; failure archives only the rejected dependency closure and preserves independent commands. Compact replay metadata describes the original receipt revision, with client validation against its delta. Snapshot compatibility responses cannot replace outstanding optimistic intent.

Ordinary domain commands through the legacy client now also request compact deltas and patch only affected stores, preserving unrelated optimistic interactions. Receiptless ALREADY_APPLIED facts that cannot safely project remain confirmed and recover by read, without repeating their command. Settings daily capacity and work windows share the immediate durable kernel. VoiceOver enters the surviving modal after save removes its focused button; all original spoken receipt assertions remain mandatory.

Type check and 1145 unit tests passed. The local complete Chromium/WebKit run passed 86 cases; two snapshot-compatibility fixtures incorrectly included a modern top-level delta, so they exercised successful compact projection instead of the expected blocked legacy snapshot. Corrected old-server-only responses and both modern compact scenarios passed all six targeted cases with their original state preservation and no-resend assertions. Frozen exact-head complete cloud suites, strict built-artifact performance and a fresh full independent review remain required before merge.

Final repaired production-build performance passed both formal suites: dense capacity acknowledgement/settlement p95 28/43ms, completion/Undo 32/33ms, durable 12ms. Submitted/complete/cancel/reschedule acknowledgement p95 29/27/31/25ms and settlement 45/43/47/42ms, durable 5/13/14/11ms. No observed command long task exceeded 50ms. The 100-row history capacity settlement p95 was 45ms versus 43ms for 3940 rows; the dense workspace serialized to 4,440,392 bytes. Exact-head cloud and fresh independent review remain required, followed by exact-main isolated production readback without business writes.

## Multi-layer cache recovery and legacy receipt postimages

The subsequent fresh review reproduced two remaining recovery deadlocks. Three queued edits now rebase in dependency order against progressively reconstructed pending parents, preserving the intermediate preimage. Fingerprint-proven cleared caches hydrate before a known rollback obligation attempts its inverse; the rejected command stays rejected and is never resent. Both new browser regressions failed before repair and then passed in Chromium/WebKit, together with two-layer recovery and legacy-snapshot protection (10 cases).

The complete cloud Browser suite found four legacy snapshot Undo failures. A supplied COMMITTED/ALREADY_APPLIED response is already confirmation evidence and does not trigger another receipt query. Only a snapshot at the exact matching command receipt revision can bind owned postimages to authoritative timestamps/provenance; a newer current snapshot cannot replace the original ownership guard. The lost-response, history detail completion, application submission and exact occurrence Undo scenarios all failed before correction and passed afterwards with their original assertions and unchanged fixtures.

Type/unit remained green (1145 tests). All three final production-build performance suites passed: dense capacity acknowledgement/settlement p95 26/43ms, completion/Undo 31/31ms, domain settlement 37–46ms, durable p95 ≤14ms. The new confirmation gate measures 20 actual compact command/Undo acknowledgements and reconciliation after their RTT: maximum response 5321 bytes and no command long task >50ms. Original audit and stable unique identities are asserted. Full new exact-head cloud suites and another independent review remain required before merge.

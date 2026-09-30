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

- IndexedDB v12 journals exact original commands, optimistic entity preimages, dependency identities and projection proofs. Outbox and affected stores commit atomically; the existing account-scoped mirror supports crash-window recovery.
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
- Background refresh defers full read/fingerprint work while ordinary commands are unresolved; existing persisted conflicts still reclassify at current authoritative revisions. Today and Schedule share one normalized snapshot per render to avoid duplicate entity cloning.

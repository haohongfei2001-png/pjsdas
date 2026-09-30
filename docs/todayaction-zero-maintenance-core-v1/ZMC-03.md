# ZMC-03 — Durable command outbox and receipt recovery candidate

## Product behavior

A connected user operation is stored with one stable command ID before offline submission. The account outbox records the original business command and its verified base revision. On reconnection or account restoration, recovery asks for the server receipt first, then retries that same command ID only when no receipt exists. The server's idempotency and object-aware rebase handle independent newer changes. A confirmed command whose latest snapshot cannot safely project locally remains confirmed and waits for safe cache recovery. Independent commands can continue; the server decides genuine same-object conflicts.

Offline capture, action status, application submission, and schedule complete/cancel/reschedule now use this outbox. Capture presents a pending state and resumes automatically. The outbox requires an account-bound, verified cache; local-only edits and account switches fail closed. An unreadable outbox is retained rather than silently replaced.

## Red-before evidence

- The existing browser journey explicitly asserted that offline capture remained only a draft with zero command requests. That behavior violated the durable offline command invariant.
- The existing command-client test explicitly asserted that an earlier committed operation with blocked local projection rejected a second independent occurrence operation before journaling.
- A server `CONFLICT` response whose snapshot could not project locally passed into unknown-outcome recovery rather than preserving the known business conflict.
- Independent review reproduced three further consumer failures: an offline capture that recovered as `DECISION_REQUIRED` hid the decision entry; a conflicted schedule operation was falsely labeled queued; and a queued reschedule reopened with the old date, blocking confirmation of its original command.
- Focused review then found that the new schedule notice disappeared when the server made the occurrence inactive, could show an unqueued date while the input was being edited, and described a server-confirmed command as unsent. The notice is now derived from the persisted command and shown beside the occurrence regardless of whether action buttons remain available.
- The final visual gate exposed an offline race: background sync could ask for outbox replay after the browser went offline. A separate review found that successful replay with normal refresh disabled did not update Settings status, and a recovered action still showed a queued toast. Replay now stops while offline, updates account status on completion or error, and settles the action feedback from its actual receipt.

## Green-after regression

- Unit cases verify offline queue without a network call, original base revision and command ID across restart/replay, remote revision advance, account binding, local-only edit preservation, changed-payload rejection, independent command continuation, same-object conflict classification, receipt-first recovery, and no duplicate send after committed receipt.
- The connected browser journey now asserts an offline capture outbox record, no offline network write, independent remote update, a real page reload while the server remains unreachable, exactly one recovered business command with the original ID, outbox retirement, and consistent local state after another reload.
- A connected schedule browser journey now queues a changed date offline, reloads while the server is unavailable, displays the original queued date, and replays the original command once after reconnect even when ordinary automatic refresh is disabled. Conflicted schedule commands are surfaced as conflicts rather than promised automatic submission.
- Existing receipt/projection cases cover completed, cancelled, and rescheduled occurrences, receipt found/absent, `NO_WRITE`, and safe projection retry. Final full tests, Browser, Matrix, independent review, merge, and exact-main readback remain required.
- Before the final offline-race repair, 208 test files and 1,086 tests passed, with TypeScript and production build passing. Headless Chromium and WebKit targeted browser journeys passed locally. Final full CI, Browser, Matrix, VoiceOver, and exact-head review remain required.

No production business record, Gmail cursor, OAuth scope, or owner browser profile was mutated in this phase.

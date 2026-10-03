# Live preparation/recovery race and deterministic owner fixture

## Retained failures

- Exact main `5a35fad6`, Browser E2E run `37078786302`, artifact `11258192089`: both owner interaction recovery scenarios failed twice at their initial `A第一任务` heading. The trace at `2026-10-02T23:44:42.461Z` contains the expected authoritative snapshot with both20-minute tasks; the UI correctly shows no task because fewer than20 minutes remain in the UTC day. Source reproduction selects the heading at12:00 and23:39, and selects zero actions at the trace time. These synchronization fixtures did not set their clock or timezone. Pinning UTC/noon changes only the fixture, preserving product-day semantics and every assertion.
- PR233 head `f6416996`, Matrix run `37077813392`, artifact `11257764292`: 134 dense journeys and the capacity/domain performance budgets pass, but compact confirmation captured21 network metrics for20 unique successful commands. The trace's extra15-byte response is `{found:false}` for the first Undo receipt lookup before the actual Undo request. The20 write IDs remain unique; this is not a duplicate server write or a long-task failure.

## Deterministic reproduction and repair

Undo publishes a synchronous pending mirror before awaiting its parent IDB record and persisting its own journal/projection. Background recovery could interpret that live gap as a crash, query a nonexistent receipt and race the original local preparation. A held-IDB unit regression fails on the baseline by observing that receipt request, then passes with the repair.

A temporary in-memory account/command marker covers local preparation through registration of the deferred normal dispatch. It is removed on failure or by that dispatch timer. Recovery skips a currently live preparation and shares an existing dispatch flight. It does not authorize data, change persisted states, suppress a later reconnect or survive page restart; existing receipt-first crash recovery remains intact.

The action regression verifies marker release before a later reconnect. The held-IDB Undo regression verifies no request or early projection during preparation. The browser regression exercises the same gap using the real IndexedDB adapter and records receipt lookups independently from writes. Existing performance thresholds, sample counts, metric labels and retry policy are unchanged.

## Scope and verification

The owner fixture correction only pins test time and timezone. No UI, business-day rules, capabilities, live grants or external calls are added. Run full existing tests, exact-head SQL and browser/performance checks, then exact-main and production verification before adoption. Retain both failures even after a passing candidate.

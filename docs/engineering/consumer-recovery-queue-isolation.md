# Account recovery: isolate queue failures without reordering writes

This is a consumer-client correctness repair on the published row-candidate
source tree `ac6fb4bd3917ddfe8ab7afc05a11d39ddbf143f0`. It does not enable row
storage, durable-v2 admission, any new command family, or production access.

## Reproduced failures

- A pending ordinary command at the head of the account outbox could fail its
  receipt lookup or receive a permission denial on retry. Every later sweep
  stopped at that same item, even when a later command already had an authorized
  committed receipt ready to reconcile.
- An account A -> B -> A transition during an asynchronous instant-client import
  or serial dispatch wait could let an old sweep acquire the returning account's
  new lease. Detecting the old generation at the end of the sweep was too late.

## Preserved boundaries

The first item error now changes the rest of that sweep to **receipt-only**
recovery. It can read authorized receipts/current projections and reconcile
existing local terminal facts, but cannot send a later command or Undo whose
receipt is absent. Original command IDs, envelopes, drafts and unresolved
optimistic overlays remain durable. The first error is still returned to the
caller, so the scheduler does not report the whole queue as synchronized.

Instant recovery applies the same restriction to prepared-dispatch timers,
ordinary journals and missing-journal mirrors. An absent receipt is not a
noncommit proof and does not authorize reconstruction or replay during the
receipt-only sweep. Existing dependency-safe projection/rollback rules remain
unchanged. A later fresh recovery can still use the existing normal retry path.

The original account generation is checked after dynamic import, at serial
dispatch admission/execution, before network work, and after awaited receipt or
projection work before publishing recovery events. A changed lease aborts the
whole sweep rather than being treated as one failed item. Dispatch retains a
Promise rejection boundary so a sign-out cannot turn a prepared timer's rejected
lease into an uncaught synchronous callback error.

## Acceptance scope

Unit regressions cover queue-head denial, receipt transport/permission failures,
mixed ordinary/instant queues, absent receipts, missing journals, paused timers,
original drafts/IDs, A -> B -> A import/dispatch races, sign-out and stale
projection notifications. These tests use storage and transport doubles; they
exercise the client/replay modules used by automatic recovery, not a mounted
consumer UI, real IndexedDB, or real PostgreSQL.

Nine targeted new assertions fail against the unchanged baseline runtime and
pass with this repair. Exact-candidate checks must be reported separately;
neither that red/green result nor earlier native/IndexedDB gates certify the
new candidate's complete browser path. Existing full-v2, hosted fallback,
browser-to-PostgreSQL, old deadline/long-task attribution, production ACL,
physical-storage and activation gates remain open. No test timeout, retry
policy, resource budget or production configuration is relaxed here.

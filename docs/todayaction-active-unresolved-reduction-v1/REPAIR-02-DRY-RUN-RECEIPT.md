# AURR v1 Repair 02 Dry-Run Diagnostic Receipt

Package: `TODAYACTION-ACTIVE-UNRESOLVED-REDUCTION-v1`

Repair: `gmail_fragment_limit_reprocess`

Exact runtime main:

`63a3e1f2bc54051cfc087fdeb9ad0510de9a8b12`

## Production read-only dry-run

Request id: `1125`

Workspace revision:

- before: **646**
- after: **646**

Timeline rows also remained **3112** before and after. The request therefore performed no transactional workspace write.

HTTP result:

- status: **200**
- timed out: **false**
- processed Gmail bindings: **1**
- failed bindings: **0**

Aggregate reprocess result:

- targeted legacy 20-fragment active records: **60**
- fetched: **60**
- unavailable: **0**
- parser complete under the new bound: **45**
- records still carrying parser gaps: **15**
- records still exceeding the new 80-fragment ceiling: **5**
- projected settled active debt: **0**
- active unresolved before: **163**
- projected active unresolved after: **163**

The parser state aggregate returned `NO_ACTION=6`, `ACTION_REQUIRED=1`, `UNRESOLVED=21`; seven semantic receipts were `decision_required`. The dry-run projected seven reconciliation outcomes as `active_unresolved` and no non-active resolution outcome.

## Diagnosis

The zero-settlement result is not evidence that the wider fragment parser has no value. The dry-run proves that **45/60** target records can now be parsed without the old bounded-fragment failure, but the replay adapter still carries the historical unresolved outcome forward.

In `applyGmailSemanticBatch(..., reconcileExisting=true)`, a prior unresolved ingestion record currently forces the replay ledger outcome to remain `unresolved` even when the new complete interpretation returns `NO_WRITE`. `NO_WRITE` replays are also not persisted as a later source-state transition, so `reconcileIngestionDebt` has no newer non-unresolved source evidence with which to settle the historical record.

Repair 02 is therefore blocked from any production write at this SHA. The bounded engineering repair must make complete `NO_WRITE` / `APPLIED` / `ALREADY_APPLIED` replays produce truthful later source states while preserving gaps and open semantic decisions as unresolved.

No Gmail permission, cursor, OAuth identity, cron activation, ingestion history rewrite, or workspace mutation was performed by request 1125.

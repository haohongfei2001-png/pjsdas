# R01 Production Reconciliation Receipt

Package: `TODAYACTION-RELIABILITY-CLOSURE-v1`  
Round: **R01 / #125**  
Engineering result: **PASS**  
Latest production cycle result: **COMPLETE_WITH_UNRESOLVED**

## Exact runtime

- exact main: `1c4c62cb6a2f322ac1494725a5654ae27de3cfa0`
- PR #173: independent Gmail reconciliation safety net
- PR #174: resumable reconciliation continuation for mailbox-scale coverage
- production migration: `gmail_reconciliation_continuation`
- production migration version: `20260926112126`

Exact-main verification:
- CI `36237996166`: SUCCESS
- Browser E2E `36237996163`: SUCCESS
- Pages deploy `36237996242`: SUCCESS
- Production Self-Test `36238081811`: SUCCESS
- Reliability Hotfix Production Certification `36238081810`: SUCCESS
- CGR Final Production Certification `36238081825`: SUCCESS
- TodayAction Production Brand Readback `36238081851`: SUCCESS
- TSUI-05 Live Visual `36238081832`: SUCCESS
- verified release publish `36238095079`: SUCCESS

## Production scheduler contract

Verified after migration:

- primary Gmail ingestion remains `*/10 * * * *`
- independent reconciliation starts at 08:30 Asia/Shanghai
- independent reconciliation starts at 17:30 Asia/Shanghai
- reconciliation continuation runs at minutes 05/15/25/35/45/55 only while a cycle is requested or active
- no Google permission expansion
- no manual primary Gmail cursor edit
- no Gmail send/delete/modify capability

## Authorized production cycle

The first authorized production attempt reached the deployed reconciliation route but failed closed with
`GMAIL_RECONCILIATION_LIMIT_EXCEEDED`, proving the original single-cycle 250-record bound was too small for the real mailbox.

After #174 and the continuation migration, the same authorized reconciliation was resumed in bounded 20-message worker executions. The final cycle completed at:

`2026-09-26T11:34:37.509070Z`

Final durable workspace proof recorded at:

`2026-09-26T11:34:31.159Z`

Coverage proof:

- Gmail messages scanned: **481**
- recruiting-relevant messages reviewed: **100**
- NO_ACTION: **54**
- WAITING: **0**
- ACTION_REQUIRED: **1**
- COMPLETED: **0**
- EXPLICITLY_DECLINED: **0**
- CLOSED: **1**
- UNRESOLVED: **44**
- Gmail-only items: **26**
- TodayAction-only live processes: **14**
- fixed/hard items within 7 days detected by this cycle: **0**
- unavailable Gmail payloads: **0**
- reconciliation failed runs after continuation migration: **0**

## Interpretation

This receipt does **not** claim that the mailbox is fully reconciled.

The engineering contract is considered satisfied because the independent pass:

1. covered the complete bounded Gmail scope without a company whitelist or recruiting-keyword provider prefilter;
2. completed across a mailbox larger than one worker budget without moving the primary Gmail history cursor;
3. durably classified every recruiting-relevant record into an explicit reconciliation state;
4. surfaced discrepancies as durable unresolved / decision-required state instead of silently dropping them;
5. preserved the China Orient written-test latest-start regression and Today timing semantics;
6. emitted a durable production coverage proof.

Because the production proof contains 44 UNRESOLVED items and Gmail↔TodayAction discrepancies, the **mailbox outcome is COMPLETE_WITH_UNRESOLVED, not FULL_RECONCILIATION**. Those user-data reconciliation items remain explicit work; their existence is evidence that the safety net is detecting ambiguity rather than hiding it.

R02 / #156 may proceed independently to separate lifetime unresolved audit debt from currently active unresolved state.

# TodayAction Reliability Closure v1

Package: `TODAYACTION-RELIABILITY-CLOSURE-v1`

Purpose: close the remaining reliability risks that can make TodayAction miss a recruiting deadline or present historical ingestion debt as current work.

Execution order:
1. **R01 / #125** — independent Gmail reconciliation safety net.
2. **R02 / #156** — split lifetime unresolved audit from active unresolved and reconcile historical debt.

Preserved invariants: transactional workspace authority, CAS, command ledger, receipts, source identity, Gmail cursor complete-consumption, privacy, no guessed opportunity identity, and the current Today / 岗位库 / 日程 product structure.

R01 scans the union of all non-spam/trash messages received in the last seven days and all unread non-spam/trash messages, without company or recruiting-keyword prefilters. It runs under the same per-binding execution lease, reuses the shared semantic policy, and can re-interpret previously accounted records without replaying unchanged business facts. The primary Gmail cursor/success/error state is not mutated by reconciliation.

Target production cadence is 08:30 and 17:30 Asia/Shanghai. A bounded maximum fails closed instead of silently claiming complete coverage.

R02 starts only after R01 exact-main/deployment evidence is complete.

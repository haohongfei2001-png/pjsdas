# TodayAction Owner Interaction Recovery v1

Bounded follow-up from remote `main@e11fa701038c71d113e58dc2cdac22cc748957cb`.
This work does not reopen an earlier PCR package. The owner reported a stale
`txn:843` conflict while the authoritative workspace had advanced beyond
revision 1000, a schedule cancellation that surfaced an unknown command
outcome after receipt lookup, and Today status banners that obscured tasks.

## Recovery rules

- A persisted conflict is reclassified on a fresh authoritative read at
  startup, on focus or reconnect, and periodically. Its displayed remote
  version follows the latest checked revision. A proven equivalent cache
  converges automatically only when there are no pending operations. A real
  local edit or pending command remains fail closed; no side is overwritten.
- A server receipt is queried before opening the local database or checking
  projection safety. `COMMITTED` and `ALREADY_APPLIED` remain confirmed facts
  even when local projection is blocked. The same command identity stays in
  the pending journal until a later safe receipt projection succeeds; reload
  never sends that confirmed command again. A `NO_WRITE` response leaves no
  receipt or pending command to strand the cache. Other command entry points
  report a confirmed but locally pending result without claiming local save.
- Today omits the ordinary background-refresh banner, uses one compact sync
  entry for a blocked cache, and places one hard-deadline notice next to the
  task list. Schedule feedback uses plain language and does not expose
  internal error codes or offer Undo while the local projection is pending.

Verification uses synthetic account and owner-like browser fixtures. The
actual owner Chrome profile remains read-only and its divergence subtype is
not inferred from server state. No production workspace mutation or local
profile reset is part of this follow-up.

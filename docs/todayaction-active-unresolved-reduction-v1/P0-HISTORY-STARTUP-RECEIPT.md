# P0 historical completion startup repair

Base main: `bb2cfd85ec492bf5a4e3272146213b4ef576f1ea`.
Sole writer: `reliability/p0-history-completion-startup-v1`.

## Reproduced cause

A real headless Chromium journey opened Schedule Past, selected a historical entry,
opened its job details, completed an ordinary action and returned to Today. Before
the fix the root disappeared with `RangeError: Invalid time zone specified: source-offset`.
Both Today and Schedule passed storage provenance markers directly to Intl.
Production read-only inspection at revision 829 found 12 source-offset nodes.
The 13 legacy completed nodes without completedAt remain unknown historical completion
times; that observation is not evidence of a newly performed completion.

## Repair

- Convert provenance markers to a safe display timezone without changing stored instants.
- Catch root provider, selector and render errors with a recovery surface.
- Catch initial exportLocalSnapshot and subsequent reload rejections; export reads one readonly transaction and normalizes only in memory.
- Retry and download a raw readonly archive of every IndexedDB store, including invalid rows.
- Retain elapsed, superseded and previously completed occurrences when a task checkbox changes.
- Require explicit application-submission intent; retain apply status but exclude it from generic job-detail task completion.
- Persist existing schedule backfill changes even when node count stays the same.

## Candidate verification

- Unit: 204 files / 982 tests pass.
- Type and production build pass.
- New Chromium regressions: 6 pass, including ordinary/apply, terminal/elapsed/legacy
  nodes, one action with multiple nodes, durable restart, Today/Schedule/job detail
  reload, initial and reload errors, raw backup and root render recovery.
- Firefox/WebKit Matrix now includes these regressions.
- Full remote CI, Browser, Matrix, latest Codex review and exact-main production
  verification are required before claiming production repaired.

Repair 02 is preauthorized only after this P0's exact-main verification and a fresh
38-settlement, same-60-target dry-run. No Repair 02 write has been performed here.

## Actual production snapshot before fix

The deployed bb2cfd8 bundle, with a readonly copy of the complete revision-832
production snapshot in an isolated browser IndexedDB, reproduced the same
source-offset RangeError on Today navigation and reload; a fresh page also
failed to start. Schedule and job detail remained available. The network guard
blocked production mutations; zero write requests were observed.

## Review repair

Codex P1 identified startup migrations writing before a later validation failure.
Export/startup now reads a single readonly transaction, with timeline and schedule
normalization applied only to the returned copy. Recovery regressions assert raw
actions, legacy processes, schedule nodes and malformed timeline rows are identical
before failure, in the downloaded archive and after failure.

Codex also identified synthesized backfill timestamps changing fingerprints between
readonly exports. The projection now uses a deterministic stored-fact timestamp,
and does not duplicate a real completion audit row. A real browser regression
compares exports across two wall clocks, raw stores, and reminder/outbox data.
The pre-existing reminder source contract asserts the new readonly transaction reads.

## Account-cache integration repair

Full Browser at 0415f93 found two genuine regressions: safe sign-out refused to
clear the connected cache, and a second client refused an authoritative event
delete. Settings history reads still persisted wall-clock timeline backfill after
startup had recorded its deterministic projection fingerprint. History reads now
use the same readonly projection, preserving conflict and sign-out protections.
The two existing real account journeys and the extended raw-store/stable-export
regression all pass locally; type checking passes. Full gates and fresh review
must pass on the final head before merge.

## Validated baseline durability

Latest Codex P1 found that readonly backfill could disappear when a legacy done
action was reopened or its legacy process event deleted. Startup and history remain
readonly. Before local source-fact mutations, a transaction locks all source stores,
validates the same deterministic snapshot projection, and appends only missing
baseline timeline records plus the marker. Existing audit rows are not overwritten.
Invalid baseline validation aborts the transaction before any writes or mutation.

Two new real IndexedDB regressions verify completion/event evidence survives
reopen + delete + reload + fresh-page restart, and malformed baseline rejects both
mutations with every raw source/audit store unchanged. The existing historical
completion, readonly history/export, account sign-out and two-client delete journeys
also pass (6 targeted tests). All 982 unit tests and type checking pass. The final
8-case P0 browser suite remains required in full Browser and Firefox/WebKit Matrix.

## Atomic baseline and edit repair

Codex P1 identified a queued cache replacement entering between the baseline
transaction and the later source edit. All local source-fact mutation paths now
use one all-store transaction for baseline validation/materialization, source
reads, and edits. Re-import also reads and merges the latest locked state; a
queued replacement cannot enter between baseline and source writes. Any failure
aborts baseline and edits together. Startup and history remain readonly.

Two additional real IndexedDB regressions queue a markerless replacement on a
second database connection while the first transaction is active, and inject a
source-write failure after baseline appends. Both fail against previous head
4e57efc, and both pass after the fix. The full 10-case P0 suite plus both existing
account-cache regressions pass in Chromium (12 total); all 982 unit tests/type pass.
Remote full gates and exact-head Codex review remain mandatory.

## Merged and exact-main production verification

PR [#185](https://github.com/haohongfei2001-png/pjsdas/pull/185) merged final head
`4046223fbac23cea697649feef9e4ee49c44baf1` as
`c93a0fca9ef9b8eec8e234557f525445c0ef6b20`.
The final P0 suite contains **10** cases, plus both existing account-cache regressions.
The earlier candidate counts and pending/no-write statements above are historical.

All final-head gates passed, including actual VoiceOver, full Browser and Firefox/
WebKit Matrix. All four valid Codex P1 findings were repaired; the
[latest review](https://github.com/haohongfei2001-png/pjsdas/pull/185#issuecomment-5873417065)
reviewed the final head and found no blocker.

Exact merge-main gates:
[CI](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36447809012),
[Browser](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36447809296),
[Matrix](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36447809433),
[Pages](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36447809027),
[Production Self-Test](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36448088249)
all succeeded.

Current verified runtime `a8d984059a2cc47b98d0f5abb7cb9fd84933f9a2` differs only by
PR #186 queue documentation. Its exact
[CI](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36448814886),
[Browser](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36448815143),
[Pages](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36448814880),
[Production Self-Test](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36449142896),
[Brand readback](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36449142846)
and [live visual](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36449142832)
succeeded. Matrix and VoiceOver were not retriggered by that docs-only commit;
their evidence applies to the unchanged runtime source.

Both deployed c93 and a8 bundles were independently tested headlessly against a
complete read-only revision-838 production snapshot in isolated IndexedDB.
All seven Today/Schedule/job-detail navigation, reload and fresh-page startup
checks rendered successfully, with **zero errors and zero write requests**.
Backend health request 1378 returned HTTP 200 and exact a8 runtime identity.
No private payload or snapshot is included in this receipt.

**P0 production repair verified.** Repair 02 subsequently consumed its bounded
authorization; see [production settlement receipt](REPAIR-02-PRODUCTION-SETTLEMENT-RECEIPT.md).

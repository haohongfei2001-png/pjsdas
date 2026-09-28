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

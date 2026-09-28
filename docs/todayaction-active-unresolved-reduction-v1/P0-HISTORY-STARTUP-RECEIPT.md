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
- Catch initial exportLocalSnapshot and subsequent reload rejections.
- Retry and download a raw readonly archive of every IndexedDB store, including invalid rows.
- Retain elapsed, superseded and previously completed occurrences when a task checkbox changes.
- Require explicit application-submission intent; remove apply from generic job-detail task completion.
- Persist existing schedule backfill changes even when node count stays the same.

## Candidate verification

- Unit: 204 files / 982 tests pass.
- Type and production build pass.
- New Chromium regressions: 5 pass, including ordinary/apply, terminal/elapsed/legacy
  nodes, one action with multiple nodes, durable restart, Today/Schedule/job detail
  reload, initial and reload errors, raw backup and root render recovery.
- Firefox/WebKit Matrix now includes these regressions.
- Full remote CI, Browser, Matrix, latest Codex review and exact-main production
  verification are required before claiming production repaired.

Repair 02 is preauthorized only after this P0's exact-main verification and a fresh
38-settlement, same-60-target dry-run. No Repair 02 write has been performed here.

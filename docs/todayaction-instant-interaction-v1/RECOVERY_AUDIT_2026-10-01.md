# Instant interaction recovery audit — 2026-10-01

## Scope and baseline

This scoped repair is based on frozen PR #208 at
`68dcb51acdab9c437cc809a8bf80415fb06c4326`, with a separate repair branch.
It does not replace the original writer branch or reopen earlier product phases.
No production workspace, account profile, permissions, paid services, database
schema, merge, release, or deployment is changed.

## Reproduced defects

1. The bounded domain lens inferred processes and events only from opportunity
   identity. Supported imported standalone processes and explicit action/event
   links could therefore fail local validation before a valid command reached
   the server. Five permanent tests fail on the baseline and compare repaired
   forward and Undo projections against the complete domain kernel.
2. A confirmed entity/journal transaction could be downgraded to
   `projection_pending` after a later checkpoint or mirror cleanup error. This
   prevented immediate Undo despite successful local and authoritative writes.
   The same failure existed after legacy full-snapshot recovery. Four unit fault
   cases reproduce both response contracts and both metadata boundaries.

The repair follows actual entity references without reading timeline history.
Post-commit metadata work cannot downgrade a terminal journal or repeat a
projection/inverse. Adjacent checkpoints advance only under account/revision
checks; larger gaps retain the authoritative refresh contract. Account changes
prevent stale UI notifications. Original command IDs and compensation remain
retained for recovery.

## Verification

- Baseline: 1,154 unit tests passed under UTC. The cloud executor's default
  Pacific timezone exposes two pre-existing fixed-event fixture assumptions;
  these were not changed or presented as product defects.
- Seven first-pass unit regressions failed on the frozen baseline. A subsequent
  independent review reproduced the same metadata defect in snapshot recovery;
  that path has its own two regression cases.
- Repaired focused suite: 20 tests passed with the lockfile's exact dependencies.
- Full unit/type/build results and exact remote commit checks are reported in
  the repair PR. They must be refreshed after any final source edit.
- Eight new synthetic browser scenarios cover both metadata contracts and four
  standalone-process operations with Undo/reload. Local Chromium cannot launch
  its IPC socket in this cloud shell, so no local browser pass is claimed.
- A path-scoped 12-minute draft gate runs the relevant Chromium/WebKit recovery
  cases and the existing strict built-artifact performance suite. Complete
  Browser/Matrix/VoiceOver, fresh package review and exact-main readback still
  govern final package closure; a focused draft check is not their substitute.

All fixtures are synthetic. Their tasks and dates are not statements about any
user's actual applications, deadlines, or production workspace.

## Integrated full-gate follow-through

Scoped candidate `b03215f5` passed hosted 30/30 Chromium/WebKit recovery cases and
3/3 strict built-artifact performance suites. The upstream `68dcb51a` Matrix
rerun also succeeded, with 180 core cases, 107 dense passes plus one case that
passed its existing retry (WebKit cancel, 151ms against a 150ms limit), and 4/4
built performance suites. That prior-head evidence does not certify this repair.

The `full:<full-head-SHA>` label is an exact-head opt-in to the repository's existing
complete CI/Browser/Matrix gates while a same-repository PR remains draft.
A stale-head or foreign-repository label cannot opt in. Unrelated label events
do not trigger these gates; ordinary PR/push/dispatch routes remain available. It does not authorize
merge, deployment, or production mutation. Unlabelled drafts retain their cheap
inner loop, and the narrow draft gate skips when the full gates are selected.
VoiceOver watches both repaired interaction files as well as its existing paths.
No checks or performance thresholds are removed. The Matrix has a 30-minute
hard cap: its measured frozen baseline took 23m57s, before the 16 additional
cross-engine recovery cases in this repair. Whole-package gates must pass on
the new exact integration head before any stronger readiness claim.

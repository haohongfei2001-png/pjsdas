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
A stale-head or foreign-repository label cannot opt in. Label-only events are
not workflow triggers; ordinary PR/push/dispatch routes remain available.
Prepare the commit object, apply its exact-head label, then advance the owned
branch. The synchronize event consumes that precise approval without creating
skipped required-check receipts for unrelated label changes. It does not authorize
merge, deployment, or production mutation. Unlabelled drafts retain their cheap
inner loop, and the narrow draft gate skips when the full gates are selected.
VoiceOver watches both repaired interaction files as well as its existing paths.
No checks or performance thresholds are removed. The Matrix has a 30-minute
hard cap: its measured frozen baseline took 23m57s, before the 16 additional
cross-engine recovery cases in this repair. Whole-package gates must pass on
the new exact integration head before any stronger readiness claim.

## Receiptless acknowledgement follow-through

The comprehensive integration review reproduced one further recovery defect:
when another device already made the requested change, a receiptless
`ALREADY_APPLIED` parent retained an optimistic timestamp. Its queued child
repeatedly failed field comparison and never dispatched. The original no-write
revision was also lost, so it could not safely distinguish a later read.

No-write acknowledgement revision and `projection_pending` disposition now
persist together before recovery. Recovery reads first even for a legacy active
journal carrying that marker. The exact acknowledged revision can bind existing
entity postimages for dependent edits, but cannot create audit or Undo ownership.
A newer authoritative snapshot retires only the original optimistic dependency
closure under the existing account/local guards; it never silently rebases a
child onto another writer's newer change. Independent intent remains retained.
Queued Undo cannot undo the other writer's fact or send an unowned compensation.

Review also reproduced two adjacent boundaries before repair: a crash after
saving the acknowledgement could resend it, and zero-delta terminal metadata
cleanup could advance a checkpoint without installing that revision's facts.
The no-op disposition prevents replay; a newer zero-delta acknowledgement now
requires guarded readback. No-op journals cannot advance a checkpoint merely
because their revision is adjacent.

Ten permanent unit cases cover dependent edit/Undo, stable/newer remote facts,
post-acknowledgement crash, independent intent, and empty-delta checkpoint truth.
Five browser cases cover persistent reload and the unseen-fact/mirror-failure
boundary. Original and follow-up independent reproductions pass locally. Whole
unit/type/build and new exact-head complete gates must be recorded in the PR;
older green head `1735988` is historical evidence, not certification of this fix.


## Label-event status truth

Final readiness inspection found that job-level guards on `labeled` events
still created skipped `ci-build` and browser check receipts for unrelated labels.
GitHub considers skipped jobs successful for required-check purposes, so those
metadata-triggered receipts must not masquerade as fresh validation.

The four full workflows no longer subscribe to label-only events. Exact-head,
same-repository opt-in remains available on normal synchronization and review
routes, using the prelabel-before-ref-update procedure above. The required
unit/type job has no metadata-based skip condition. Five new/strengthened static
regression assertions failed before this correction; runtime source and all
performance thresholds remain unchanged. See GitHub's official
[status-check semantics](https://docs.github.com/en/pull-requests/reference/status-checks).

## Legacy history fixture receipt contract

The final Matrix on `63021b8` passed 178 core cases but failed the legacy
application-submission Undo journey in WebKit, including its retry. Both saved
network traces show a normal command acknowledgement and snapshot read followed
by a read-only receipt lookup for the queued Undo. The old mock returned
`400 UNEXPECTED_WRITE` for that supported read, leaving safe recovery pending.
A companion completion case was timing-sensitive as well.

The legacy full-response fixture now retains real command receipts and answers
both found and absent receipt lookups. It holds the parent acknowledgement until
Undo has been durably applied, then releases it in `finally`, so the intended
immediate-Undo boundary is exercised deterministically. Added assertions require
the original exact two commands, retained receipt identities and an absent
queued-Undo receipt lookup. Every prior history, audit, reload and restart
assertion remains. There is no runtime change, added sleep, timeout increase,
performance-budget adjustment or blind rerun. Hosted verification remains
required on the repaired fixture head.

## Full Chromium runner margin

At `b3aa967c`, all 180 core and 67 dense Chromium cases passed. The workflow
then hit its old 15-minute job cap during teardown, after the final pass summary;
the recorded setup/core/dense work took about 15m11s. The job is correctly
recorded as cancelled, not as a completed gate.

The Chromium job has a 20-minute hard cap to accommodate the now-complete suite
and runner/setup variance. Individual test timeouts, all cases, and the strict
100/150/100/50ms interaction budgets are unchanged. This is a bounded execution
margin, not permission to retry indefinitely or drop verification stages.

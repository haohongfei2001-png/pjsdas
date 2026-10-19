# Preparation retirement

Owner amendment: 2026-10-18. Baseline main `8e7ab4a10f0ecca0b934823059766b4537b8ece8`, tree `53072f338c86262640d4d94a5bc27f6a5da2b77b`.

## Scope and compatibility

- Remove Preparation inventory/graph navigation, related-preparation detail panels,
  active generation/imported preparation Actions, and preparation reminder creation.
- Exclude typed/linked preparation Actions and exact source-proven preparation
  manual tasks from Today, capacity, job details, calendar and pending decisions.
  Do not inspect arbitrary job notes/company names for preparation words.
- Keep application planning/submission and real employer interview, written-test
  and assessment events, even when a historical row also links a Prep.
- Preserve ambiguous manual records. Exact legacy natural-language operation and
  timeline identities can prove a preparation purpose even when a title was shortened.
- Reject fresh preparation mutations with `PREPARATION_RETIRED`; bounded mixed
  batches do not partially commit. Explicit first-party task clauses use finite,
  conservative purpose rules; quoted evidence cannot grant new task authority.
- `get_prep_graph` remains a stale-client compatibility endpoint. It returns an
  explicit retired error before workspace access, never a misleading empty graph.
- Normal reminder reads omit preparation. Exact-ID private-reminder reads label
  archival records retired and permit only guarded cancellation; existing guarded
  cancellation compensation remains valid. No external reminder dispatcher exists
  in this repository; new preparation intent/outbox emission is blocked.
- Raw Prep/Action/Timeline/Schedule/receipt records remain exportable. No migration,
  production-record deletion, background cleanup or grant change is performed.
  Existing exact-command replay and conflict-checked Undo still work.
- Hash-bound v2/v7 consent descriptors remain byte-identical. Consent pages show
  current supported capabilities separately and retain the original text in details.

A legacy retired node can still own negative timing evidence for an ambiguous
retained manual task. That node stays internal to read models to prevent an old
raw due date from reactivating. Calendar eligibility still rejects it; separate
retired-node indexes exclude its reminders and pending decisions. Projections
never mutate the authoritative rows or receipt fingerprints.

## Evidence

- Initial deterministic RED: five new core retirement tests failed on the old tree.
- Current focused retirement suite: 35 passed, including legacy provenance,
  raw-data preservation, ordinary/application/recruiting positives, mixed rejection,
  attached reminder/outbox consistency, exact replay, business and task Undo,
  private cancellation/restore and stale decision suppression.
- First full run: 351 files, 4308 passed / 9 failed. Three original timing cases
  exposed the real raw-date reactivation regression described above. Their original
  assertions remain unchanged. Six failures were legacy active-feature positives;
  reminder ownership, historical alias evidence and unrelated UI assertions remain.
- Fixed failure closure: 8 files / 148 passed. Independent read-only review of the
  timing delta ran 46 cases and found no remaining blocker. Earlier review covered
  authority, legacy replay, consent hashes, source provenance and atomic rejection.
- Synthetic browser tests preserve raw IndexedDB records through navigation/reload,
  demonstrate preparation absence in both languages, and retain real applications
  and recruiting schedules. The fixed before-phase visual evidence remains; all
  unaffected exact pixel/hash/geometry checks and one-pixel negatives are unchanged.
- Final fixed-candidate UTC full unit: 351 files / 4317 passed. Production build
  passed; plugin package contracts: 11 passed. The retired-capability smoke
  assertions were updated separately and syntax-checked; no live smoke was run
  against the still-old deployment. Exact-head official CI remains pending.
  Local browser execution is unavailable in this environment; browser success is
  only claimed from the official workflow result, never from test discovery.

## Official first-head evidence and test-only closure

The first published head was `7829b235963f6b19955b8dee209a151caaa2df97`
(tree `0d4ba25f69500db80052817f19eb3e5989fd9532`). Its original results remain:

- [CI](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39179855257),
  [strict secondary visual](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39179819000),
  Brand, UI Review, read-only rollback and draft recovery passed.
- [Chromium](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39179855200):
  281 passed / 7 failed. Four failures retained an old preparation task title after
  the input had changed to an ordinary task; three queried the historical consent
  descriptor title rather than the current business display label.
- [Firefox/WebKit](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39179855236):
  284 passed / 6 failed, all the same three consent selectors in both browsers.
  Dense journeys and the performance tail were skipped after those failures;
  these skips are not performance acceptance.
- [VoiceOver](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39179855279):
  two journeys passed, one retained the old task-title expectation. The separate
  macOS offline visual job passed.
- [SQL](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39179855154):
  fresh preparation writes correctly returned `PREPARATION_RETIRED`, but old
  raw-gateway fixtures still expected successful new preparation creation.

The follow-up changes only tests and this evidence document. Production source
remains byte-identical to the 4317-test/build candidate. Browser task-name and
display-label selectors were corrected without changing assertions, timeouts,
consent descriptors/hashes, fixed before-phase evidence or pixel thresholds.
Independent browser review found the final delta clean.

SQL fixtures now require exact fresh preparation rejection with unchanged
snapshot, revision, RPC count and ledger. Six complete historical preparation
create/update/archive fixtures retain real replay, payload-reuse rejection,
precise Undo and post-Undo replay coverage across v2/v7. Each fixture was compared
field-for-field with the actual pre-retirement executor, including compensation,
payload hash, receipt context, provenance and grant proof. Active CAS/revocation
tests use supported manual actions while keeping historical preparation arrays.

Both author and independent reviewer passed the six historical differential
comparisons and actual serial PGlite SQL: v2 raw (14 scenarios), v7 raw (19),
consumer flow and the complete eight-stage migration chain. Another 60 focused
unit tests passed. Real PostgreSQL multi-session locking and the complete final
browser/performance gates still require the new exact-head official CI; PGlite
and static browser review do not replace them.

## Deployment and rollback

Use the existing CI, repository merge and deployment paths. No new service,
permission, credential, budget or production-data migration is required.
Do not mix this product change with the paused real-record audit or identity repair.
A code rollback restores former feature availability but does not need to recover
any deleted data: this change performs no deletion. Re-enabling Preparation is a
separate product decision; retain existing authority and release checks during any
emergency rollback.

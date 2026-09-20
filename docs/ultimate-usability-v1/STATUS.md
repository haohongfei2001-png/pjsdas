# PJSDAS Ultimate Usability v1 — Canonical Status

Package: `PJSDAS-ULTIMATE-USABILITY-v1`  
Blueprint version: `1.0`  
Last revalidated baseline before registration: `main@bf0643eda139125868a9c697b81ff5ac5288a4f4`  
Product origin: `https://todayaction.com`

## Round state

| Round | State | Notes |
|---|---|---|
| UU-00 | **COMPLETE — DESIGN REGISTERED** | Docs-only registration/revalidation; no business code/data/config change |
| UU-01 | **COMPLETE** | ScheduleNode / occurrence / temporal semantics implemented and production-verified |
| UU-02 | **READY — NOT STARTED** | UU-01 dependency satisfied; unified semantic intake is next |
| UU-03 | NOT_READY | Depends on UU-02 |
| UU-04 | NOT_READY | Depends on UU-03 |
| UU-05 | NOT_READY | Depends on UU-04 |
| UU-06 | NOT_READY | Depends on UU-05 / shared intake |
| UU-07 | NOT_READY | Depends on shared intake/read models |
| UU-08 | NOT_READY | Depends on platform-neutral contracts |
| UU-09 | NOT_READY | Final canary/release |

## Revalidation findings

### Confirmed current production architecture

Canonical Round 6 states:

- transactional Supabase/PostgreSQL workspace is authoritative;
- owner-only allowlist is active;
- canonical Web/API origin is `https://todayaction.com`;
- Google Drive is backup/export/portability;
- legacy GitHub Pages remains bounded migration/recovery origin;
- `v1.1.0-rc.1` remains immutable prerelease;
- final `v1.1.0` publication is a separate owner decision.

The release plan is currently **DISARMED**:
`publishOnProductionSuccess=false`.

### Documentation drift found

Root `README.md` still said production remained on legacy Drive authority. UU-00 corrects this
documentation only; it does not migrate or switch data again.

### Baseline browser blocker — CLOSED

The registration baseline `main@bf0643eda139125868a9c697b81ff5ac5288a4f4` had 30 failing Chromium
journeys in run `35496146452` after the decision-first UI change.

Bounded closure evidence:

- PR #95 changed Browser E2E journey expectations only; no business source, schema, data, config,
  permission, or release-policy change was made.
- all 30 failures were audited. The failures were historical UI journey assumptions: the retired
  Today heading/surface structure, the old five-item primary navigation, and the previous locations
  of Activity, manual capture, and the language switch. No separate business-code regression was
  identified in this bounded audit.
- PR head `3394ced2c4aa6dfd06e8fbf4fcadb7068b830b06`: `ci-build` and Chromium passed.
- merged main `0d621c122457321657fa8f560768117d5e5fb0f6`:
  - `ci-build` run `35503041344`: success;
  - Chromium run `35503041342`: success;
  - GitHub Pages / deploy run `35503041331`: success;
  - Production Self-Test run `35503119103`: success;
  - release workflow run `35503130027`: success and publication remains disarmed.

This closes the pre-UU-01 baseline blocker.

## UU-01 closure

UU-01 implementation is complete on `main@ebff7072dab9063eb1dbf8986c257e3307f9b631` (PR #96).

### Implemented contract

- Snapshot schema v2 introduces `ScheduleNode` as the canonical recruiting-time model while v1
  snapshots remain readable and are upgraded through compatibility adapters.
- stable occurrence identity and versioned supersession preserve multiple recruiting rounds and
  reschedules without destroying history.
- node lifecycle distinguishes `scheduled`, `in_progress`, `completed`, `cancelled`,
  `superseded`, and computed `elapsed_unresolved`; elapsed time alone never implies completion.
- temporal shapes preserve fixed ranges, deadlines, date-only values, timezone/offset semantics,
  raw precision and resolution basis; date-only migration does not fabricate a clock time.
- recruiting `stage`, within-stage `progress`, process `result`, user participation state, and
  ScheduleNode state are independent.
- legacy `Opportunity.deadline`, `ProcessEvent.dueAt`, and `Action.dueAt` are compatibility
  projections from the ScheduleNode contract for existing surfaces.
- IndexedDB moved to v9 with a dedicated `scheduleNodes` store and bounded legacy backfill.
- connected transactional readers accept v1 and expose v2; writes commit v2 through the existing
  CAS / command-ledger mutation kernel.
- production Supabase migration `schedule_node_snapshot_v2` was applied as remote migration
  `20260920102225`; the no-downgrade trigger is active on `public.pjsdas_workspaces`.
- the existing real workspace was intentionally left at schema v1 until the first normal v2 write;
  no direct production workspace-data rewrite was performed in this round.

### Verification evidence

PR head `452f59d9f60bf6aa292531784dc467fa2dca8333`:

- CI run `35504847794`: success;
- Chromium run `35504847690`: success.

Merged implementation `ebff7072dab9063eb1dbf8986c257e3307f9b631`:

- CI run `35504952185`: success, including all unit/golden tests and build;
- Chromium run `35504952158`: success;
- GitHub Pages / exact-SHA backend / deploy run `35504952218`: success;
- Production Self-Test run `35505035526`: success;
- release workflow run `35505049649`: success with publication still disarmed.

UU-01 golden coverage includes date-only precision, DST/offset handling, multiple occurrences,
elapsed-unresolved behavior, supersession history, written-test completion vs process result, and
v1→v2 round-trip history preservation.

Post-DDL Supabase inspection confirmed the downgrade trigger exists. Security/performance advisors
reported only pre-existing project findings; UU-01 introduced no new advisory finding.

## Next authorized work

UU-02 is **READY but NOT STARTED**.

A later execution may handle UU-02 only under the one-round protocol: re-read remote `main`,
canonical status, frozen blueprint/amendments, `DATA_AND_MUTATION_CONTRACT.md`, and
`rounds/UU-02.md`. This UU-01 execution stops before any UU-02 implementation.

## UU-01 scope boundary

UU-01 did change the time/process domain model, Snapshot schema, local IndexedDB schema, compatible
connected workspace handling, and one additive production database guard. It did **not**:

- implement unified semantic intake or DecisionRequest (UU-02);
- enable new Gmail / PAIA / ChatGPT / Calendar permissions;
- perform external recruiting actions;
- directly rewrite the real production workspace snapshot;
- change release publication policy;
- publish a new GitHub Release;
- broaden any external-action authority.

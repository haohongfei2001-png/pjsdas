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
| UU-02 | **COMPLETE** | Unified Semantic Intake / DecisionRequest / Undo policy implemented and production-verified |
| UU-03 | **READY — NOT STARTED** | UU-02 dependency satisfied; shared TodayBrief/agenda read model is next |
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

## UU-02 closure

UU-02 implementation is complete on `main@e9236676ab678d9847d581ef6f2dfdc9ba34b1e5` (PR #97).

### Implemented contract

- one platform-neutral Semantic Intake contract now accepts normalized candidates from Web,
  current-chat MCP, owner PAIA/ChatGPT bridge, structured Gmail adapters, and future iPhone clients;
  source adapters are not allowed to invent separate business transitions.
- Statement mode is explicit. Current assertions/intents may proceed; questions, quotes, examples,
  hypotheticals, and rewrite requests produce `NO_WRITE` instead of becoming business facts.
- stable Opportunity and ScheduleNode occurrence resolution is deterministic and fail-closed.
  Same-company multi-role ambiguity and multi-round interview/test ambiguity produce durable
  `DecisionRequest` records rather than guessed writes.
- DecisionRequest is persisted with reason, affected objects, 2–4 choices, consequences, evidence,
  source/payload binding, state and answer metadata.
- unique high-confidence, compensatable internal facts can commit without a second confirmation.
  Explicit unique internal abandonment follows Owner Amendment OA-03; shared application-group
  governance still requires a DecisionRequest.
- external application/withdrawal/email/Offer consequences remain outside Semantic Intake authority
  and fail closed to human decision; this round adds no external-action authority.
- recruiting occurrence completion is atomic: node completion, related Action completion and
  within-stage Process progress update occur in one semantic transaction without completing the
  overall recruiting Process.
- occurrence rescheduling keeps one stable occurrence identity, creates a superseding ScheduleNode
  version and preserves the prior version/history.
- Semantic Intake writes persist durable receipts with affected objects, DecisionRequest ids and
  Undo availability. Raw owner input text is not written into command-ledger payloads.
- ledger-backed Undo applies field/object-level compensation only when the target command is still
  the latest workspace revision; later dependent revisions fail closed instead of restoring a stale
  whole snapshot.
- Snapshot schema v3 persists `decisionRequests` and `semanticReceipts`; v1/v2 remain readable.
  IndexedDB is v10 with dedicated stores for both collections.
- authenticated MCP tool surface is v4 and adds `semantic_intake`,
  `resolve_semantic_decision`, and `undo_semantic_command` for transactional authority.
- delegated `semantic_intake` requires an explicit user/client/source capability grant. The
  production migration only extends the capability vocabulary; it creates no grant automatically.
- production Supabase migration `semantic_intake_policy` was applied as remote migration
  `20260920131307`; post-migration query confirmed `semantic_intake_grants = 0`.
- the existing real workspace was intentionally not bulk-rewritten and remains schema v1 until a
  normal compatible write upgrades it.

### Verification evidence

PR head `33833280958e10b42ae9030316b13b1683ff6013`:

- CI run `35512078256`: success;
- Chromium run `35512078353`: success.

Merged implementation `e9236676ab678d9847d581ef6f2dfdc9ba34b1e5`:

- CI run `35512877012`: success, including 625 tests, TypeScript/build and bundle gate;
- Chromium run `35512877114`: success;
- exact-SHA backend + Pages/deploy run `35512877034`: success;
- Production Self-Test run `35512961598`: success;
- release workflow run `35512976882`: success with publication still disarmed.

UU-02 golden coverage includes atomic written-test completion, same-company multi-role ambiguity,
multiple interview occurrences, non-assertive text no-write, unique abandonment, shared-governance
DecisionRequest, external-withdrawal fail-closed behavior, occurrence reschedule versioning,
source-version replay idempotency, field-level compensation, DecisionRequest resolution, server-side
source authorization, no raw-input ledger persistence, and dependent-revision Undo refusal.

## Next authorized work

UU-03 is **READY but NOT STARTED**.

A later execution may handle UU-03 only under the one-round protocol: re-read remote `main`,
canonical status, frozen blueprint/amendments, shared read contracts, and `rounds/UU-03.md`.
This UU-02 execution stops before any TodayBrief / agenda implementation.

## UU-02 scope boundary

UU-02 did change the semantic mutation contract, Snapshot/local persistence schemas, authenticated
MCP tool surface, server authorization/write policy and one additive production authorization
constraint. It did **not**:

- implement TodayBrief / agenda planning (UU-03);
- grant PAIA, Gmail or any delegated client the new capability automatically;
- enable a new Gmail/PAIA/browser/iPhone permission;
- perform any external job application, withdrawal, recruiting email or Offer action;
- bulk-rewrite the real production workspace;
- change release publication policy;
- publish a new GitHub Release.


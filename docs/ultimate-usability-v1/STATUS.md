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
| UU-03 | **COMPLETE** | Revision-bound TodayBrief / agenda / latest-start read model implemented and production-verified |
| UU-04 | **COMPLETE** | Final two-destination Web shell / Today implemented and production-verified |
| UU-05 | **COMPLETE** | Shared opportunity decisions / conclusion-first detail and date-only regression closed on main; production verified |
| UU-06 | **IN_PROGRESS** | OA-06 polling runtime deployed; natural production cron executions at 09:10/09:20 UTC succeeded on */10; Push/watch dormant, zero Gmail opt-in; live mailbox canary pending |
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

## UU-02 scope boundary

UU-02 changed the semantic mutation contract, Snapshot/local persistence schemas, authenticated
MCP tool surface, server authorization/write policy and one additive production authorization
constraint. It did **not** implement TodayBrief / agenda planning, silently grant new source
permissions, perform external recruiting actions, bulk-rewrite the production workspace, change
release publication policy, or publish a new GitHub Release.

## UU-03 closure

UU-03 implementation is complete on `main@dc098d15dca20f9552d50ffee5f285d68077c6e0` (PR #98).

### Implemented contract

- one platform-neutral `TodayBrief` is now the canonical daily read contract for Web, MCP and
  future native iPhone clients;
- the contract is revision-bound and explicitly carries workspace revision, evaluation time,
  display timezone and Decision Rules version/update time;
- it returns one primary `nextAction`, at most three `nextActions`, recruiting `agendaGroups`,
  relevant open `DecisionRequest` objects, material coverage warnings and hidden-by-default
  diagnostics;
- fixed-time interviews/tests are protected from becoming an early “start now” action while still
  appearing prominently in agenda;
- Agenda is ScheduleNode-backed, deduped by stable occurrence/version identity, defaults to seven
  calendar days and preserves fixed range / deadline / window / date-only semantics;
- date-only deadlines stay date-only. TodayBrief never fabricates a 23:59 or other clock time;
- past nodes without completion evidence project as `elapsed_unresolved` recovery items, never as
  completed facts;
- hard-deadline actions use `latestStart = boundary - estimatedDuration`; a long action can become
  protected before its raw deadline enters the legacy 48-hour window;
- protected latest-start work that does not fit the available-time budget generates explicit
  capacity / unplanned-hard-deadline warnings instead of being silently dropped;
- executability is explicit. Application actions expose a real external target only when a verified
  application URL exists; otherwise the contract reports context-only and never equates opening a
  page with applying;
- DecisionRequests are included only when open/unexpired and are ordered toward objects relevant to
  visible actions/agenda;
- source coverage gaps, stale sources and unresolved source records are summarized as material
  warnings, not converted into fake user decisions;
- recommendations are deterministic for the same snapshot revision, clock, timezone, rules and
  available-time input;
- authenticated MCP tool surface is now v5 and exposes `get_today_brief` as a release-required
  read tool under both Drive and transactional authorities;
- legacy `get_today_plan` remains available as a compatibility read, but it is no longer the
  canonical forward daily contract.

### Verification evidence

PR head `f7eb3922cb897e712f125a22be35f9f4ebb1c672`:

- CI run `35514869367`: success;
- Chromium run `35514869371`: success.

Merged implementation `dc098d15dca20f9552d50ffee5f285d68077c6e0`:

- CI run `35514965754`: success, including 637 tests, TypeScript/build and bundle gate;
- Chromium run `35514965802`: success;
- exact-SHA backend + Pages/deploy run `35514965767`: success;
- Production Self-Test run `35515043484`: success;
- release workflow run `35515057084`: success with publication still disarmed.

UU-03 golden coverage includes revision/timezone binding, fixed-event protection, quiet Today with
future-only fixed events, date-only precision, latest-start protection beyond the raw deadline
window, capacity conflict visibility, elapsed-unresolved recovery, DecisionRequest relevance and
expiration, material source-coverage warnings, seven-calendar-day agenda bounds, deterministic
repeatability and sparse next actions.

## UU-03 scope boundary

UU-03 changed read-model logic, authenticated MCP read surface and release/self-test gates only. It
did **not**:

- replace the current Web Today UI or navigation shell (UU-04);
- change Snapshot/database schemas;
- mutate production workspace data;
- add or grant source permissions;
- perform any external recruiting action;
- change release publication policy;
- publish a new GitHub Release.

## UU-04 closure

UU-04 implementation is complete on `main@669a169ac88b852175aa1c1bf9a0699aaba4b09b` (PR #99).

### Implemented contract

- persistent daily navigation now contains only **Today** and **Opportunities**;
- Settings and History are low-frequency semantic routes, and the Decisions entry appears only while
  one or more open, unexpired `DecisionRequest` objects exist;
- all frozen semantic Web routes are implemented:
  `/today`, `/today/agenda`, `/opportunities`, `/opportunities/:id`, `/capture`,
  `/decisions`, `/settings`, and `/history`;
- Vercel rewrites support direct refresh of those semantic routes; the Pages build emits a
  `404.html` SPA fallback before frontend artifact hashing so bounded legacy/recovery hosting can
  deep-link to the same routes;
- Web Today projects the canonical UU-03 `TodayBrief` directly instead of recomputing a parallel
  ranking/time-plan model in the UI;
- wide Web Today uses the frozen action + agenda composition; responsive/mobile Today uses the
  frozen primary action → agenda → next-actions order;
- the 390×844 browser gate verifies that a complete next action and at least one upcoming recruiting
  node are visible without scrolling, with only Today / Opportunities in the bottom navigation and
  Tell PJSDAS above those tabs;
- global **Tell PJSDAS** replaces the old daily ProgressInbox / ChangeSet interaction model. Web
  text is parsed into the source-neutral UU-02 Semantic Intake contract; questions/quotes/
  hypotheticals/rewrite requests remain no-write;
- ambiguous same-company role input creates a durable `DecisionRequest` instead of guessing or
  exposing a ChangeSet queue;
- explicit unique recruiting completion is normalized to `occurrence_completed`; completion of an
  elapsed interview/test closes the canonical ScheduleNode occurrence while question-form input
  remains read-only;
- pure Web semantic interpretation was separated from browser persistence so interpretation remains
  platform-neutral/testable and can be reused by future native clients;
- Decisions renders the durable DecisionRequest question/choices/consequences contract and resolves
  through UU-02 semantics; ordinary source health/coverage is not turned into a fake decision;
- material coverage warnings are folded into Today and hidden by default when non-critical; the
  former globally mounted Coverage and FixedEventGuard surfaces are no longer daily UI;
- background workspace replacement reloads data without remounting the entire App, preserving route,
  capture/navigation context, input drafts, selection and normal interaction continuity;
- in connected mode, Tell PJSDAS writes, DecisionRequest answers, action completion and their Undo
  flows do not show a success receipt until authoritative sync returns a successful
  pushed/synced/created outcome. Conflict, account mismatch or remote overwrite fails closed;
- UI wording keeps product concepts human-facing: Today, Opportunities, Tell PJSDAS, schedule,
  needs your decision, Settings and History;
- focus-visible treatment, Reduce Motion handling, safe-area-aware mobile controls and ≥44px primary
  interaction targets are part of the final Web layer;
- no Snapshot/database schema migration, source permission grant, production workspace rewrite or
  external recruiting action was introduced in this round.

### Verification evidence

PR head `ca2a79aa719efa66ac456a5797cf6947f0d00d96`:

- CI run `35519924783`: success, including 651 tests, TypeScript/build and bundle gate;
- Chromium run `35519924777`: success.

Merged implementation `669a169ac88b852175aa1c1bf9a0699aaba4b09b`:

- CI run `35520028185`: success;
- Chromium run `35520028153`: success;
- exact-SHA backend + Pages/deploy run `35520028132`: success;
- Production Self-Test run `35520114833`: success;
- release workflow run `35520131496`: success with publication still disarmed and release-creation
  steps skipped.

UU-04 browser/golden coverage includes two-destination navigation, semantic routes, direct route
hosting fallbacks, TodayBrief-only projection, context-preserving refresh, global Tell PJSDAS,
no-write questions, source-backed alias application, same-company ambiguity → DecisionRequest,
elapsed-occurrence completion, bilingual Today reasons, Settings/History relocation, authoritative
persistence receipts, recovery tooling, no horizontal overflow, and the 390×844 first-screen gate.

## Next authorized work

UU-05 is COMPLETE. UU-06 is **IN_PROGRESS** in the independent execution
`UU06-20260921-aem01` (intake PR #102 and idle-scheduler PR #103 merged); the earlier UU-05 closure's
stop boundary applies to that historical execution. The current execution has
re-read the remote baseline and project authority; see `rounds/UU-06.md`.

The intake/control implementation and idle-scheduler correction are deployed at
runtime `107795acbb17dbbd17ea9e5f1963c39d39a91957`; exact-main verification is
recorded in [idle-scheduler evidence](../GMAIL_IDLE_SCHEDULER.md).
Consent schema `20260921053337`, execution-controls schema `20260921055432` and
idle-scheduler migration `20260921065934` are applied. Manager readback confirmed
zero enabled bindings, expanded grants and execution rows. The Gmail command now
skips HTTP enqueue unless an enabled non-revoked binding exists, including legacy
NULL-consent users. Gmail cadence remains `5 * * * *`; Discovery is unchanged.
The execution-control flag remains default-off/unactivated. Prior 072b intake evidence
remains [historical deployment evidence](evidence/UU-06-runtime-072b2fe.md).

Next: obtain one explicit first-party owner Gmail intake opt-in from Settings, then
run the bounded live scheduled-intake canary and close UU-06 only if scheduled
processing, dedupe, stale-event protection and Today projection pass. Push/PubSub/
Billing remain outside the owner release gate. The linked Supabase organization plan is verified **free**, but actual
usage/quota and other backend cost headroom remain unknown. Hourly polling does not
meet p95 <2-minute / <=15-minute compensation requirements; zero live opt-in means
there is no certified workload. This checkpoint does not complete UU-06 or its
execution, and this execution does not start UU-07.

## UU-04 scope boundary

UU-04 changed Web information architecture, routing/hosting fallbacks, Today presentation, Web
Semantic Intake adaptation, DecisionRequest presentation, browser persistence receipts and UX
verification only. It did **not**:

- implement UU-05 In Progress / Worth Pursuing opportunity-list redesign or conclusion-first detail;
- change Snapshot/database schemas;
- add or grant Gmail / PAIA / other source permissions;
- perform job applications, withdrawals, recruiting email or Offer actions;
- bulk-rewrite production workspace data;
- change release publication policy;
- publish a new GitHub Release.

## UU-05 closure — 2026-09-21

Implementation is complete on `main@d4b163b06902ae9b43123b98ec470b958c4c190e`
([PR101](https://github.com/haohongfei2001-png/pjsdas/pull/101)). The stale-active
PR100 implementation was preserved and continued from exact head `346c62f` on
an isolated manager branch; PR100 was closed as superseded, without rewriting it.

Delivered the shared Opportunities list/detail read model and conclusion-first
UI. Date-only/estimated deadlines retain their calendar day in the applicable
timezone; exact datetime deadlines retain instant-based expiry. Nearest-node
state and list/detail conclusions agree. No date-only clock time is fabricated.

New regression reproduced 4 failures on the old implementation. Corrected code
passes 673 unit tests, build and three targeted headless journeys including
Shanghai and Los Angeles boundaries. Two older browser fixtures had expired at
the real 2026-09-20/21 rollover; their declared clock is now fixed, with all
original assertions retained and all six related journeys passing.

PR head `437fa1900cfd6f688d9142863d56a85f7f4ea3a5`: CI and full Chromium success.
Exact merged implementation `d4b163b06902ae9b43123b98ec470b958c4c190e`:

- CI run `35547668102`: success.
- Full Chromium run `35547668091`: success.
- Exact-SHA backend / standby / Pages / deploy run `35547668135`: success.
- Production Self-Test run `35547741487`: success; frontend manifest commit equals
  `d4b163b06902ae9b43123b98ec470b958c4c190e` and contract/migration digests match.
- Release workflow `35547757705`: success with final publication still disarmed.

Historical UU-05 closure boundary: that closure commit changed documentation only,
with no workspace-data migration, permission expansion or final release publication.
UU-06 was READY and was not started by that execution. The current independent
UU-06 execution is tracked above; the historical receipts remain unchanged.

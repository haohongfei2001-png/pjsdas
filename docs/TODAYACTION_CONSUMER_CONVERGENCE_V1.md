# TodayAction Consumer Convergence v1 — Canonical Development Plan

Package: `TODAYACTION-CONSUMER-CONVERGENCE-v1`  
Owner decision: **APPROVED — 2026-10-07 (Asia/Shanghai)**  
Implementation status: **NOT STARTED by this documentation change**  
Next implementation batch: **B1 — business semantics and authoritative boundaries**

## 0. Authority, scope, and execution boundary

This is an executable plan for the approved small-scope convergence. Design exploration is closed. The latest Owner amendments in §1 supersede the earlier design report and conflicting historical Discovery/scoring/product proposals. The existing authority, authentication, idempotency, audit, compensation, and release identity rules remain in force.

User-facing language is **今天 / 岗位库 / 日程**; a single item is a **岗位**. Localized English uses **Job library / job**, never Opportunities as the consumer navigation or object name. Internal `Opportunity`, `opportunityId`, routes, storage keys, API names, and historical receipts remain stable unless a functional contract change actually requires otherwise.

**This PR is documentation and necessary design-reference updates only.** It does not authorize or perform product implementation, database/schema changes, production configuration, migration execution, deployment, release publication, or production-data writes. Create the documentation PR, report it, and stop. Do not merge or start B1 as an automatic continuation of this documentation task.

At the next explicitly requested implementation task, reconcile once against remote main, the current affected writer, canonical execution rules, and exact-head checks. Continue the existing writer when one owns the affected boundary. Do not create a parallel runtime implementation.

### 0.1 Verified planning baseline

| Fact | Evidence / implication |
| --- | --- |
| Remote main at planning start | [`7c617fce846ef4d35939e753ff005ad0cceb3f7d`](https://github.com/haohongfei2001-png/pjsdas/commit/7c617fce846ef4d35939e753ff005ad0cceb3f7d), merged PR #255; scoring retirement is already present. |
| Main CI snapshot | [CI run 37545147314](https://github.com/haohongfei2001-png/pjsdas/actions/runs/37545147314) is successful for that SHA. This is not evidence that the new contract is implemented. |
| Existing runtime writer | [PR #256](https://github.com/haohongfei2001-png/pjsdas/pull/256), `fix/separate-schedule-operations-20261006`, head `f792c2e63a953fbd0aef0725e474db2a77d59283`, open at reconciliation. |
| #256 checks at that head | `ci-build` successful; latest observed [Chromium run 37548919548](https://github.com/haohongfei2001-png/pjsdas/actions/runs/37548919548) and [Firefox/WebKit run 37548919523](https://github.com/haohongfei2001-png/pjsdas/actions/runs/37548919523) failed. Do not report the runtime candidate as certified. Its existing writer owns repair and closure. |
| #256 overlap | Separates operation receipts from Schedule and preserves history. It still includes application-deadline nodes and some non-appointment process facts in Schedule; it does not remove Discovery-created apply Actions, retire roleType, or implement source-free manual creation. |
| Production uncertainty | No production cron state, latest real Discovery execution, provider search trace, or account workspace write was inspected or triggered by this task. Existing code and passing historical gates do not establish current daily-search success. |

The documentation track does not take over #256 or alter its code/status. The historical PCR STATUS still contains its own earlier closure/writer snapshot; do not overwrite that history with this package. Runtime ownership at implementation start comes from fresh GitHub facts. The [existing execution protocol](post-closure-reliability-v1/EXECUTION_PROTOCOL.md) permits independent documentation evidence when it cannot race runtime truth.

## 1. Final Owner amendments and frozen decisions

| Decision | Required result |
| --- | --- |
| Preserve current job-library queries | Retain all eight existing query labels, keys, and supported meanings; add **新发现**. Do not replace them with the earlier five-view proposal. |
| Consumer naming | Use **岗位库 / 岗位** across new navigation, headings, empty states, receipts, accessibility labels, and design references. No mass rename of internal Opportunity code. |
| One manual-entry route | Remove the proposed job-library-specific **添加岗位** button. Existing global **＋** opens Tell TodayAction; its existing-style **手动填写岗位** mode is the structured fallback. |
| Local Discovery control | Job library retains **搜索范围** as its page-specific operation. The approved Search Scope dialog, refinement interaction, theme, spacing, and components remain unchanged. |
| Two AI capabilities | Intake interprets inputs; Discovery finds candidates. No independent AI Center, generic chat page, recommendation system, or second visual system. |
| Discovery trust boundary | AI/search discovers candidates; actual recruiting pages or trusted recruiting sources establish job existence and field facts. Only verified automatic candidates may be durably saved. |
| Intake write boundary | The model returns strict candidate facts. The application owns `Semantic Intake → Domain Command → authoritative write → receipt / undo / idempotency`. The model never directly modifies a database. |
| User choice | Discovery does not score, rank, recommend, assign roleType, set job priority, or decide whether a job is worth applying to. |

The [revised approved design reference](todayaction-consumer-convergence-v1/OWNER_APPROVED_DESIGN.pdf) illustrates these amendments using synthetic jobs and times. It is a visual reference, not runtime/search evidence. This canonical plan controls implementation details if illustrative copy conflicts with it.

## 2. Current state → target state and exact implementation seams

All main-path references below were inspected at the fixed baseline in §0.1. Resolve their current versions when starting the implementation; do not replay an old diff blindly.

| Area | Current state | Target / files to change when implementation is authorized |
| --- | --- | --- |
| Scoring | Already retired at write/read boundaries; historical slots remain | Reuse [scoringRetirement.ts](../src/scoringRetirement.ts). Keep old values decodable, never used as current decisions. |
| Automatic creation | Monitor, promotion, and MCP apply also create apply Actions | Remove the implicit Action from [autonomousIngestion.ts](../src/autonomousIngestion.ts), [discoveryPromotionCommand.ts](../src/discoveryPromotionCommand.ts), [mcpDiscoveryApplyCommand.ts](../src/mcpDiscoveryApplyCommand.ts). Retain atomicity, identity, source verification, and receipt accounting. |
| Explicit creation | `add_opportunities` exists, but requires source URL/title/roleType and creates an apply Action | Extend [addOpportunities.ts](../gateway/addOpportunities.ts) and its [serverFactory.ts](../gateway/serverFactory.ts) contract; reuse its identity/write path for explicit user-source creation, with no implicit Action. |
| Web source-free input | Web capture blocks a new job without canonical source; Intake has no standalone add-job candidate | Extend [progressInputPolicy.ts](../src/progressInputPolicy.ts), [model.ts](../src/model.ts), [gateway/semanticIntake.ts](../gateway/semanticIntake.ts), and existing domain commands. Reuse `OpportunityUserFacts.provenance = user_asserted`. |
| AI contracts | Worker/ingestion/proposal/ChangeSet require roleType and some rationale/legacy assessment fields | Coordinate [discoveryAutomationWorker.ts](../gateway/discoveryAutomationWorker.ts), [ingestSources.ts](../gateway/ingestSources.ts), [proposeChanges.ts](../gateway/proposeChanges.ts), [changeSet.ts](../src/changeSet.ts), model, MCP descriptions, and profile validators. Changing only a prompt or UI is insufficient. |
| Dates and Schedule | Opportunity deadlines and Action due dates generate nodes; snapshot normalization can reconstruct them | Change [scheduleNodes.ts](../src/scheduleNodes.ts), [snapshot.ts](../src/snapshot.ts), [applicationDeadline.ts](../src/applicationDeadline.ts), and domain scheduling/correction commands together. One eligibility rule applies to creation, migration, projection, replay, and restore. |
| Schedule consumption | Stream and Today consume legacy/canonical nodes and some non-appointment facts | Continue #256 in [scheduleStream.ts](../src/schedule/scheduleStream.ts), [ScheduleFeature.tsx](../src/schedule/ScheduleFeature.tsx), [TodayFeature.tsx](../src/today/TodayFeature.tsx); apply §5 to both future and history. |
| Query classification | Eight existing filters, exclusive business category; `hasApplicationEvidence` currently also trusts apply Action `done` | Preserve [JobLibrary.tsx](../src/jobs/JobLibrary.tsx) filters and [classifyJob](../src/applicationDeadline.ts) meanings. Add unread separately; tighten evidence so a generic checkbox cannot fabricate application history. |
| Intake understanding | Tell uses progress parsing; Gmail uses recruiting-notification rules; both reuse part of the semantic write core | One interpretation service and schema; retain [webSemanticIntake.ts](../src/webSemanticIntake.ts), [webSemanticInterpretation.ts](../src/webSemanticInterpretation.ts), [gmailAutomation.ts](../gateway/gmailAutomation.ts), [gmailSemanticIntake.ts](../src/gmailSemanticIntake.ts), and [semanticIntake.ts](../src/semanticIntake.ts) as adapters/core seams. |
| Search profile | Complex preferences and old monitor themes survive | Keep existing profile fingerprint/CAS/Undo mechanisms in [discoveryProfile.ts](../src/discoveryProfile.ts), [discoveryProfileManagement.ts](../src/discoveryProfileManagement.ts), [authoritativeCommands.ts](../gateway/authoritativeCommands.ts). New scope is only the user's confirmed readable search criteria. |

## 3. Product invariants

| ID | Invariant |
| --- | --- |
| I01 | A new automatically discovered job adds Opportunity only: no implicit Action, Process, or Schedule occurrence. |
| I02 | Explicitly saving a new user-source job adds Opportunity only; company and job title suffice, URL is optional. Saving is not an application decision. |
| I03 | No new fitScore, opportunityValue, roleType, AI ranking, recommendation tier, priority, or value rationale enters the new Discovery contract or influences its results. |
| I04 | Opportunity application deadline is a job fact. It does not create a Schedule event, task, or fabricated time. |
| I05 | Action requires a real user decision or a concrete recruiting obligation. An external JD saying “apply now” is neither user intent nor proof of application. |
| I06 | A chosen execution date determines Today membership; a deadline is not a chosen time. Only an explicitly timed Action has Schedule eligibility. |
| I07 | A confirmed recruiting appointment/event has Schedule eligibility; a received notification timestamp, submission receipt, process closure, or generic task checkbox does not create an appointment. |
| I08 | The same timed Action or recruiting occurrence keeps its identity across Today, Schedule, reschedule, reload, retry, and history. Do not duplicate business objects for display. |
| I09 | Public posting availability and the user's recruiting process are independent. Posting closure or failed fetch does not cancel an interview or end the user's process. |
| I10 | Models return candidate facts only. Trusted code owns identity, intent authorization, source validation, time interpretation checks, domain commands, authoritative state, CAS, and compensation. |
| I11 | Search success, source verification, and durable commit are distinct. No “success” claim from an enabled switch, model text, URL list, HTTP 200, or mock result alone. |
| I12 | Old clients, MCP contracts, background retries, normalization, imports, and Undo cannot reintroduce I01/I04 violations. |
| I13 | Preserve raw historical facts, relations, source evidence, and receipts. Preservation does not grant Schedule eligibility or justify destructive bulk cleanup. |
| I14 | Preserve all eight job-library queries and add new-discovery unread state separately; do not repurpose the business category enum as unread/lifecycle state. |
| I15 | Preserve the current visual system and global entry structure. Every retained UI addition must have the necessity stated in §10. |

## 4. Information architecture and existing query compatibility

### 4.1 Consumer surfaces

- **今天**: today's user-planned Actions and genuine due/overdue process obligations; the side panel uses the same eligible upcoming arrangements as Schedule.
- **岗位库**: every saved job from Discovery, email, user input, or existing data; existing queries plus 新发现; company/title search and contextual details remain.
- **日程**: confirmed recruiting events/meetings and explicitly timed Actions; history follows the same eligibility rule as future items.
- **Global ＋**: Tell TodayAction, with a manual job form in the same Intake surface. No job-library-specific add button.
- **搜索范围**: the only job-library-specific page operation; existing-style small dialog, readable criteria, natural-language refinement, pause/resume.
- **设置 / related detail**: account, email connection, recovery/export, original-source evidence, operation records, and necessary low-frequency troubleshooting. No new AI dashboard or second Inbox.

### 4.2 Keep the eight queries, add one orthogonal query

The current keys below are React `JobFilter` values, not existing URL parameters. Preserve `/library` and `/opportunities` compatibility; no route migration is needed for naming.

| Query label | Key | Meaning to preserve |
| --- | --- | --- |
| 新发现 | New filter value, e.g. `new` | Newly persisted background jobs not yet viewed by this account; independent of business category. |
| 全部 | `all` | Every saved job, including unknown/unclassified and historical items. |
| 待投递 | `to_apply` | Existing unsubmitted category with a confirmed, not-expired application deadline. |
| 已投递 | `applied` | Existing screening/assessment category, before written-test/interview categories. |
| 收到笔试 | `written_test` | Existing written-test stage query. |
| 收到面试 | `interview` | Existing interview-stage query. |
| 流程结束 | `process_ended` | Existing offer/ended-with-application-or-result/abandoned-after-application query. |
| 时间截止 | `deadline_passed` | Existing unsubmitted jobs whose posting is explicitly closed or confirmed application deadline is past. |
| 无截止日期 | `no_deadline` | Existing remaining unsubmitted jobs without a confirmed deadline. |

Preserve `classifyJob` precedence for equivalent verified facts: unknown → no special category; offer/qualified closed/qualified abandonment → process ended; other closed/abandoned → only all; interview; written test; screening/assessment; remaining unsupported/submitted cases → only all; then closed/expired posting; then confirmed deadline; otherwise no deadline. Do not silently fold no-deadline jobs into 待投递 or interview jobs into 已投递. Tightening an incorrect evidence inference is required by I05/I07, not a new classification design.

Preserve company/title search, existing 40-item incremental loading, and the eight queries' current factual deadline ordering (unknown dates last, stable ties). **新发现 alone uses discovered/added time descending.** This keeps existing query behavior while showing arrivals naturally; do not add a sorting control or value ranking.

### 4.3 New-discovery state

- Background first-time additions (Discovery or an authorized email that establishes a new job) are eligible for 新发现 after durable commit. User-confirmed/manual additions are already viewed.
- Opening detail marks the item viewed; merely visiting the page or scrolling does not. Keep the current row/detail stable until the view is recomputed; do not remove a focused row underneath the user.
- Do not force navigation, interrupt Today, require accept/promote, or re-mark a duplicate, source refresh, scope edit, or reopened posting as new.
- Preserve selected view and scroll behavior. Initial behavior may retain current 全部; show the 新发现 count without forcibly selecting it. No auto-switch is needed.
- Existing pre-cutover jobs default to already viewed unless reliable existing unread evidence says otherwise. Do not turn the whole historical library into “new”. Account-scoped read metadata uses the existing authoritative metadata path; it is not a new lifecycle model or shared mutable browser authority.

## 5. Data ownership and time semantics

| Input / behavior | Owned facts | Today / Schedule result |
| --- | --- | --- |
| Discover a unique job, with or without an application deadline | Opportunity + verified source facts | No Action; no Schedule. |
| Global ＋: “保存这家公司这个岗位”, no official URL | User-source Opportunity | No Action; no Schedule. |
| “我要投这个岗位”, no execution date/time | Explicit application Action | Retain in job detail as unplanned; do not automatically schedule today or calendar time. |
| “加入今天” | Existing/create application Action with explicit local-day plan | Today; no concrete Schedule time. Repeated click must not duplicate the Action. |
| “明天 15:00 准备材料” | One Action with explicit date/start/timezone evidence | Same Action in tomorrow's Today and Schedule; no second independent task. |
| Click an external application link | Navigation only | No submission fact and no automatic completion. |
| Explicit “我已投递” or verified submission receipt | Application/process fact; complete matching application Action if present | No calendar appointment; job category uses actual evidence. |
| Invitation: “周五前完成测评” | Process fact + assessment Action + real completion deadline | No all-day/calendar block. Today according to an explicit plan or genuine due obligation. |
| Confirmed interview at a specific time | Process Event with real appointment time | One eligible Schedule occurrence/projection. |
| Confirmed interview on a date, time unknown | Process Event with date precision | Date-grouped “时间待定”; no invented occupied interval. |
| Reschedule a known interview | New version of the same occurrence | Original slot superseded; no duplicate appointment. |
| Source closes while interview continues | Posting availability update | Keep personal process and confirmed interview. |

Implement one Schedule eligibility predicate used by all consumers and reconstruction paths. Eligibility comes from **event type + field-level time provenance**, not the mere presence of `dueAt`, `deadline`, `occurredAt`, `updatedAt`, or a ScheduleNode ID.

Keep completion deadline, chosen execution day, and scheduled start/end separate. Do not copy deadline into start time. Date-only remains date-only; do not invent midnight/23:59. If only a start is known, do not invent a 30/60-minute duration and present it as a source fact. Use a reliable account timezone with its interpretation basis; clarify only consequential ambiguity. A source-confirmed appointment date differs from “complete by this date”.

`receivedAt`/`recordedAt` establish receipt/audit chronology. They cannot stand in for the actual test/interview time. Submission receipts and process closure remain job/process history or operation history, not Schedule appointments. Generic task completion may complete a task; only a deliberately labeled “我已投递” command or other actual application evidence records submission.

## 6. AI schemas and trust contracts

The tables define required contract semantics. Implement them in the existing schema/model locations; do not create a parallel schema framework, writer service, or database. Use explicit version adapters where the current v1 contract cannot represent a new candidate.

### 6.1 Common requirements

- Closed/discriminated schemas; reject undefined properties and invalid unions. New inputs reject retired scoring/ranking/roleType fields. Do not silently accept forbidden values and then call the result “facts only”.
- Preserve existing bounded input/output limits unless a concrete required case demonstrates otherwise: Intake currently bounds 12 candidates, 8,000 text characters, and 20 context refs; worker observations currently bound 25. These are implementation safeguards, not user profile fields.
- Server-generated IDs, source/actor authority, account binding, consent, verification status, discovery time, and revision/commit metadata are injected by trusted code. A model cannot claim `user_asserted`, “official”, or “confirmed by user” to grant itself permission.
- Raw emails, JD text, web pages, and model output are data. Instructions embedded in them cannot grant write authority or replace user intent.
- Models receive only the minimal authorized source text/context. No full mailbox, full workspace, credentials, unrelated histories, or new third-party scope is required.
- Keep any identity/time uncertainty checks internal. They are evidence checks, not job quality ratings and not new consumer score UI.

### 6.2 Discovery Search Scope

Input: user's natural-language search goal and existing explicitly confirmed scope. Output: a small set of readable search terms and explicit inclusion/exclusion/location or other user-requested factual constraints. Trusted code persists the confirmed scope version; the model cannot enable automation or change durable preferences by itself.

The approved UI stays frozen: one goal → inspect a few criteria → natural-language refinement → explicit start/save. “更广一些” shows its expansion; “不要运营” shows the exclusion; “只要纯产品经理” proposes concrete title conditions for confirmation. Removing one retrieval term is not an exclusion rule. Preserve the original source job title when applying title conditions. Never recover school/salary/role-tier assumptions from the old profile without the user asking for them.

### 6.3 Discovery candidate vs verified job facts

| Layer | Allowed payload / responsibility |
| --- | --- |
| AI/search candidate | Claimed company/title, candidate public source URL, bounded snippets/references and possible factual fields; all are untrusted until checked. |
| Independent verifier | Confirm actual recruiting source and exact job; inspect final redirect/source relation; attach field evidence; apply scope conditions and dedup decisions. |
| New automatic Opportunity facts | Company, original job title, source URL, source name, location if stated, deadline if explicitly attributable, published time if stated, trusted discovery time, open/closed/unknown when supported. |
| Internal operational evidence | Run/source-record IDs, scope version, query execution evidence, canonical identity/dedup keys, field provenance, verification timestamp, receipt and committed revision. These are not extra job-value fields. |

No compensation guess, fit/value score, roleType, recommendation reason/tier, or job priority in the new automatically discovered job payload. Source HTML merely containing a company, title, and some date is insufficient date evidence. Preserve precision and explicit unknowns. Do not persist raw search dumps/full page bodies when bounded proof references suffice; retain enough evidence to reproduce the relevant factual conclusion using existing receipts/evidence facilities.

### 6.4 Unified Intake candidates

Keep the existing `SemanticIntakeObservation` source envelope and `statementMode` distinction between assertion/current intent and question/quote/example/hypothetical/rewrite. Add the minimum missing **explicit user job creation** candidate; adapt it to the existing add-job/domain path instead of introducing a second create engine.

Candidate meanings include the existing application-submitted, process-event, opportunity-deadline, occurrence completion/cancellation/reschedule, manual-action and other supported bounded domain operations. For this package, ensure the required meanings are represented without conflating them:

| Candidate meaning | Minimum required evidence / fields |
| --- | --- |
| Explicit user job creation | Company + job title; optional URL/location/source-stated dates; actual first-party/authorized user intent from input context. |
| Job fact update | Resolved target and explicit changed facts with provenance; never an implicit application Action. |
| Application submitted | Exact job identity and genuine submission statement/receipt; unknown historical time stays unknown. |
| Action creation / plan day | Concrete task and explicit intent/obligation; chosen execution day distinguished from completion deadline. |
| Action time arrangement | Action identity or one new Action; explicit scheduled start and timezone basis; end/duration only if supplied. |
| Recruiting appointment / reschedule | Job/process identity, occurrence identity when updating, explicit event and time evidence; distinguish invitation receipt from event time. |

Structured manual input may skip the model but enters the same validation/domain commit path. Do not bypass authority by writing a form directly to persistence. Source channel (`web`, `gmail`, `mcp`) and fact provenance (`user_asserted`, verified recruiting source, etc.) remain distinct.

### 6.5 Compatibility adapters

- New writer schema rejects retired fields; old snapshots remain decodable/exportable/undoable. Extend optional/versioned fields instead of inventing a default `core` roleType for new jobs.
- Reuse existing scoring-retirement projection. Historical numeric slots or role tags are opaque compatibility data, never evaluated, exposed as current judgments, or sent back to the new model.
- Update worker, `ingestSources`, `proposeChanges`, `addOpportunities`, `changeSet`, profile validators, server tool descriptions, and the actual published MCP schema coherently. A prompt-only change is not completion.
- Old request versions may use a bounded adapter only if the new invariants can be proven. Otherwise return an explicit unsupported/retired contract outcome and refresh the client; do not widen new schema validation or silently execute old side effects.

## 7. Discovery's real background execution chain

### 7.1 Reuse the actual existing chain

| Step | Current seam and required behavior |
| --- | --- |
| Explicit opt-in | Preserve existing automation consent; clicking first-run start records opt-in separately from saving criteria. Existing paused state stays paused on scope edits. |
| Scheduler | [2026091904_activate_automation_scheduler.sql](../supabase/migrations/2026091904_activate_automation_scheduler.sql) defines the hourly wake (`15 * * * *`) toward `/api/automation-discovery`; source cadence determines due work. This is source-code evidence, not current production state. |
| Claim/authentication | [automationConnectionStore.ts](../gateway/automationConnectionStore.ts), existing worker token/lease and [opt-in migration](../supabase/migrations/2026091504_discovery_automation_opt_in.sql); revoked/unconsenting accounts cannot run. No new OAuth or permission model. |
| Request and worker | [api/automation-discovery.ts](../api/automation-discovery.ts) → [discoveryAutomationHandler.ts](../gateway/discoveryAutomationHandler.ts) → `runDiscoveryAutomationForBinding`. |
| Authoritative read / due plan | Read the connected transactional workspace, confirmed scope fingerprint/version and last durable source completion. Reuse [discoveryAutomation.ts](../src/discoveryAutomation.ts), source cadence, budgets and existing authority selection. |
| Real retrieval | Execute actual public-web search with recorded query/provider execution proof. Current `perplexity/sonar` invocation is a reusable integration seam, not proof that every response searched. |
| Verify and dedup | [discoverySourceVerifier.ts](../gateway/discoverySourceVerifier.ts), [jobPosting.ts](../src/jobPosting.ts), [opportunityCanonicalization.ts](../src/opportunityCanonicalization.ts): independent bounded public-source fetch, factual validation, identity and duplicate accounting. |
| Domain apply / durable commit | Verified-fact adapter → existing validated Domain Command boundary → authoritative transactional workspace source/store → receipt and readback. Reuse hardened ingestion as the adapter/core, enforce I01 across every route, recheck scope/version, and retain revision checks. Direct CAS persistence is not a substitute for domain validation. |
| Receipt/status | Actual created/updated/duplicate/filtered/unresolved counts, partial failures, committed revision and last successful completion. Count新增 only after commit. |

The four old Source Registry monitor identities are thematic objectives, not a list of trustworthy recruiting sites. Replace their hidden “urgent campus / state-foreign / middle-layer” product assumptions with the confirmed scope and actual source verification. Preserve bounded cadence/run accounting. Do not build a user-facing source editor or new crawling platform.

Monitor, promotion, signed MCP Discovery apply, and explicit `add_opportunities` are entry adapters, not independent business writers. All must reuse the common validated domain-command/authoritative commit and receipt boundary. A verified Discovery fact need not call the natural-language Intake model again; it still has no exemption from domain invariants. Do not leave a direct snapshot/CAS mutation route that bypasses those checks.

### 7.2 Required behavior per run

1. First opt-in queues a real first run; daily execution works independently of an open browser, according to the existing scheduler and account-local day/cadence rules.
2. Store the scope version used by retrieval. Before commit, re-read current authority and consent. Narrowed scope or revoked consent prevents stale new additions. Retry valid current work without replaying a costly search unnecessarily on a simple CAS conflict.
3. Verify page accessibility and source authority separately. Retain current public-URL/redirect/network protections; a model-provided URL does not grant arbitrary network or credential access.
4. Match dates to this job and their actual meaning. Search snippet dates, copyright dates, crawl times, or campaign dates without applicable evidence cannot become job deadlines/published times.
5. Same stable source/job identity is idempotent. Tracking variants merge; different real locations/batches must not merge merely because company/title match. User-source jobs later verified by a real source retain their identity when equivalence is proven.
6. New verified jobs commit as Opportunity only. Source updates may refresh existing facts without ending a personal process; network failure does not manufacture closure or reopening.
7. Account for every candidate using existing ledger outcomes. Verify real retrieval even on a completed zero-result run. Partial source failures remain partial; successful saved jobs remain saved.
8. Emit one concise user status. Update `last_success` only for the relevant actually successful durable unit; never convert attempts into success or assert “retrying” without queued/running retry work.

Required production proof joins one real scheduled/authorized run's query execution, real source access, verified fields, dedup decision, command/receipt, committed workspace revision, and authoritative readback. Also observe a subsequent scheduler-triggered daily run. Mock fixtures and screenshots cannot satisfy this gate.

## 8. Gmail / Tell / manual unified Intake chain

Input adapters retain their own collection mechanisms; interpretation and domain semantics are shared.

| Entry | Collection adapter | Common outcome |
| --- | --- | --- |
| Global ＋ / Tell | `TellPjsdasCapture.tsx`, `webSemanticIntake.ts`, `webSemanticInterpretation.ts` | Candidate facts from text/JD/notification → validated Semantic Intake. |
| Gmail | `gateway/gmailAutomation.ts`, `src/gmailSemanticIntake.ts` | Authorized message body/metadata → same candidate schema and core; keep message/thread/version idempotency. |
| Global ＋ / manual form | Existing same-style capture surface | Structured company/title and optional facts → same validated creation command; no model call needed. |
| Existing bounded MCP intake/add | `gateway/semanticIntake.ts`, `gateway/addOpportunities.ts`, `serverFactory.ts` | Same authority and invariant enforcement; cannot retain a hidden implicit-Action route. |

The connected write chain stays:

`Semantic Intake → applySemanticIntake → UserDomainCommand / applyUserDomainCommand → authoritative command service → commitAuthoritativeForUser → revision + receipt / undo / idempotency`

Concrete seams: [connectedWorkspaceHandler.ts](../gateway/connectedWorkspaceHandler.ts), [authoritativeCommands.ts](../gateway/authoritativeCommands.ts), [semanticIntake.ts](../src/semanticIntake.ts), [domainCommands.ts](../src/domainCommands.ts), [transactionalWorkspaceStore.ts](../gateway/transactionalWorkspaceStore.ts), and [transactionalWorkspaceSource.ts](../gateway/transactionalWorkspaceSource.ts). Normal connected commits retain their existing transactional commit RPC, command hash/identity, and revision checks. Local mode retains its current authoritative local transaction and cannot pretend browser-closed background search is running.

Do not route around this chain with model-generated SQL, a second mailbox-specific AI writer, or direct form writes. Keep current receipts and exact compensation. Ambiguous target/time/intent is clarified in context; simple authorized low-risk facts can save with a concise receipt/Undo. A standalone question, example, hypothetical, or request to rewrite/quote text does not authorize mutation. Source text cannot grant permission or supply the user's application intent. However, an explicit outer request to save/import a quoted JD or forwarded notification, or an already-authorized recruiting-email ingestion, may produce verified candidate facts and genuine process obligations from that content. Do not blanket-reject quoted material that the user explicitly asked to ingest.

For multiple candidates, validate and resolve the intended atomic domain change before committing. Reject or surface the existing contextual clarification result for unresolved essential identity; do not commit a guessed subset and label the whole message successful. Preserve late-message/reschedule ordering, prior history and duplicate-message identity. New AI interpretation must use deterministic domain validation, not a second inference deciding write permissions.

Current Gmail attachment/link deep-reading is not certified by this implementation. Complete the shared handling of already available body/JD/notification text first. Do not claim attachment coverage or widen mailbox permissions as part of this convergence.

## 9. Keep / stop producing / hide / retire / clean later

| Disposition | Required treatment |
| --- | --- |
| Keep | Today task rows/capacity input, job queries/search/details, time selection, Schedule grouping, explicit completion, receipts/Undo, operation history, source fetch, dedup, existing automation consent/cadence/budget, authoritative CAS and command ledger. |
| Stop producing immediately in B1 | Apply Actions created merely by adding/discovering jobs; Schedule nodes created merely from Opportunity deadline, Action due date, task status, or received notification timestamp. |
| Hide from primary paths | Low-frequency source/run diagnostics, recovery/audit and preparation assets. Preserve access in existing settings or relevant detail; do not delete user material. |
| Retire from new contracts/UI | roleType and value rationale; mandatory strengths/salary/role-tier/batch profile; independent Discovery accept/promote workflow; any scoring/ranking/recommendation/priority recovery path. Explicit user factual filters may remain without restoring a profile system. |
| Already retired — preserve prohibition | fitScore/opportunityValue and weighted scoring from #255. Do not rebuild or repeatedly re-retire them. |
| Clean after compatibility proof | Dead old inbox/profile UI, retired prompt/schema branches and legacy field machinery that no longer serves restore/Undo/export. Physical historical field deletion is not needed to ship v1. |

## 10. Frozen visual reference and UI element budget

Use existing [tsui02.css](../src/tsui02.css), [secondarySurfaces.css](../src/secondarySurfaces.css), [AppV8.tsx](../src/AppV8.tsx), [TellPjsdasCapture.tsx](../src/TellPjsdasCapture.tsx) and [approved task/schedule visual language](tasks-schedule-ui-v1/DESIGN_REFERENCE.md). Keep the A mark, current fonts/colors/spacing/radii, panel/row hierarchy, keyboard focus, and approximately 44px interaction targets. No restyling sprint.

| Retained adjustment | Why it cannot be removed from this scope |
| --- | --- |
| 新发现 and unread count | Makes durable background arrivals visible without a second Inbox or interruption. Existing eight query controls are retained, not newly invented. |
| 搜索范围 + short summary | User must inspect and correct a recurring search. One existing-style dialog owns first setup, editing and pause/resume. |
| Readable criteria and refinement field | User must see what AI expanded and correct actual inclusion/exclusion behavior. No rule-builder/chat transcript. |
| One truthful run-status line | Distinguishes no run, zero new jobs, partial failure and committed additions. No metrics dashboard. |
| Global ＋ manual mode | Necessary for a known job without an official link; uses the existing global capture entry. The separate page button is removed. |
| 加入今天 / 我已投递 in context | Establishes actual user intent and submission facts; external links cannot prove either. |
| Conditional structured preview | Makes ambiguous/multi-object changes reviewable; simple explicit input does not gain an extra confirmation gate. |
| Source facts vs personal progress in detail | Posting closure and personal process must not be conflated. No new primary navigation or opaque consumer concept. |

At 320/390px the retained filters wrap using the existing component behavior; do not replace them with a new navigation scheme. Primary actions remain reachable without hover. Labels, empty states, success receipts and accessible names consistently say 岗位库/岗位.

## 11. Implementation batches and allowed/forbidden scope

All four batches are future work. Each has a concrete completion gate; no new open-ended design phase is permitted.

### B1 — Business semantics and authoritative boundaries (first)

**Allowed:** the four creation paths in §2; shared domain command/type validation; user-source job creation; deadline ownership preservation; common Schedule eligibility; snapshot/legacy normalization and current consumers needed to enforce the boundary; related targeted tests. Update existing semantic/add contracts only as needed for these meanings.

Required work:

1. Resume/reconcile the #256 writer and its latest tests; preserve its operation-history separation. Repair/close its existing candidate under its writer or incorporate the approved boundary in that same affected writer. Do not open a concurrent implementation branch over the same state/mutation paths.
2. Make monitor, promotion, MCP Discovery apply and explicit `add_opportunities` add a job without creating an apply Action.
3. Add the missing explicit user creation candidate/domain route with optional source URL; provenance comes from the trusted caller/input, not the model.
4. Separate Opportunity deadline authority from Schedule eligibility, including deadline-correction, Action due-date projection, snapshot upgrade, normalize/restore and legacy reverse projection.
5. Require explicit Action time arrangement for Schedule; preserve same Action/occurrence identity. Keep real process appointments and genuine event history; exclude notification receipt/submission/closure records as appointments.
6. Tighten submission evidence: generic task completion is not application submission. Deliberate 我已投递 produces the explicit fact and may finish a matching Action.
7. Make old clients/jobs/retries pass the same guard or fail closed. Confirm backing-store deltas, not just hidden UI rows.

**Forbidden:** UI redesign, profile/Search Scope redesign, new AI model service implementation, provider migration, broad database normalization, auth changes, bulk production repair, new product capabilities.

**Exit gate:** acceptance A01–A10 and the relevant migration/compatibility cases pass against actual domain/authoritative paths; no route still produces implicit Action/Schedule. Existing date/identity/receipt/Undo protections remain.

### B2 — Fact-only Discovery and real daily execution

**Allowed:** worker/ingestion/proposal/profile/model contracts; source verification and factual extraction; current source/query plan, scheduler and transactional integration as needed; existing bounded telemetry and receipts; targeted contract/worker tests.

Required work: apply §6–7 end to end; remove roleType/value rationale across validators; minimal confirmed scope; no hidden old profile assumptions; verified dates/published time; source authority and cross-URL identity; race/consent checks; real query/source/commit proof; truthful zero/partial/failure states. Reuse existing cadence/budgets and provider integration unless it cannot supply required genuine search evidence.

**Forbidden:** ranking/scoring or salary/fit enrichment, independent discovery inbox, new search orchestration UI, arbitrary crawling infrastructure, new provider credentials or paid commitments without their existing authorization, raw private workspace export to a search model.

**Exit gate:** A11–A17 and A20's Discovery schema/forged-authority cases pass; real search + real source access + real durable commit/readback demonstrated on the authorized environment. Daily capability is not marked complete until a subsequent genuine scheduler-triggered run is evidenced. A pending production gate stays explicitly pending, not replaced with mock proof.

### B3 — Unified Intake and minimal consumer surface changes

**Allowed:** shared interpretation adapter/service under the existing Intake contract; Gmail/Tell/manual adapters; job-library 新发现 read state; labels, global capture manual mode, approved Search Scope binding and receipt copy; narrowly related UI/E2E tests.

Required work: one interpretation schema and deterministic write chain (§8); exact eight queries + new; no local add-job button; all consumer labels 岗位库/岗位; approved dialog unchanged; user-source path available from global ＋; actual committed results update the three pages without duplicate state. Keep current local responsiveness and optimistic receipt semantics consistent with authoritative commit/rollback.

**Forbidden:** new AI product surface, universal chat, visual redesign, replacing current query categories, mass Opportunity identifier rename, new email permissions, attachment-reading project, action recommendation engine.

**Exit gate:** A18–A22 plus end-to-end business delta checks pass; the same factual input through supported adapters has the same domain result. UI screenshots demonstrate the approved amendments at desktop and 320/390px. No prototype behavior is counted as production capability.

### B4 — Migration, compatibility closure, rollout and bounded cleanup

**Allowed:** versioned/idempotent migration adapters within existing storage contracts; safe read eligibility; export/restore/Undo compatibility; removing unused components/contracts only after proof; existing release/rollback evidence and required gates.

**Forbidden:** destructive history cleanup, whole-workspace restore as release rollback, new primary pages, a broad SQL/schema redesign, new production data repair without authorization, merging/releasing while claiming deferred gates passed.

**Exit gate:** §12–14 and A23–A27; stable candidate gets the repository's required complete boundary certification once. Exact-head and later exact-main/runtime evidence remain distinct. Physical legacy-field deletion may stay deferred without weakening the new product contract.

## 12. Data migration and historical compatibility

1. **Preserve deadline facts before removing their Schedule authority.** `resolveApplicationDeadline` currently reads canonical deadline nodes, correction ownership, tombstones and conflicts. Carry the effective job deadline/precision/evidence or explicit unknown into the job fact/correction representation using existing provenance; retain raw nodes/versions as historical evidence. Do not drop a valid deadline, revive an explicitly cleared date, or resolve a conflict by fallback to an old field.
2. **Stop all regeneration paths.** Cover `scheduleNodeForOpportunityDeadline`, `scheduleNodeForAction`, `migrateLegacyScheduleNodes`, `ensureScheduleContractInPlace`, `projectScheduleNodesToLegacyInPlace`, `setApplicationDeadlineScheduleNode`, snapshot upgrades, corrections, imports and Undo. Legacy evidence may remain stored while being ineligible for Schedule; new writers must not make a pseudo-appointment.
3. **Classify historical implicit Actions by reliable provenance.** Pure automatic unacted-on artifacts are retained as historical/compatibility evidence and removed from active task projections through an explicit reversible migration decision. Genuine user task changes, completion, intent and relations survive. “Edited” or a recent `updatedAt` alone cannot establish an explicit time arrangement.
4. **Separate evidence from visibility.** A user editing a job title/note does not make its deadline a scheduled event. Unknown provenance stays retained for contextual review and is not silently classified as an appointment. Do not create a new bulk-cleanup UI.
5. **Retain identity and references.** Keep job IDs, process/occurrence/action relations, source records, aliases, command IDs and compensation references. Equivalent later official evidence enriches a user-source job instead of replacing it with a second identity.
6. **Keep old receipts replay-safe.** Export/import, duplicate input, command retry and Undo use current invariant checks and version adapters. Preserve historical receipts; an old compensation payload cannot reactivate an invalid deadline projection or overwrite unrelated later user changes.
7. **Read/unread cutover.** Existing jobs default viewed unless reliable prior unread state exists. New background additions use trusted creation/discovery time and account-scoped viewed state. Scope changes and reprocessing do not mass-relabel history.
8. **Rehearse before any authorized production migration.** Use complete supported historical fixtures, compare counts/IDs/relations and effective fact values before/after, execute migration twice, export/restore and Undo/retry. Prefer additive snapshot compatibility; no new database normalization is required by this plan.

For a real deployment, use the current authorized migration mechanism and preserve an appropriate recovery point. The plan does not grant new production-repair permission or reuse a previously consumed one-time repair authorization.

## 13. Test and acceptance matrix

Counts below refer to a fresh unique job unless explicitly testing duplicates. Check **authoritative state, revision and receipt** as well as rendered projections. Schedule counts refer to eligible arrangements; retaining a raw historical record is not a new arrangement.

| ID | Scenario | Required result / evidence |
| --- | --- | --- |
| A01 | Verified automatic discovery saves N unique jobs | Opportunity +N; Action +0; Schedule +0; balanced ledger and committed readback. |
| A02 | Global ＋ manually saves company/title, no official URL | Opportunity +1; Action +0; Schedule +0; user provenance and stable ID. |
| A03 | Manual/automatic new job includes a real application deadline | Deadline remains a job fact only; no implied Action/datetime/Schedule. |
| A04 | “加入今天”, including repeated activation | One intended Action with today's plan; no concrete Schedule time and no duplicate. |
| A05 | “明天 15:00 准备材料” | Same Action has explicit local-day/start evidence and one Schedule projection; no duplicate task. |
| A06 | Fixed interview invitation | Real Process Event + eligible Schedule; receipt time is not the appointment time. |
| A07 | Assessment invitation with only completion deadline | Process/Action deadline retained; no fabricated Calendar time block or all-day event. |
| A08 | Date-only event / start-only event | Honest date/time precision; unknown start/end/duration remains unknown. |
| A09 | Application link / generic task check / 我已投递 | Link and generic check do not fabricate submission; explicit submission records correct fact and related task completion. |
| A10 | All four create routes and old clients | Monitor, promotion, MCP apply and add_opportunities enforce A01/A02; no bypass in legacy adapters. |
| A11 | Same posting rerun, tracking variants, source refresh | No duplicate identity; only evidenced updates, stable read status and idempotent ledger. |
| A12 | Same company/title, different location/batch or ambiguous identity | Do not wrongly merge; unresolved evidence stays bounded and truthful. |
| A13 | Candidate URL reachable but job/source/date proof invalid | No automatic job creation/false deadline; no fallback to forged user_asserted. |
| A14 | Scope narrows or consent revoked during a run | Stale additions not committed; jobs already saved retained; retries use current authorized scope. |
| A15 | Successful zero / partial source failure / write failure | Distinct accurate statuses; no false last_success or新增 count. |
| A16 | CAS conflict and crash/retry | Existing atomic/command idempotency retained; no duplicate business effects or unnecessary repeat search. |
| A17 | Actual first run plus subsequent scheduled daily run | Genuine search execution, source visits, verified facts, dedup, commit/receipt and authoritative readback; mock/model response alone fails. |
| A18 | Same supported fact via Tell/Gmail/manual adapter | Equivalent validated domain result; structured form may skip model but not authority. |
| A19 | Duplicate/quoted/late mail and interview reschedule | No duplicate fact; standalone questions/examples/hypotheticals do not authorize writes; explicitly requested quoted-JD/forwarded-notice import and authorized mail still yield valid facts/obligations; source instructions do not grant user intent; known occurrence updated and late old notice cannot overwrite newer arrangement. |
| A20 | Model returns retired/unknown fields or claimed actor/source permission | Strict schema rejection; trusted caller context remains authoritative; no raw model DB write. |
| A21 | Eight existing queries + 新发现, text search, pagination | All original labels and meanings preserved; unread orthogonal; no lossy five-view replacement. |
| A22 | UI entry/naming and responsive state | Global ＋ is sole manual add entry; 岗位库 has 搜索范围 only as page operation; user copy consistent; Search Scope/visual language unchanged; no clipping or broken focus. |
| A23 | Legacy deadline migration, corrections, cleared/conflicting dates | Effective job facts/tombstones preserved; invalid Schedule projections disappear and do not regenerate. |
| A24 | Migration twice + export/restore + old receipt/Undo replay | Stable result, retained IDs/relations/history, no implicit task/calendar revival or overwriting later edits. |
| A25 | Posting closes or fetch fails while interview exists | Source availability and personal process independent; confirmed event preserved. |
| A26 | Safe release rollback with later user writes | User facts and later writes retained; rollback does not restore retired side effects. |
| A27 | Connected/local authority, account switch, offline pending operation | Existing authority and isolation hold; local cache is not a second connected truth; no fake server automation in local mode. |

### 13.1 Reuse existing tests; change obsolete product expectations deliberately

| Concern | Existing suites to extend or revise |
| --- | --- |
| Creation, provenance and atomicity | [autonomousIngestion.test.ts](../tests/autonomousIngestion.test.ts), [discoveryPromotionAuthority.test.ts](../tests/discoveryPromotionAuthority.test.ts), [mcpDiscoveryApplyAuthority.test.ts](../tests/mcpDiscoveryApplyAuthority.test.ts), [addOpportunities.test.ts](../tests/addOpportunities.test.ts) |
| Source/search/scope/budget | [discoveryAutomationWorker.test.ts](../tests/discoveryAutomationWorker.test.ts), [discoverySourceVerification.test.ts](../tests/discoverySourceVerification.test.ts), [discoveryProfileManagementWorker.test.ts](../tests/discoveryProfileManagementWorker.test.ts), [discoveryBudgetBoundary.test.ts](../tests/discoveryBudgetBoundary.test.ts), [discoveryBudgetGuard.test.ts](../tests/discoveryBudgetGuard.test.ts) |
| Scheduler contract | [automationSchedulerActivation.test.ts](../tests/automationSchedulerActivation.test.ts), [automationSchedulerMigration.test.ts](../tests/automationSchedulerMigration.test.ts) |
| Dates, categories and migration | [applicationDeadlineCorrection.test.ts](../tests/applicationDeadlineCorrection.test.ts), [scheduleNodes.test.ts](../tests/scheduleNodes.test.ts), [semanticIntakeMigration.test.ts](../tests/semanticIntakeMigration.test.ts) |
| Intake and authority | [semanticIntake.test.ts](../tests/semanticIntake.test.ts), [semanticIntakeGateway.test.ts](../tests/semanticIntakeGateway.test.ts), [webSemanticIntakeCompletion.test.ts](../tests/webSemanticIntakeCompletion.test.ts), [gmailSemanticIntake.test.ts](../tests/gmailSemanticIntake.test.ts), [authoritativeCommands.test.ts](../tests/authoritativeCommands.test.ts), [connectedWorkspaceHandler.test.ts](../tests/connectedWorkspaceHandler.test.ts) |
| Scoring stays retired | [deadlineOnlyPolicy.test.ts](../tests/deadlineOnlyPolicy.test.ts), [scoringReadReview.test.ts](../tests/scoringReadReview.test.ts) |
| #256 runtime work | Continue its `tests/scheduleOperationBoundary.test.ts`, `tests/timelineOperationRecords.test.tsx`, and `e2e/scheduleOperationBoundary.e2e.ts` from the active/merged writer, not a copied parallel suite. |

Some tests intentionally encode superseded behavior: “new opportunity and apply action”, promotion/add creating both objects, and migration of application deadlines to Schedule. Update those assertions to the Owner-approved deltas while retaining their atomicity, source, identity, authorization, idempotency, time and Undo coverage. Do not delete/skip a genuine reliability regression to make a candidate pass.

Use targeted affected suites and type checks during the coherent batch. For a stable runtime candidate, run the existing required CI/build/browser/matrix boundary gates once and repeat only to resolve a concrete failure or a changed candidate. Do not add a new testing platform, fake production fixtures, or repeated full-suite runs just to show activity. Documentation-only validation is separate from future runtime certification.

## 14. Production rollout and rollback requirements (future execution)

### 14.1 Rollout order

1. Reconcile incumbent writer and exact deployed/main identities. Close or continue #256 without a parallel runtime branch; record ownership at the actual implementation batch start.
2. Land backend/domain invariant enforcement and compatible readers before UI or new workers depend on it. Every Web/MCP/Gmail/Discovery writer must obey the same semantics; reject/drain incompatible old queued work rather than accepting its implicit effects.
3. Rehearse migration, new writes, old requests, compensation and restore on supported isolated data. Retain factual identity and source evidence. A database migration, if truly needed, must be additive and bounded; no production mutation is performed by this docs PR.
4. Obtain applicable exact-candidate gates under current [release policy](RELEASE_POLICY.md), [production topology](PRODUCTION_TOPOLOGY_V1.md), and [authority contract](AI_OPERATED_PRODUCTION_V1.md). Keep backend/frontend commit and capability compatibility verifiable. Do not change release arming or permissions as an incidental part of this package.
5. Roll out the compatible domain/read changes, then scope/worker/Intake/UI behavior in the approved batches. Keep unsupported automation disabled or explicitly pending while its dependency is not ready; do not display simulated success.
6. On an already authorized account/environment, record one real search→source→commit→readback chain and the subsequent scheduler-triggered run. Verify opt-in pause/revoke and a zero/partial/failure case. Read-only inspection alone cannot certify a write path.
7. Record exact main/runtime identity, schema/contract version, migration receipt, relevant gate results, remaining deferred items and operational rollback target. Do not call the package fully complete while A17 is pending.

This plan does not grant new account permissions, paid services, recruiting actions or arbitrary private-data repairs. Existing authorization applies only within its actual bounds. An external dependency may remain deferred with dependent behavior clearly disabled/pending; it cannot be labeled PASS.

### 14.2 Rollback

- A rollback target must retain I01–I12. Never return to a build that recreates apply Actions from Discovery or Schedule from job deadlines simply because it was the previous release.
- If no compatible target exists, stop the affected automatic write path and retain readable saved facts plus supported safe manual/domain operations. Do not re-enable legacy automation as a fallback.
- Keep domain compatibility guards when reverting a UI or model adapter. Do not revert schema/read compatibility while newer records or commands still exist.
- Rollback is not a whole-workspace snapshot overwrite. Keep user actions and facts written after rollout; compensate only the affected command/migration through the existing guarded mechanism when valid.
- Retain receipts, audit history and evidence of partial commits. State recovery must not destroy idempotency keys or cause the next worker run to replay previous effects as new.
- Trigger rollback/pause for concrete invariant violations, duplicate/incorrect durable writes, source-validation bypass, loss of existing facts, or incompatible clients. A zero-result search alone is not a rollback signal.

## 15. Deferred work and non-goals

**Not part of this package:** another visual refoundation; AI Center; generic chat; scoring/ranking/role tiers; recommendation reasons; complex profile forms; source orchestration dashboard; autonomous applications/withdrawals/recruiting messages; broader OAuth; native/iPhone projects; a new crawling platform; mass Opportunity renames; relational data-model rewrite; new release publication.

**May remain deferred after safe runtime convergence:** physical deletion of historical retired fields; obsolete compatibility cleanup that still protects Undo/export; device/provider checks requiring separately unavailable access; attachment/link deep-reading beyond current collection support. Record the exact limitation without advertising the capability.

**Cannot be deferred while claiming the promised capability complete:** verified source-backed job creation, no implicit Action/Schedule, source-free explicit manual creation, shared Intake domain semantics, preserved query access, truthful durable status, real daily search proof, and safe compatibility/rollback.

## 16. Documentation change set and handoff

The documentation PR contains this canonical plan, minimal links/precedence notes in necessary README/planning documents, and the revised approved design PDF. It does not alter `src/`, `gateway/`, `api/`, `supabase/`, product tests, dependency manifests, workflow/configuration, or deployment files.

Documentation validation: verify all relative source/test references against the fixed GitHub tree (or explicitly identify #256-only files), check Owner amendments and acceptance coverage, visually inspect the revised design, and inspect the final PR file list/diff. No product-suite PASS or production capability claim is created by those checks.

Handoff: **start B1**, after fresh reconciliation with #256's actual status/head and the affected single writer. The first deliverable is authoritative business semantics, not a UI-only rename. The current documentation task ends after reporting its PR; implementation and production rollout remain unexecuted.

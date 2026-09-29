# TODAYACTION-ZERO-MAINTENANCE-CORE-v1

This new owner-authorized package starts from remote `main@a98358a0565c0200fc7da73dce6e747050ced771`. It does not reopen the closed CGR, TSUI, PCR, or owner-recovery packages. GitHub remote main and deployed runtime must be rechecked before every phase. The owner has authorized ordinary code, schema compatibility, tests, CI, deployments, read-only production checks, and exact-head merges continuously. Production business-record rewrites, deletion, Gmail cursor/scope changes, external communications or applications, purchases, and irreversible production mutations remain outside this authorization.

## Product contract

Today contains only achievable actions, near-term commitments, and concrete business questions that cannot be resolved automatically. A connected account has one durable business authority. Browser state is a cache plus an account-bound outbox, drafts, and temporary UI state. The browser must preserve user intent through offline work, server changes, restart, and receipt recovery. Revision or fingerprint differences are diagnostic inputs, never by themselves a user business conflict. Source parsing and historical audit debt remain traceable but are not daily work.

A user can choose their available time. The planner reserves fixed commitments, protects genuine deadlines, packs flexible work into the remaining capacity, and defers overflow. A normal flexible overflow is not an alert. A hard conflict names the actual commitments and offers actions about those commitments.

## ZMC-00 inventory from exact main

| Boundary | Existing implementation | Defect to prove and replace |
|---|---|---|
| Time | `src/AppV8.tsx` passes literal `180` to `selectTodayWeb`; `decisionCoreV3.buildTimePlan` accepts a budget and reserves fixed actions. Historical `669a169` exposed 60/180/360 minute choices as component state. | No account-durable daily capacity or work window. A display budget is mistaken for a factual capacity. |
| Today membership | `src/today/todayWebSelector.ts` unions plan members, protected actions, every `doing` action, every same-day due action, and every explicit same-day action. | Flexible work can escape capacity and flood Today; `hard_deadline_unplanned` and budget notices can represent packing artifacts. |
| Durable workspace | Transactional connected workspace and command ledger already exist. `src/cloud/cloudSync.ts` still uses whole-workspace fingerprints/checkpoints and can mark a global conflict. | A stale cache is treated as a competing authority. An unrelated Gmail update can block normal browser continuation. |
| Client commands | `src/cloud/authoritativeCommandClient.ts` has stable IDs, local account journal, receipt-first recovery, and a separate `projection_pending` state after PR #195. | Normal offline input is not a complete automatically retried command outbox; a pending projection can block a new independent command. |
| Server commands | `gateway/authoritativeCommands.ts` supports stale-base rebase against intervening command footprints and durable receipts. | The client still depends on a global local projection; field-level and source-update merge rules need an explicit contract and sequence proofs. |
| Decision debt | PR #194 partitions actionable decisions from retained Gmail parser debt; Gmail producer has new generation gates. | This distinction needs dense, cross-source, long-lived regression coverage. |
| Schedule/history | Shared ScheduleStream and historical audit retention exist. | The everyday upcoming surface still needs proof that past unresolved occurrences never dominate current commitments. |
| Settings | Advanced conflict and recovery controls remain exposed in normal settings composition. | Routine sync work must disappear because the system converges safely, with disaster recovery kept separate. |

Canonical prior intent: `docs/consumer-grade-refoundation-v1/PRODUCT_INTENT.md`, `TECHNICAL_ARCHITECTURE.md`, `TARGET_EXPERIENCE.md`, and `VALIDATION.md` already assign source reconciliation and cache maintenance to the product; `docs/tasks-schedule-ui-v1/README.md` preserves the daily selector and historical evidence but its earlier rule to retain every today-due action must yield to this newer owner instruction on achievable Today membership. The previous 60/180/360 choice is an interaction precedent, not a durable-capacity model.

## Ownership and merge policy to implement

- **Durable confirmed facts:** server commands and ingestion writes remain transactionally authoritative. Append-only evidence, receipts, source identity, and occurrence supersession are retained.
- **User intent:** each unsent operation has an account, stable command ID, exact target, typed payload, local creation time, and retry state. It is never discarded by a cache refresh. A confirmed receipt is never resubmitted.
- **Automatic reconciliation:** refresh latest authoritative state, query uncertain receipts, then replay independent pending commands with the same IDs. Revalidation happens on the server. Distinct entities and compatible distinct fields merge; monotonic state and append-only facts follow domain rules, not timestamps.
- **Incompatibility:** only two mutually exclusive business claims about the same fact can become a user decision. The question names the entity, facts, and outcomes. A transport failure remains a background retry or concrete affected-action state.
- **Projection:** server state may replace stale cache only after local pending intent is safely retained/replayed. Account sign-out invalidates old async responses before they can project.

Phase ZMC-04 must publish and implement per-entity policies for Opportunity, Action, Process, ProcessEvent, ScheduleNode, DecisionRequest, Prep, Reminder, notes/preferences, and time capacity. Unknown same-field cases fail closed. No last-write-wins default is permitted.

## Phases and exit gates

| Phase | Deliverable | Gate |
|---|---|---|
| ZMC-00 | This architecture inventory, ownership contract, risk and regression register | Exact-main baseline verified; no runtime claim |
| ZMC-01 | Durable daily/available-today capacity, optional windows, hard/flexible planner | Red-before and green-after 2h/6h/8h, overflow, hard collision, reload/account sync; no literal UI 180 |
| ZMC-02 | One-authority cache lifecycle | Stale browser plus remote Gmail change converges; pending intent survives; real local-only edit fails closed |
| ZMC-03 | Offline command outbox and receipt/projection separation | Offline/reconnect, restart, receipt found/absent, no resend, independent command continuation |
| ZMC-04 | Typed entity/field merge policy | Property and sequence tests for non-overlap, same-field contradiction, append-only evidence, supersession |
| ZMC-05 | Quiet Today consumer surface | Normal connected/offline-with-cache journeys have no maintenance prompt; genuine business issue is contextual |
| ZMC-06 | Decision/parser debt model | Dense historical Gmail debt retained and absent from daily decisions; new parser uncertainty does not recur as user work |
| ZMC-07 | Upcoming/history model | 300-node fixture: real future nodes visible, historical unknowns kept in History, relevant past outcome asked contextually |
| ZMC-08 | Settings and rare recovery | Normal settings show useful sync status only; advanced diagnostic/recovery keeps provenance and safety |
| ZMC-09 | Owner-like dense acceptance | 300+ actions, 300+ decisions, 300 nodes, Gmail update, offline command, cross-device change, reload/restart |
| ZMC-10 | Reliability closure | Full CI, Browser, Firefox/WebKit, VoiceOver, production self-test, independent review, exact-main runtime readback |

Each phase uses one writer and one PR. The next phase begins after the prior phase's head checks, merge, and exact-main readback. Inner-loop testing is targeted; broad checks run at a stable candidate. A production write gate that lacks owner authorization is recorded precisely and independent engineering continues.

## Mandatory regression ledger

Each numbered owner issue below requires a test that fails on the preceding behavior and passes after its repair. Existing passing tests are supporting evidence, not a substitute for a red-before reproduction. Browser critical paths must use headless Chromium and persistent IndexedDB with reload/restart. The phase receipt records the red and green commands, expected/observed behavior, fixture size, and exact SHA.

| Owner issue | Primary phase | Existing starting evidence |
|---|---|---|
| 1. History detail completion source-offset crash | ZMC-09 | `tests/historyCompletionStartup.test.ts`, `e2e/historyCompletionStartup.e2e.ts` |
| 2. 300+ historical Gmail decisions on Today | ZMC-06/09 | `tests/fixtures/denseDecisionWorkspace.ts`, `e2e/denseTodayDecisions.e2e.ts` |
| 3. 300+ open actions entering Today | ZMC-01/09 | `todayWebSelector`, dense fixtures |
| 4. 98/100 historical nodes dominating Upcoming | ZMC-07/09 | ScheduleStream, dense fixtures |
| 5–7. persistent/stale conflict and failed retry | ZMC-02/09 | `e2e/ownerInteractionRecovery.e2e.ts`, `tests/authoritativeReadModelClient.test.ts` |
| 8–9. cancel unknown outcome and confirmed receipt with blocked projection | ZMC-03/09 | `tests/authoritativeCommandClient.test.ts` |
| 10. repeated maintenance banners | ZMC-05/09 | `e2e/cgr02TodayVerticalSlice.e2e.ts` |
| 11. false 180-minute overload | ZMC-01/09 | `src/AppV8.tsx`, `tests/decision.test.ts` |
| 12–13. Gmail remote update plus stale cache/local command | ZMC-02/03/09 | `e2e/postClosureAccountRace.e2e.ts` |
| 14. sign-out/late response | ZMC-02/09 | `e2e/postClosureAccountRace.e2e.ts` |
| 15–16. offline replay and restart | ZMC-03/09 | `e2e/cgr02TodayVerticalSlice.e2e.ts` draft path |
| 17–18. two-device independent/same-field edits | ZMC-04/09 | `gateway/authoritativeCommands.ts` footprint tests |

A historical owner issue already fixed by #194/#195 still needs its prior failing test/trace plus a permanent headless acceptance path; do not intentionally reintroduce the defect on production. If a prior red trace cannot be recovered, create a controlled pre-fix implementation worktree and run the new regression there. Any inability to establish red evidence stays visible rather than being labeled PASS.

## Production safety

No production workspace mutation is required for ZMC-00. Future tests use synthetic accounts and fixtures. Production checks are read-only unless a separate synthetic canary is explicitly covered by an existing authorization. This package does not authorize bulk mutation of owner records, deletion, historical rewrite, Gmail cursor/OAuth changes, external sends, real applications, or purchase.

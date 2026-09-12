# v1.8 Process Lifecycle Correctness Audit

## Scope

This is a code-path correctness audit triggered by repeated JD/JDS assessment failures: an assessment could be recorded but then fail to become completed, or different product/AI surfaces could disagree about whether it was still pending.

The audit follows one recruiting task through its full lifecycle:

`notification → Process Event → deterministic event Action → Today → completion → waiting for result → re-import/read consistency`

It is not an empirical user study and it does not claim every possible bug in PJSDAS has been eliminated.

## Correctness invariant

For an actionable recruiting node (assessment / written test / interview):

1. one real notice produces one Process Event;
2. the Process Event deterministically owns `event-action:<eventId>`;
3. completing the task updates that same Action to `done` rather than creating another invitation event;
4. Today stops surfacing the completed Action;
5. Opportunity and Pipeline read the same effective stage (`…完成 · 等待结果`);
6. AI semantic reads use the same effective state;
7. a later re-import preserves local Action status and does not resurrect a completed task;
8. repeated statements of an already recorded completion are no-ops rather than audit noise.

## Confirmed defects and fixes

### 1. Explicit same-day completion was not reliably recognized

The previous parser mostly inferred completion from historical-date context. Statements such as `JDS技术产品经理测评已完成` could therefore remain unresolved or be treated like another assessment event.

The final progress parser now recognizes explicit completion wording for assessment, written test and interview regardless of whether it happened earlier the same day.

False-positive guards distinguish completed status from instructions or metadata:

- `请在48小时内完成测评` is pending;
- `测评完成时间为9月13日23:59` is metadata, not done;
- `测评已完成` is done.

### 2. Completion could create a second Process Event

Natural-language progress used to have only the parsed operation, not the existing Process Event/Action baseline. A completion statement could therefore backfill another synthetic assessment instead of closing the original task.

`createCanonicalProgressChangeSet` now converts a completed actionable event into `set_action_status → done` for the original deterministic event Action when that event already exists. Historical completion with no prior event is still allowed as backfill.

### 3. Superseded historical Actions were hidden from mutation review

Today correctly hides an old assessment task after a later interview event, but that visibility filter must not erase the mutation baseline. A later historical statement such as “assessment completed” still needs to find the old assessment Action.

`getAllActionsForMutationBaseline` reconstructs all Process Event Actions without Today suppression for reviewed mutations only.

### 4. Repeated completion produced useless audit records

If the matching Action is already `done`, the canonicalizer removes that mutation. If every parsed mutation is already represented by current state, no ChangeSet is created.

### 5. Review UI could describe a different operation than the ChangeSet actually applied

Progress Inbox now renders the canonical ChangeSet operation corresponding to each parsed statement. When `测评已完成` maps to the old event Action, review explicitly says the existing Action will be completed and no duplicate event will be created.

### 6. Notification Paste bypassed the ChangeSet boundary

The paste-notification surface previously called the database Process Event writer directly. It now uses `applyProcessEventChangeSet`, preserving the same review/audit mutation boundary as the rest of PJSDAS.

### 7. Process recording surfaces could use stale Opportunity state

Progress Inbox, Notification Paste and Process Event Dock now refresh current Opportunities before resolving a target. Process Event Dock also reloads on `pjsdas:workspace-replaced` and revalidates the selected role immediately before mutation.

### 8. Opportunity and Pipeline could disagree after completion

Process-event projection is now action-aware. A completed event Action produces the same `…完成 · 等待结果` semantic stage in Opportunity and Pipeline projections.

Opportunity Detail prefers the effective Process stage label so the detail object does not contradict Pipeline.

### 9. AI Bridge could reintroduce the stale state

`readWorkspace()` previously projected Opportunities before Process Event Actions were reconciled. As a result, `list_opportunities` could say `测评` while `get_pipeline` said `测评完成 · 等待结果`.

The read order is now:

1. reconcile all Process Event Actions;
2. project Opportunities with those Action statuses;
3. suppress superseded Actions for Today visibility;
4. project Pipeline from the same reconciled baseline.

Thus `list_opportunities`, `get_pipeline` and `get_today_plan` share one effective recruiting state.

## Existing behavior verified as correct

The audit also rechecked surrounding semantics rather than changing them unnecessarily:

- Excel re-import preserves locally changed Action statuses through the existing re-import merge policy;
- deleting a Process Event removes its deterministic event Action;
- a later recruiting-stage event suppresses obsolete earlier-stage tasks from Today;
- public job-posting freshness/closure remains separate from the user's recruiting-process lifecycle;
- completed Actions remain in history/state but no longer appear as executable Today tasks.

## Regression protection

New/expanded suites cover:

- JD/JDS same-day assessment completion;
- written-test and interview completion wording;
- instruction/deadline false positives;
- completion-time metadata false positives;
- completion of the original deterministic event Action;
- historical completion backfill;
- repeated-completion no-op behavior;
- Opportunity/Pipeline completed-stage consistency;
- AI `list_opportunities` / `get_pipeline` / `get_today_plan` consistency;
- ChangeSet-only mutation entry points and fresh-workspace resolution contracts.

## Known low-risk residual

The browser-local `db.getAllOpportunities()` helper predates action-aware projection and does not itself pass reconciled Actions into the Opportunity projector. Current high-value surfaces are protected as follows:

- Today derives from Action state;
- Pipeline is action-aware;
- Opportunity Detail prefers Pipeline's effective label;
- AI semantic reads are action-aware;
- desktop Opportunity Pool does not display process stage.

A mobile Opportunity Pool fallback line can therefore temporarily show the older imported/event label until another workspace refresh/state change. This is a presentation residual, not a live-task or mutation correctness failure. It should be moved into a unified effective-workspace local read layer in a future safe database-layer refactor rather than by risky whole-file surgery during this correctness patch.

## Non-goals

This patch does not:

- change ranking or Decision Rules;
- change snapshot schema;
- change Google Drive sync semantics;
- merge the separate v1.8.1 Stable Account PR;
- infer completion from ambiguous text without an identifiable Opportunity;
- silently mutate data without ChangeSet review/apply.

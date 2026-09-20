# Ultimate Usability v1 — Data and Mutation Contract

This file freezes the target contracts to be implemented incrementally. It does not claim they
already exist in production.

## Authority

The server transactional workspace remains the business authority in connected mode.

No new AI memory store, iCloud database, browser DB, Gmail cache, ChatGPT task list, or calendar may
become a competing business authority.

## ScheduleNode

Required semantics:

- stable node and occurrence identity;
- opportunity/process relationship;
- kind: interview / written_test / assessment / application_deadline / follow_up / prep_trigger;
- lifecycle: scheduled / in_progress / completed / cancelled / superseded / elapsed_unresolved;
- temporal shape: fixed_range / deadline / availability_window / date_only / estimated_date;
- timezone + precision + raw expression + resolution basis;
- constraint kind: employer_hard / user_plan / system_suggestion;
- duration estimate + provenance;
- evidence refs / source-version refs;
- related actions/prep;
- supersession/completion links.

Time facts must have one canonical owner. Action/Opportunity legacy deadline fields become
compatibility projections, not independent writable truth.

## Process semantics

Separate:

- recruiting stage;
- stage progress;
- process result;
- user participation state;
- node state.

Completing a written test does not complete the whole Process.

## DecisionRequest

Required fields:

- reason;
- affected objects;
- natural-language question;
- 2–4 choices;
- consequence of each choice;
- recommendation + basis where possible;
- evidence refs;
- payload/version binding;
- expiration;
- resolution state.

Lifecycle:
`open → answered / auto_resolved / superseded / expired`.

## TodayBrief

One shared read contract for Web/MCP/iPhone:

- contractVersion;
- workspaceRevision;
- evaluatedAt;
- displayTimezone;
- nextAction;
- nextActions;
- agendaGroups;
- relevantDecisionRequests;
- materialCoverageWarnings;
- internalDiagnostics not rendered by default.

The clock/timezone/rules version must be inputs to the read model, not independently guessed by each
UI.

## ReminderIntent / external mappings

Reminder state is delivery state, not business truth.

Track node/version/purpose, delivery owner, external mapping IDs/capabilities, schedule, dedupe key,
state, receipts/retry.

## Semantic intake

All user/source input normalizes into a source-neutral candidate fact/intent contract before domain
mutation.

## Automatic write gates

Automatic internal commit requires:

- authorized source/client/capability;
- explicit/clear fact or current intent;
- unique target + occurrence;
- required fields/evidence;
- no material unresolved conflict;
- compensatable internal consequence only.

No autonomous external application/email/withdraw/offer action.

## Owner abandonment amendment

Explicit, unique, compensatable “I’m not pursuing this” may directly update internal participation
state + receipt + Undo.

Confirmation remains required for ambiguity, shared quota/governance, destructive identity work,
external withdrawal, or other consequential non-compensatable effects.

## Atomic completion example

“京东笔试做完了” should eventually be one transaction:

- resolve the unique occurrence;
- record completion fact;
- node → completed;
- related attend/complete action → done;
- stage remains written_test while progress → waiting_result;
- cancel old reminders for this occurrence;
- create/adjust one system follow-up if policy requires;
- write ledger + receipt;
- project Today/Opportunity/Agenda.

Replay with the same command identity must not duplicate any business fact.

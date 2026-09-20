# Owner Amendments — PJSDAS Ultimate Usability v1

Status: **FROZEN OVERRIDES**  
Applies to: `PJSDAS-ULTIMATE-USABILITY-v1`

These owner amendments override the base blueprint where there is a direct conflict.

## OA-01 — PAIA / ChatGPT owner intake is first-class

For the generic PJSDAS product, a PAIA/browser bridge is optional.

For the owner deployment, the existing PAIA user-input archive is a **first-class authorized source
adapter** for job-search-relevant user statements from ChatGPT.

Target owner flow:

`ChatGPT user input → PAIA trusted user-input archive → PJSDAS relevance gate → semantic intake →
identity/occurrence resolution → shared write policy → atomic command / DecisionRequest`

Constraints:

- user original words remain distinguishable from AI interpretation;
- only the minimum necessary project/context window may be supplied;
- quoted/hypothetical/rewrite content must not create facts;
- no AI response scraping is required for this source;
- PAIA cannot bypass PJSDAS authorization or domain validation;
- cross-project/context ambiguity must fail closed.

## OA-02 — Unified intake contract is frozen in UU-02

UU-02 must define the source-neutral Semantic Intake Contract for:

- PJSDAS Web input;
- PAIA / owner ChatGPT input;
- Gmail SourceObservation;
- current-chat MCP calls;
- future iPhone text/dictation/share input.

Later Gmail/GPT rounds add source adapters/capabilities; they must not invent parallel business
transition rules.

## OA-03 — Explicit abandonment may auto-commit internally when safely compensatable

The base blueprint treats “I’m not pursuing this opportunity” as always requiring an extra
confirmation.

Owner policy is more usability-oriented:

An explicit user statement such as “这个岗位我不投了” may directly commit the **internal** user
participation state when all of these hold:

- the target Opportunity is unique;
- the language is an explicit current decision, not a question/example/quote;
- the update is compensatable/undoable;
- there is no external withdrawal/submission;
- no shared application quota or dependent governance consequence requires a choice.

The UI must return a receipt + Undo.

Explicit confirmation is still required when the action:

- withdraws an external application;
- affects shared quota/application-group governance;
- cancels consequential reminders/commitments beyond a compensatable internal state;
- is ambiguous;
- deletes/merges identity or performs other destructive/bulk changes.

## OA-04 — Native-client compatibility is a gate from UU-01 onward

The native iPhone implementation remains UU-08, but every new contract from UU-01 onward must be
platform-neutral and consumable by a future native client.

This applies especially to:

- ScheduleNode;
- DecisionRequest;
- TodayBrief;
- Opportunity summary/detail reads;
- Semantic Intake / receipt;
- ReminderIntent;
- route/deep-link object identities.

A Web-only contract that would require rebuilding business rules inside the iPhone client fails the
round gate.

## OA-05 — Product-facing terms remain human concepts

Implementation may use Action, ProcessEvent, ChangeSet, ledger, workspace revision, source coverage
and similar internal concepts.

Daily UI must not require the user to understand those names. Default product vocabulary is:

- Today;
- Opportunities;
- Tell PJSDAS;
- schedule / next action;
- needs your decision;
- history/settings only when needed.

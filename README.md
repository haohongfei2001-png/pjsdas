# PJSDAS

**Personal Job Search Decision & Action System**

PJSDAS is a local-first personal job-search decision workspace. Its purpose is not merely to track applications, but to turn opportunities, recruiting-process changes, deadlines, preparation work, and available time into a prioritized and executable set of next actions.

## Product principle

**The system should help answer one question within 30 seconds: _What should I do next for my job search?_**

## Current workspace

- **Today** — a time-boxed plan that protects real deadlines instead of showing a generic score leaderboard
- **Opportunities** — the role pool and dynamic application priority
- **Pipeline** — recruiting-process state and dynamically recalculated review checkpoints
- **Prep** — reusable preparation across multiple opportunities
- **Import & Settings** — local spreadsheet import with integrity checks
- **Process Event capture** — record an actual assessment, written-test, interview, offer, rejection, or status notification without editing the spreadsheet first
- **Paste notification** — locally parse pasted recruiting text, review the inferred role/event/time, then explicitly confirm before saving
- **Local backup** — export and restore the complete browser workspace as a validated JSON snapshot

## Core model

PJSDAS separates job-search state into six concepts:

1. **Opportunity** — company/role and its value, fit, application deadline, application group, etc.
2. **Process** — the effective recruiting stage for an opportunity.
3. **Process Event** — a dated fact such as an assessment invitation, written-test notification, interview invitation, offer, rejection, or other real status update.
4. **Action** — a concrete next move generated from an opportunity, application group, process checkpoint, process event, or preparation requirement.
5. **Prep** — reusable work that can improve more than one opportunity.
6. **Today** — the constrained action plan produced by the decision engine under the user's available time.

Imported spreadsheet data remains the baseline. Newer local Process Events are projected over that baseline rather than destructively rewriting it. Deleting the local event therefore restores the imported state automatically.

## Decision engine

The current decision engine is deterministic and explainable. It combines opportunity value, fit, urgency, recruiting stage, action leverage, delay cost, and time efficiency, then applies operational guardrails:

- real application deadlines inside 48 hours cannot be crowded out by routine follow-ups;
- overdue recruiting review checkpoints do not receive unlimited priority;
- reusable Prep and follow-ups are capped inside Today;
- shared application quotas are represented by one application-group decision instead of mutually conflicting role actions;
- a newer real Process Event suppresses stale application/follow-up actions for the same role;
- only the newest effective Process Event action remains active for one opportunity;
- completed process actions move Pipeline into a waiting-for-result state instead of continuing to show the completed task;
- overdue Process Event tasks leave the executable Today queue and move to a separate confirmation/recovery guard;
- if the available-time budget cannot cover a hard deadline, PJSDAS reports the conflict rather than silently hiding the task.

### Deadline work vs fixed-time events

Process Event timing has two explicit semantics:

- **deadline** — work can be completed before the stated time, so a tomorrow-night assessment may legitimately be scheduled into today's available time;
- **fixed** — the event can only happen at the stated time, so a tomorrow interview is shown as an upcoming fixed event but does not consume today's startable-work queue.

A fixed event happening today reserves daily capacity but is not presented as “Start here” hours before it begins. If either a fixed event or deadline-style Process Event passes without being resolved, PJSDAS removes it from startable work and asks the user to confirm completion or take recovery action instead of pretending the original task is still executable.

## Paste notification workflow

v0.7 adds a local, deterministic notification parser for common recruiting messages. The workflow is deliberately conservative:

1. paste a recruiting SMS, email, or portal notification;
2. PJSDAS proposes a matching opportunity, Process Event type, timing semantics, time, and estimated duration;
3. ambiguous same-company roles remain unresolved instead of being auto-selected;
4. the user reviews and can edit every inferred field;
5. only explicit confirmation writes a Process Event and updates Pipeline / Today.

The pasted source text is used for the current parsing session and is not stored by default when the event is saved. The parser does not require an AI API.

## Local-first architecture

- React + TypeScript + Vite
- IndexedDB for personal data
- local `.xlsx` parsing in the browser
- GitHub repository contains application code, not the user's recruiting workbook or imported personal data
- GitHub Pages deployment
- Vitest decision/import/process-event/notification/snapshot regression suite in CI

Spreadsheet re-import preserves local Process Events and the completion/skip status of stable Actions. Import integrity checks run before destructive replacement so malformed future workbook versions fail closed.

## Local backup and restore

PJSDAS stores more state than the spreadsheet once Process Events and Action completion statuses exist. The versioned local snapshot contains the raw browser stores rather than derived views:

- Opportunities
- Processes
- Process Events
- Actions and their statuses
- Prep
- Application Groups
- last-import metadata

Restore is deliberately destructive but two-step: the selected JSON file is parsed and validated first, then the user explicitly confirms replacement. Unsupported versions, duplicate IDs, invalid dates, and broken references fail before any IndexedDB store is cleared. Historical Process Events may remain archived even if a later spreadsheet no longer contains the old opportunity; they are retained as facts but no longer affect current decisions.

## Status

**v0.7** closes the main local input-to-action loop: spreadsheet baseline → pasted or manually recorded recruiting notification → reviewed Process Event → effective Pipeline state → time-aware Today action → completion/waiting or overdue confirmation → durable local backup. The release keeps ranking deterministic and local-first; AI parsing, cloud sync, automatic email ingestion, and auto-apply remain outside the current scope.

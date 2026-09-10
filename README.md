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

## Core model

PJSDAS now separates job-search state into six concepts:

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
- if the available-time budget cannot cover a hard deadline, PJSDAS reports the conflict rather than silently hiding the task.

## Local-first architecture

- React + TypeScript + Vite
- IndexedDB for personal data
- local `.xlsx` parsing in the browser
- GitHub repository contains application code, not the user's recruiting workbook or imported personal data
- GitHub Pages deployment
- Vitest decision/import regression suite in CI

Spreadsheet re-import preserves local Process Events and the completion/skip status of stable Actions. Import integrity checks run before destructive replacement so malformed future workbook versions fail closed.

## Status

**v0.5** adds the Process Event layer on top of the v0.4 time-budgeted Today planner. Assessment, written-test, and interview notifications can generate real deadline-bearing actions; offers and rejections update the process timeline without inventing unnecessary tasks. Process Events are stored locally and survive later Excel re-imports.

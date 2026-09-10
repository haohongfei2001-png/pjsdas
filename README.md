# PJSDAS

**Personal Job Search Decision & Action System**

PJSDAS is a local-first personal job-search decision workspace. Its core purpose is not merely to track applications, but to turn opportunities, application status, deadlines, preparation work, and available time into a prioritized list of next actions.

## Product principle

**The system should help answer one question within 30 seconds: _What should I do next for my job search?_**

## v0.1 scope

- **Today** — prioritized actions for the current day, with clear reasons
- **Opportunities** — the job opportunity pool
- **Pipeline** — application and recruiting-process status
- **Prep** — reusable preparation tasks across opportunities
- **Import & Settings** — import the existing spreadsheet and tune decision rules

## Core model

PJSDAS separates job-search information into five layers:

1. **Opportunity** — company, role, location, deadline, value, fit, etc.
2. **Process** — not applied, applied, assessment, test, interview, offer, closed, etc.
3. **Action** — the next concrete action attached to an opportunity or process
4. **Prep** — reusable preparation work that can improve multiple opportunities
5. **Today** — the ranked action view produced by the decision engine

## Decision engine

The initial version will be deterministic and explainable. Priority should be based on factors such as opportunity value, fit, urgency, process stage, consequence of delay, expected time cost, and reuse value. AI may later help interpret unstructured information, but it is not required for the core ranking logic.

## Architecture direction

- Web App / PWA
- Desktop-first, mobile-friendly
- Local-first personal data storage
- React + TypeScript
- IndexedDB for local data
- Spreadsheet import/export
- GitHub Pages deployment

## Status

Repository initialized. The next step is to map the current job-application spreadsheet into the PJSDAS data model before implementing the first usable Today engine.

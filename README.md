# PJSDAS

**Personal Job Search Decision & Action System**

PJSDAS is a local-first personal job-search decision workspace. Its core purpose is not merely to track applications, but to turn opportunities, application status, deadlines, preparation work, and available time into a prioritized list of next actions.

## Product principle

**The system should help answer one question within 30 seconds: _What should I do next for my job search?_**

## Current scope

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

The initial version is deterministic and explainable. Priority is based on factors such as opportunity value, fit, urgency, process stage, consequence of delay, expected time cost, and reuse value. AI may later help interpret unstructured information, but it is not required for the core ranking logic.

## Architecture

- Web App / PWA
- Desktop-first, mobile-friendly
- Local-first personal data storage
- React + TypeScript
- IndexedDB for local data
- Spreadsheet import
- GitHub Pages deployment

## Spreadsheet integration

PJSDAS v0.2 maps the current job-search workbook into a smaller decision model instead of reproducing every worksheet. The primary imported sources are the application master table, role details, active pipeline, preparation center, and application groups. Derived sheets such as dashboard and recent-action views are recalculated by PJSDAS at runtime.

## Status

v0.2 is buildable and includes local Excel import, persistent IndexedDB storage, generated application/follow-up/preparation actions, and a first explainable Today ranking engine. GitHub Pages deployment is configured through GitHub Actions.

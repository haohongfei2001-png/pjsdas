# PJSDAS v1.4 Round 2 — Discovery Decision Workspace

## Goal

Round 2 turns the durable Discovery Inbox from a lifecycle list into a decision workspace. The user should be able to review several discovered jobs, understand what is known or uncertain, compare candidates, defer or reject groups efficiently, and preview the exact candidate facts before promoting one into the real Opportunities pool.

This round does **not** redesign Fit / Opportunity Value and does not add a richer persistent Opportunity schema. Those remain later v1.5 concerns.

## Product rules

- Discovery Inbox remains separate from Opportunities.
- Round 2 decision aids are deterministic views over existing Inbox facts and scores; they do not create a hidden AI ranking model.
- The default `Review priority` ordering keeps active Inbox candidates ahead of archived candidates, then uses the transparent average of existing `fitScore` and `opportunityValue`, with information completeness only as a tie-breaker.
- The displayed `Review reference` is `(fitScore + opportunityValue) / 2`. It is an Inbox review aid only and never replaces PJSDAS's formal decision engine priority.
- Missing location, deadline, or compensation stays explicitly unknown. Round 2 never fabricates those facts.
- Confidence and existing `profileWarnings` remain visible rather than being collapsed into a fake precise score.
- Promote remains explicit and still uses the existing ChangeSet apply path.

## Decision aids

Each Inbox candidate now exposes:

- transparent review reference;
- information completeness for location / deadline / compensation;
- fit and opportunity-value confidence;
- deterministic positive signals;
- deterministic risk signals, including low-confidence estimates and a deadline inside 72 hours;
- explicit missing facts;
- existing profile/evidence warnings and the original public source.

Sort modes:

- Review priority;
- newest discovered;
- fit score;
- opportunity value;
- information completeness;
- earliest known deadline (unknown deadlines sort last).

## Comparison

The user can select two or three Inbox candidates and open a side-by-side comparison containing:

- fit score + confidence;
- opportunity value + confidence;
- review reference;
- information completeness;
- location;
- deadline;
- compensation;
- risk / missing-information flags;
- public source link.

Comparison is view-only and does not mutate candidate state.

## Batch triage

Selected Inbox candidates can be moved to `later` or explicitly dismissed with one user-selected rejection reason. The existing per-item status mutation path is reused, so dismissed candidates still write the same Timeline-backed explicit feedback and retain the existing 120-day rediscovery semantics from v1.3/v1.4 Round 1.

Promoted candidates are excluded from batch lifecycle mutation.

## Promotion preview

`Add to Opportunities` no longer performs the promotion immediately from the card. It first opens a review dialog showing the candidate's role type, scores, location, deadline, compensation, warnings, and source. Only the second explicit confirmation calls the existing Inbox promotion path.

The preview makes clear that promotion:

- creates/uses the Opportunity through the existing ChangeSet path;
- retains discovery evidence;
- does not submit an application.

## Non-goals

- No Rich Opportunity schema expansion.
- No Fit / Opportunity Value component redesign.
- No learned preference model.
- No new crawler or scheduled discovery.
- No automatic promotion.
- No automatic application.
- No change to the MCP discovery proposal contract.

## Acceptance criteria

1. Inbox candidates can be sorted by review priority, newest, fit, opportunity value, information completeness, and deadline.
2. Unknown location/deadline/compensation is shown as missing and never synthesized.
3. Low-confidence estimates, profile warnings, and near deadlines are surfaced as visible risks.
4. Two or three selected candidates can be compared side by side without mutation.
5. Multiple selected candidates can be moved to Later or dismissed with an explicit rejection reason.
6. Promotion requires a separate preview/confirmation step before the existing ChangeSet apply path runs.
7. Review-reference sorting is transparent and does not modify Decision Rules or formal Today priority.
8. Existing v1.4 Round 1 Inbox lifecycle, Google Drive snapshot/fingerprint, backup/restore, and rediscovery-suppression semantics remain unchanged.

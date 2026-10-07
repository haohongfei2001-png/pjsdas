# Deadline-only ordering

Owner direction on 2026-10-06: remove scoring and matching models from the product; order work only by its actual deadline.

## Approved convergence boundary

[TodayAction Consumer Convergence v1](TODAYACTION_CONSUMER_CONVERGENCE_V1.md) is the Owner-approved next implementation plan. It retains factual deadline ordering for existing job-library queries and eligible work, and retains this document's scoring retirement and historical-data protections. 新发现 uses discovery-time order.

For the new contract, a job deadline remains a job fact and is not a Schedule event. A deadline correction or retained legacy canonical node does not by itself confer Schedule eligibility. Only confirmed recruiting events or explicitly timed Actions qualify. New job creation does not create an application Action. The compatibility/migration work must preserve effective deadlines and their evidence before removing legacy Schedule ownership. The new plan governs those boundaries; this document's existing implementation description below is not permission to regenerate deadline-only calendar items.

This documentation update does not implement or deploy that change.

## Active behavior

- Jobs and startable actions use applicable known deadlines ascending; unknown or invalid deadlines come last. Equal dates use explicit times, then stable IDs. A date-only deadline is never saved or displayed as an invented midnight timestamp.
- Existing application/deadline corrections and canonical schedule nodes remain authoritative. Fixed interviews/tests retain their event start/end times; the calendar is not sorted by an old application deadline.
- Available-time and real fixed-appointment constraints determine feasibility. The earliest feasible deadlines are selected in order, without weighted utility, role bonuses, score thresholds, title-similarity penalties or a doing bonus. Work that cannot fit keeps its source record/state and has a capacity explanation.
- Company quota totals/used/remaining, locks, source rules, and manually recorded preference order remain factual records. A quota is never filled automatically and the system never submits applications.
- Ended/abandoned records stay separated. Expired unsubmitted records are not auto-closed. Source/identity uncertainty, authorization, evidence, audit and recovery controls are unchanged.
- Website Today, TodayBrief v2 and Today plan share chronological selection and the live local-day/manual capacity input. The old 4/8-item policy truncations and arbitrary per-kind caps are removed.

## Removed product surfaces and engines

Decision Rules editor and weights, fit/value assessment cards, score-based sorting/filtering, assessment-driven prep boosts, portfolio utility optimization and source-title diversity penalties are removed. Source freshness/completeness and identity-resolution confidence remain evidence checks, not job-quality ratings.

## Compatibility and data preservation

This release does not purge database data. Old snapshot rating/rule/assessment fields and historical receipts remain decodable and exportable, but are not recomputed, displayed as current ratings or consulted for ordering. New facts do not require scores. Where the existing persisted schema still requires numeric legacy slots, new records use zero placeholders solely for decoding compatibility; current product/read outputs omit them. Existing archived values are preserved.

Scoring-only API calls return an explicit SCORING_RETIRED result. Old score-bearing write requests and old scoring-policy proposals cannot reactivate the retired engine. Time planning, factual preference updates and quotas retain their authorization and revision checks. Clients must refresh the published tool contract before sending new factual inputs.

## Verification

The deadline-only tests vary historic weights/scores and role tags, assert invariant chronology across Web/brief/plan/jobs, preserve old snapshots byte-for-byte during reads, retain expired unsubmitted jobs, and preserve fixed appointments. Existing date-only, timezone/DST, explicit latest-start, cross-midnight, source-tombstone, unknown-time, physical-capacity and authorization regressions remain in the test suite.

Hosted Browser E2E captures actual 390px/1440px settings and job-list screenshots, verifies no scoring controls remain, and checks retained account/recovery and inline available-time controls.


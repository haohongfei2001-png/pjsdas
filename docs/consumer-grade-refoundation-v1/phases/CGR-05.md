# CGR-05 — Consumer-Grade Certification

State: COMPLETE — STABLE CONSUMER-GRADE BASELINE

## User-visible outcome

PJSDAS reaches a stable consumer-grade baseline: the core product can be used for normal daily job-search work without the owner acting as QA, synchronizer, system operator, or UI designer.

This phase certifies and simplifies; it does not add features.

## Scope

- freeze feature development;
- test realistic dense workspaces and long-running sessions;
- verify cross-client consistency and propagation;
- verify degraded/failure recovery;
- perform visual regression and final visual-craft review;
- verify responsive behavior and large text;
- verify keyboard and screen-reader accessibility;
- verify account/session/cache isolation;
- run production canaries and long-duration reliability checks;
- finish legacy UI/CSS/write/compatibility retirement;
- reconcile documentation with actual production capability;
- produce the final consumer-grade baseline receipt.

## Non-goals

- absolutely no new product feature;
- no iPhone implementation;
- no reopening UU-08;
- no new source for certification optics;
- no release publication unless separately authorized;
- no weakening acceptance gates to finish the package.

## Preserved invariants

All preserved foundations plus final architecture and user-journey contracts established by CGR-01 through CGR-04.

## Architecture changes

Only changes required to fix certification defects, remove legacy, simplify architecture, improve accessibility/reliability/performance, or close documented production gaps.

A certification failure may reveal an architecture defect; fix the root cause rather than add a test-only exception.

## Migration

Finish migrations already started. No new parallel architecture is introduced.

Verify supported client/version compatibility and disable stale write authorities that can corrupt newer state.

## Legacy retirement

Final audit covers obsolete app shells, obsolete Today/Opportunity entrypoints, whole-snapshot daily connected writes, unneeded CSS override layers, duplicate source-specific interpretation paths, stale authority/product wording, compatibility adapters with no supported consumer, and dead feature flags/capability claims.

Each retained legacy path needs a concrete supported consumer and reason.

## Required tests

Full suite plus deterministic/domain regression, authoritative command/integration regression, dense-workspace performance/correctness, multi-hour session behavior, reconnect/session-expiry, cross-client concurrency, unknown-commit recovery, account isolation, visual screenshot regression, responsive/large-text matrix, keyboard-only core journeys, screen-reader core journeys, reduced motion, offline/degraded source states, production canary, and legacy dependency/static checks.

## Continuous real-user journeys

Run the complete portfolio:

- daily Today/capture/save/cross-client/Undo;
- opportunity scan -> detail -> prep -> return;
- interview/test reschedule and completion;
- DecisionRequest ambiguity/resolution;
- Gmail -> authoritative update -> Today/detail;
- PAIA/current-chat -> authoritative update;
- offline + concurrent external update;
- lost response after commit;
- authorization/source failure and recovery;
- account switch isolation;
- ended/stale opportunity cleanup behavior;
- reminder delivery if part of the active product promise.

Use realistic density and long content.

## Visual / responsive evidence

Final approved baselines for every primary route and major state at desktop and phone-class widths, including large text.

Perform human visual-craft review for hierarchy, spacing, rhythm, alignment, truncation, interaction feedback, state clarity, and consistency. Pixel-diff stability alone does not certify visual quality.

## Production evidence

- exact integrated main SHA;
- all required CI/browser/security/release checks;
- production canaries for core journeys;
- measured source freshness/interpretation/command/cross-client outcomes;
- bounded long-duration observation;
- no unexplained critical integrity warning;
- no active legacy dual authority;
- release publication state explicitly reported.

## Failure / degraded scenarios

Every major journey is repeated with at least one relevant degraded condition: offline, source revoked, stale session, server timeout, response lost after commit, concurrent update, interpretation failure, business ambiguity, dense/slow client, narrow/large-text UI, or account switch.

## Rollback

Use existing per-feature/source kill switches, safe read-only fallback, forward fixes, and compensating commands. Never restore stale workspace snapshots over newer facts.

Certification rollback means the package remains IN_PROGRESS/BLOCKED until the defect is fixed; do not declare COMPLETE and defer a baseline-breaking defect.

## Continuous-entry rule

CGR-05 may begin after CGR-04 reaches engineering closure even if CGR-03/CGR-04 are still `PRODUCTION_PENDING_EXTERNAL`. In that state, run every deterministic, browser, security, accessibility, performance, migration-retirement, long-session, account-isolation and other non-production gate that is logically valid. Record production-dependent journeys as deferred rather than faking or skipping them.

CGR-05 is the final convergence phase: once all automatable work is exhausted, it waits on the remaining entries in `../DEFERRED_FINAL_GATES.md`. It cannot certify a stable consumer-grade baseline until those applicable production gates pass.

## Owner amendment — final convergence

Owner Amendment `../OWNER_AMENDMENT_2026-09-25.md` removes the unavailable fresh natural recruiting-Gmail event from the blocking exit set and preserves it as `OBS-CGR-001`.

All remaining CGR-05 exit criteria are supported by exact-production, deterministic, browser, accessibility, long-session, cross-browser, isolation, recovery and legacy-retirement evidence. The amendment does not certify inactive/unavailable host capabilities and does not authorize release publication or subsequent feature work.

## Exact exit criteria

CGR-05 can close only when:

- no new feature was added to obtain certification;
- all critical continuous journeys pass on production architecture;
- deterministic/integration/production reliability gates pass;
- dense workspace and long-session behavior are acceptable;
- responsive/large-text/keyboard/screen-reader evidence passes;
- account isolation is proven;
- visual baselines are stable and independently reviewed for quality;
- active source capabilities match user-facing claims;
- no routine legacy dual authority remains;
- obsolete UI/styles/write paths are retired or explicitly justified;
- known limitations are non-critical and documented;
- final STATUS.md marks CGR-05 COMPLETE — STABLE CONSUMER-GRADE BASELINE;
- execution stops.

After closure, iPhone work, UU-08 reconsideration, new features, or release publication require a new explicit owner decision.

## Owner decision points

Only a final high-level product acceptance if the owner wishes to make preference refinements, plus any separate release-publication decision. The owner is not responsible for finding residual bugs or performing pixel-level certification.

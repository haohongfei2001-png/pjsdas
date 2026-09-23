# Validation

## Principle

Validation tests the user's result, not only the implementation's self-description.

No phase may close solely because code exists, a type/contract exists, unit tests pass, browser E2E passes on a tiny fixture, a page renders, a capability flag is true, a scheduler ran, or a previous roadmap called a related round complete.

## Evidence hierarchy

The package uses complementary evidence:

1. deterministic/domain correctness;
2. command/integration correctness;
3. continuous real-user journeys;
4. production reliability and recovery;
5. visual regression against approved baselines;
6. responsive/dense-workspace behavior;
7. accessibility and keyboard/screen-reader operation;
8. information comprehension where the design makes a comprehension claim;
9. real source/automation end-to-end evidence;
10. legacy retirement/no-dual-authority evidence.

Lower layers do not replace higher layers.

## Deterministic/domain gates

Required categories include occurrence identity and supersession, date/time precision and timezone behavior, process stage/progress/result separation, ranking and decision rules, idempotency/replay, source authorization, provenance, and destructive/external action boundaries.

## Command/integration gates

Tests execute the same boundary used by production clients. At minimum:

- server-side revalidation;
- stale revision with independent change;
- same-object contradictory change;
- duplicate command identity;
- request succeeds but client loses response;
- receipt lookup and safe retry;
- object-level undo dependency;
- account-scoped cache/pending behavior.

Directly seeding a local client database is not sufficient evidence for connected write behavior.

## Continuous real-user journeys

A journey begins at a realistic source or UI action and ends at the user's observable result.

Core examples:

- Today -> Tell PJSDAS -> interpreted result -> authoritative save -> UI projection -> cross-client visibility -> safe Undo;
- reschedule email with quoted prior thread -> existing occurrence updated -> history retained -> Today reflects new time;
- written test completed -> occurrence/action progress updates -> overall recruiting process remains active;
- same-company multiple-role ambiguity -> one meaningful DecisionRequest -> correct resolution;
- offline client action + unrelated Gmail update -> both survive;
- command committed but response lost -> no duplicate on retry;
- account A -> sign out -> account B -> no cache/draft/data leakage.

## Dense-workspace validation

Use realistic scale derived from production shape without publishing private content.

Fixtures include hundreds of opportunities, long company/role names, multiple active processes, dense near-term schedule, substantial history, mixed Chinese/English content, stale/ended opportunities, ambiguous/resolved decisions, and source backlogs/failures.

## Visual regression

Visual regression uses explicitly reviewed baseline screenshots for major routes and states.

Rules:

- do not approve a baseline merely because it matches current output;
- do not auto-update screenshots to make a failing change pass;
- capture empty, normal, dense, loading, pending, error, offline, conflict, and narrow/large-text states;
- compare primary desktop and phone-class widths;
- visual review evaluates hierarchy and craft, not only pixel stability.

## Responsive validation

Required layouts include narrow phone-class viewport, wide phone/tablet transition, desktop, long labels/content, large text, software keyboard/input overlay conditions where applicable, and fixed/sticky/safe-area overlap checks.

An element technically inside the viewport does not prove that the page is understandable or unobstructed.

## Accessibility

Required evidence combines automated checks with actual interaction:

- keyboard-only task completion;
- visible focus;
- focus trapping/restoration for modal/sheet patterns;
- semantic labels and relationships;
- screen-reader task walkthrough for core journeys;
- large-text/reflow behavior;
- reduced-motion behavior where motion exists.

## Automation validation

Separate source transport health, interpretation success/failure, business ambiguity/conflict, and normal capability boundary.

A successful poll or connected OAuth state is not proof that important recruiting information was understood.

For each user-promised source capability, verify the full chain from source observation to authoritative business effect or truthful exception.

## Information comprehension

When claiming Today or a decision is immediately understandable, use task-oriented comprehension checks with people who did not implement the feature. AI heuristic review can prepare and diagnose but is not reported as human comprehension evidence.

## Failure/degraded validation

Every production slice tests offline/read-only continuation, session expiration, permission/source revocation, server timeout, unknown commit outcome, partial source parsing, interpretation uncertainty, true conflict, stale client, and rollback/kill switch.

## Anti-gaming rules

Do not narrow the fixture until a test passes, silently change the metric denominator, convert a failing promised capability into unsupported to close a gate, treat source-code strings as visual/usability evidence, or hide unresolved failures behind a green aggregate health state.

## Completion evidence format

Every phase receipt/report includes user-visible outcome, exact main SHA, changed architectural boundary, preserved invariants, journey evidence, degraded/failure evidence, visual/responsive/accessibility evidence as applicable, production/canary evidence as applicable, retired legacy paths, remaining known limitations, and release/permission/cost state.

## Validation cadence and production-certification scheduling

The evidence hierarchy above is a completion standard, not an instruction to rerun every expensive layer after every small fix.

Use three levels:

1. **Inner loop / candidate** — targeted tests, affected regressions and bounded browser checks for the changed behavior. Do not deploy every candidate.
2. **Engineering phase gate** — implementation complete, required CI, Browser E2E, applicable visual/responsive/accessibility/failure evidence, security/integrity checks, and no known engineering blocker. A phase at this point may be recorded as `ENGINEERING_COMPLETE`.
3. **Production certification gate** — deploy an exact integrated SHA and execute the phase's frozen production canary/journey, cross-client/receipt/Undo or source evidence as applicable. Only after this and every other exact exit criterion pass may the phase be `COMPLETE`.

If the only missing level-3 evidence is unavailable because of an external deployment quota, provider rate limit, or equivalent environment capacity, record `PRODUCTION_PENDING_EXTERNAL`. Do not call it PASS and do not delete the pending evidence.

Under the bounded overlap rule in EXECUTION_PROTOCOL.md, the next frozen CGR phase may proceed with engineering while the earlier phase waits for external production capacity, with a maximum lead of one phase.

When deployment capacity returns, prefer the newest stable integrated exact SHA that contains the pending phases. One deployment may certify multiple pending phases, but each phase's own previously frozen production journey must actually run and be recorded separately against that SHA.

Publication is not part of routine certification. A certification deployment does not imply a public release, and package publication remains separately authorized.

Security, privacy, data-integrity, destructive-action, rollback and real production failures are not deferrable for throughput. If a delayed canary exposes a real product defect, it supersedes forward scheduling and must be repaired before further phase expansion.


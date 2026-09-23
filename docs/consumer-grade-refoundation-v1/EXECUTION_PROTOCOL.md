# Execution Protocol

## Source of truth

Every CGR execution begins by reading:

1. GitHub remote main;
2. docs/consumer-grade-refoundation-v1/STATUS.md;
3. README.md and PRODUCT_INTENT.md in this package;
4. the current phases/CGR-XX.md;
5. TECHNICAL_ARCHITECTURE.md;
6. VALIDATION.md;
7. MIGRATION_AND_RETIREMENT.md;
8. PRESERVE_REFACTOR_REPLACE.md;
9. current production/security/authorization docs required by the affected subsystem;
10. current required CI/release gates.

Chat history and ordinary local clones are not canonical.

## Package precedence

Completed Ultimate Usability work remains implementation history and evidence. Existing security, authorization, source truth, transaction, provenance, idempotency, and exact-SHA release constraints remain binding where preserved by this package.

For post-UU-07 product sequencing, consumer experience, connected Web mutation architecture, frontend retirement, automation closure, and validation, this package is the active development authority.

UU-08 and UU-09 are HOLD — NOT_AUTHORIZED unless the owner later explicitly reactivates them after CGR-05.

## One-phase execution and bounded certification overlap

One engineering execution normally handles only the current authorized CGR phase.

Do not start UU-08/UU-09, add a new CGR phase, broaden external permissions/actions, publish a release, or modify real production data outside the frozen CGR contracts.

The owner has authorized one bounded throughput exception for the fixed CGR-00 through CGR-05 sequence:

- when CGR-N has finished implementation plus all non-production engineering gates and the **only** remaining blocker is external deployment/production-certification availability such as a provider quota or rate limit, record `ENGINEERING_COMPLETE / PRODUCTION_PENDING_EXTERNAL`;
- this is not `COMPLETE`, is not a production PASS, and does not waive any frozen production exit criterion;
- the engineering-stable phase may be integrated to `main` after required CI/browser/security and exact-main engineering checks, while its production certification remains pending;
- CGR-(N+1) may then begin engineering work without waiting for the external quota window, provided it is already part of the frozen six-phase plan and introduces no new owner gate;
- at most **one phase** may be ahead of the earliest production-pending phase. If CGR-(N+1) also reaches engineering completion, do not start CGR-(N+2) until the earlier pending production gate is resolved;
- if a delayed production canary reveals an implementation/product defect rather than an external-environment failure, stop forward engineering and repair the earliest affected pending phase before continuing.

This standing exception authorizes only the bounded one-phase-ahead engineering continuation described above. It does not authorize publication, new permissions, new costs, consequential external actions, or a seventh CGR phase.

## CGR-00 restriction

CGR-00 is docs-only.

It may register/modify canonical package documentation and the Ultimate Usability execution handoff notice. It must not change runtime source, schema, database state, permissions, deployment configuration, automation schedules, production data, or release publication state.

## Completion standard

The first section of every phase completion report must answer:

- what the user can now reliably complete;
- what they could not reliably complete before;
- which failure/degraded cases now recover correctly;
- what remains incomplete.

Only then report commit SHA, changed files, tests, CI, deployment, and production evidence.

Code existence, a contract, tests PASS, page render, or a COMPLETE label is never sufficient by itself.

## Required evidence classes

Each phase addresses the evidence fields in its phase contract:

- required tests;
- continuous real-user journeys;
- visual/responsive evidence;
- production evidence;
- failure/degraded scenarios;
- rollback;
- exact exit criteria.

If an evidence class is intentionally not applicable, the completion report states why.

## AI execution authority

The executor independently decides ordinary software architecture details within this contract, component structure, design-token values and visual-system implementation, interaction microdetails with an objectively safer/clearer option, migration mechanics, testing strategy, debugging, accessibility implementation, and performance/reliability tradeoffs that do not cross owner boundaries.

Do not ask the owner to pixel-design the product, choose libraries, resolve ordinary engineering tradeoffs, or supply bug lists.

## Owner stop conditions

Stop and request an owner decision only for:

- a material product-value tradeoff;
- irreversible data loss/merge/delete or permission expansion;
- new cost, billing requirement, or paid commitment;
- privacy/legal boundary;
- external consequential action such as application submission/withdrawal, recruiting email, or offer decision;
- two materially different product directions with no objective basis to choose.

When no stop condition exists, make the professional decision and continue within the authorized phase.

## Failure classification

When a test or journey fails, classify it before patching:

- implementation defect;
- design/interaction defect;
- architecture/contract defect;
- test/evidence defect;
- environment/external dependency;
- owner-boundary decision.

Do not patch around a design or architecture defect with accumulating exceptions merely to make the old acceptance test pass.

## Branch and integration discipline

Use a bounded branch/PR or another repository-approved method.

Before merge:

- re-read remote main;
- verify changed paths stay in authorized scope;
- preserve exact-SHA evidence;
- resolve drift rather than overwriting concurrent work.

After merge:

- re-read remote main;
- re-read STATUS.md;
- record the exact closure state.

## Release discipline

Publication remains separate from implementation completion unless the phase explicitly includes and the owner authorizes publication.

Deployment for certification is also separate from publication. Do not deploy every inner-loop candidate. When external deployment capacity is limited, prefer one stable exact integrated SHA and use that deployment to run the frozen production acceptance journeys for every pending phase whose code is contained in that SHA.

A single deployment may support multiple phase receipts only when each phase's own frozen canary/journey is actually executed and recorded against that same exact deployed SHA. Historical candidate deployments are not required merely to recreate chronology.

Existing exact-SHA, authorization, security, data-integrity and production gates may be strengthened but not weakened to make CGR pass. A quota/rate-limit result is `PRODUCTION_PENDING_EXTERNAL`, never PASS.

## Sensitive-data discipline

Public repo evidence must not contain raw recruiting emails, private workspace exports, unnecessary PII, secrets/tokens, or private ChatGPT/PAIA text. Use synthetic/redacted fixtures, hashes, counts, or bounded metadata.

## Stop after package registration

After CGR-00 registration is merged and verified, stop. CGR-01 remains READY — NOT_STARTED until a later explicit execution request.

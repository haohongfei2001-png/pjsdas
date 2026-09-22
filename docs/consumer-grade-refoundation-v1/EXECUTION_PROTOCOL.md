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

## One-phase execution

One execution handles only the current authorized CGR phase.

Do not start a later CGR phase, start UU-08/UU-09, add a new CGR phase, broaden external permissions/actions, publish a release, or modify real production data outside the phase contract.

A phase completion does not authorize the next phase automatically.

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

Existing exact-SHA, authorization, security, and production gates may be strengthened but not weakened to make CGR pass.

## Sensitive-data discipline

Public repo evidence must not contain raw recruiting emails, private workspace exports, unnecessary PII, secrets/tokens, or private ChatGPT/PAIA text. Use synthetic/redacted fixtures, hashes, counts, or bounded metadata.

## Stop after package registration

After CGR-00 registration is merged and verified, stop. CGR-01 remains READY — NOT_STARTED until a later explicit execution request.

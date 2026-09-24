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

## Continuous engineering and deferred production certification

One active writer still owns one CGR phase/runtime boundary at a time. This prevents conflicting implementation, but it is **not** a package-level stop rule.

Do not start UU-08/UU-09, add a new CGR phase, broaden external permissions/actions, publish a release, or modify real production data outside the frozen CGR contracts.

For the fixed CGR-00 through CGR-05 sequence, the owner authorizes continuous unattended engineering with separate engineering and production-certification frontiers:

- when CGR-N has finished implementation plus all non-production engineering gates and the **only** remaining blocker is external deployment/production-certification availability such as a provider quota or rate limit, record `ENGINEERING_COMPLETE / PRODUCTION_PENDING_EXTERNAL`;
- this is not `COMPLETE`, is not a production PASS, and does not waive any frozen production exit criterion;
- record each unresolved obligation in `DEFERRED_FINAL_GATES.md`;
- the engineering-stable phase may be integrated to `main` after required CI/browser/security and exact-main engineering checks while its production certification remains pending;
- after releasing that phase writer, automatically begin the next phase already present in the frozen CGR-00..CGR-05 plan when its engineering work does not logically depend on the missing production result and it introduces no owner gate;
- there is **no arbitrary one-phase lead limit**. Continue through CGR-05's automatable engineering/certification work as dependencies permit;
- if only part of a later phase requires production evidence, defer that evidence/action and complete the independent engineering, reliability, accessibility, migration-retirement, test, and documentation work;
- CGR-05 and the package cannot close until all applicable earlier deferred production gates plus CGR-05's own production gates actually pass;
- if delayed production evidence reveals an implementation/product defect, reopen and repair the earliest affected behavior and revalidate downstream evidence that depended on it. Unrelated independent work need not be discarded or globally stopped.

The unattended package-level wait point is reached only after all automatable CGR-00..CGR-05 work is exhausted and remaining items are exclusively true owner gates, external-only evidence gates, or safety/integrity dependencies.

If STATUS.md still contains the superseded one-phase-ahead wording while an active phase PR is reconciling it, this continuous-execution section governs sequencing; reconcile STATUS on that active writer before phase closure.

This standing authorization does not permit publication, new permissions, new costs, consequential external actions, or a seventh CGR phase.

## CGR-00 restriction

CGR-00 is docs-only.

It may register/modify canonical package documentation and the Ultimate Usability execution handoff notice. It must not change runtime source, schema, database state, permissions, deployment configuration, automation schedules, production data, or release publication state.

## Verification cadence for remaining work

For unfinished CGR work, especially CGR-05, validation is risk-based rather than repeated wholesale after every small commit.

- **Inner loop / draft push:** run targeted tests for the changed command/read-model/UI path plus the automatic unit/type gate. Keep privacy, authorization, data-integrity and destructive-action invariants covered whenever the affected code can touch them.
- **Coherent batch checkpoint:** after a related group of migrations/refactors is complete, run the directly affected browser journeys and fault/recovery checks. Do not rerun dense-workspace, full visual, full accessibility, long-session or every historical journey after each scoped command conversion.
- **Engineering phase closure:** mark the PR ready and run full CI/build/security plus Browser E2E once on the stable exact head, followed by exact-main integration evidence.
- **Final CGR-05 convergence:** run dense workspace, long session, account isolation, broad cross-client, accessibility/screen-reader, visual/responsive, degraded/recovery and legacy-retirement closure evidence against the integrated candidate. Production canaries remain a separate final frontier.

A failing safety/integrity regression in an affected path still blocks that path immediately. This cadence only moves broad unrelated coverage later; it does not weaken the final CGR-05 exit criteria.

Already completed CGR phases keep their historical evidence and are not recertified because of this scheduling amendment.

## Terminal convergence and event-driven resume

Once the CGR engineering frontier has reached CGR-05 integrated/final-convergence state and no new automatable implementation, repair, migration, or evidence preparation is currently actionable, **do not keep Work alive through fixed-interval GitHub polling**.

When the remaining work consists only of already-launched CI/browser/accessibility/long-session jobs, deployment propagation, or frozen production/current-live canaries whose result is not yet available:

- record the exact outstanding run/deployment/canary once;
- exit the current execution cleanly instead of repeatedly rereading unchanged STATUS, Actions, deployment state, or remote main;
- resume analysis only when a terminal result/new deployment SHA/actionable failure is presented, or when the owner explicitly resumes the package;
- a terminal failure that has an engineering remedy reactivates continuous engineering immediately; ordinary diagnosis and repair remain autonomous;
- a terminal success advances the remaining frozen convergence gates without recreating historical candidate evidence.

This event-driven convergence rule applies only after actionable engineering is exhausted. It must never be used to defer an available repair, migration, test fix, accessibility defect, or required certification action.

After CGR-05/package closure, stop this package. Do not automatically enter UU-08, UU-09, a new CGR phase, or another product-development line without new owner authorization.

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

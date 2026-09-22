# Development Plan

Finite plan:
1. CGR-00 — Contract & Scope Freeze
2. CGR-01 — Authoritative Command Foundation
3. CGR-02 — Today Vertical Slice
4. CGR-03 — Opportunity Workspace
5. CGR-04 — Natural Intake & Automation Closure
6. CGR-05 — Consumer-Grade Certification

Only the phase named READY in `STATUS.md` may execute, and READY never means auto-start.

## Feature freeze

Through CGR-05, feature work outside this plan is frozen except bounded production/security repair
or explicit package amendment. CGR-05 allows no new capability.

## Prototype rule

Do not build a complete disposable prototype. Freeze high-fidelity target states/reference
composition/interaction/visual baselines, then implement through real production-grade vertical
slices.

## Phase intent

**CGR-00:** docs-only freeze of product responsibility, target experience, architecture, validation,
migration/retirement and phase contracts.

**CGR-01:** replace ordinary connected Web whole-snapshot mutation with typed authoritative server
commands; structured receipts; account-scoped cache/pending; object-aware conflict/Undo; no database
rewrite.

**CGR-02:** deliver Today → Tell PJSDAS → explicit understanding → authoritative save → projection →
cross-client visibility → safe Undo, plus final-direction shell/Today/design primitives.

**CGR-03:** complete Opportunities / Detail / Decisions / Prep context / Settings and delete migrated
legacy UI/CSS/daily write paths.

**CGR-04:** unify Web/Gmail/PAIA-current-chat contextual interpretation/feedback. Separate transport
failure, interpretation failure, business ambiguity and normal capability boundary. Flags or
`unsupported` cannot substitute for promised end-to-end capability.

**CGR-05:** no new features. Certify density, cross-client/device, long sessions, failures, visual
regression, responsive, large text, keyboard, screen reader, account isolation, production canary
and legacy retirement.

## Completion report order

1. What the user can now reliably do.
2. What previously prevented it.
3. What remains incomplete.
4. Then SHA, migrations, tests, CI, browser, visual/accessibility and production evidence.

## Owner checkpoints

Stop only for product-value tradeoff, irreversible data/permission, new material cost,
privacy/legal boundary, protected external consequence or genuinely different non-dominated
directions. Ordinary implementation/design choices remain delegated.

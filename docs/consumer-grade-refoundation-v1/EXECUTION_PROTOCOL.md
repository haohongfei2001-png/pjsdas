# Execution Protocol

## Read first

Every execution re-reads remote `main`; this `STATUS.md`; package README/Product Intent/Target
Experience/Technical Architecture/Preserve-Refactor-Replace/Validation/Migration; current
`phases/CGR-XX.md`; and relevant current runtime/security/release constraints.

Chat history, local clone, stale handoff, historical READY state and old SHA hints are not authority.

## One phase only

Execute only the current explicitly authorized CGR phase. Do not auto-start the next phase.
UU-08/UU-09 are not alternate next work during CGR.

## Completion

A phase closes only when user-visible outcome, exact exit criteria, continuous journeys, degraded
scenarios, required visual/responsive/accessibility evidence, production evidence,
migration/retirement and rollback are satisfied and remote main/STATUS are re-read.

Never close solely because code/contracts exist, tests/CI pass, a page renders or a PR merges.

## Completion report

Lead with what the user can now reliably do; what previously prevented it; what remains incomplete.
Technical evidence comes after.

## Owner decisions

Proceed independently on ordinary architecture, components, libraries, visual hierarchy,
accessibility, performance, tests, compatibility, refactors and bugs.

Stop only for product-value tradeoff, irreversible data/permission, new material paid commitment,
privacy/legal boundary, protected external consequence or genuinely non-dominated product
directions. Do not ask the owner to design pixels, choose normal implementation approaches or find
bugs.

## Safety / evidence

No job submission, external withdrawal, recruiting mail, Offer decision, permission expansion,
CAS/idempotency/provenance bypass, evidence deletion or release publication is authorized.

Do not commit raw recruiting mail, secrets/tokens, private workspace dumps or unnecessary PII.

## Prototype / CGR-00

No disposable complete prototype. Reference composition/visual baselines are allowed; implementation
uses production vertical slices. CGR-00 is docs-only and stops with CGR-01 READY — NOT_STARTED.

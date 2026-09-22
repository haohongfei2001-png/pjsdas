# Preserve / Refactor / Replace

| Area | Disposition | Contract |
|---|---|---|
| Opportunity / Process / Action / Prep semantics | PRESERVE | Keep identities and business meanings; fix only demonstrated correctness defects |
| ScheduleNode / occurrence / temporal precision | PRESERVE BUT HARDEN | Keep stable occurrence/version semantics; verify every new client/source uses them consistently |
| deterministic Decision Rules / ranking | PRESERVE BUT HARDEN | Keep one deterministic source of ranking truth; improve executability and presentation |
| Semantic Intake policy kernel | PRESERVE BUT HARDEN | Keep authorization/no-write/DecisionRequest policy; strengthen interpretation and feedback before the kernel |
| DecisionRequest | PRESERVE BUT HARDEN | Keep durable ambiguity model; prevent technical errors from becoming fake decisions |
| Supabase transactional workspace | PRESERVE BUT HARDEN | Keep current authority; add authoritative typed command execution without wholesale database redesign |
| CAS / command ledger / receipts | PRESERVE BUT HARDEN | Retain integrity and idempotency; refine object-level conflict and undo dependency semantics |
| provenance / source identity / idempotency | PRESERVE | Non-negotiable trust foundation |
| Gmail cursor / lease / continuation / replay protection | PRESERVE BUT HARDEN | Keep transport reliability; separate transport health from interpretation completeness |
| exact-SHA release / authorization / security gates | PRESERVE BUT HARDEN | Retain all gates; add full product-journey evidence |
| whole-snapshot connected daily mutation/sync | REPLACE | Move routine mutations to server-executed business commands; keep bounded import/recovery only |
| IndexedDB as de facto connected workspace authority | REPLACE | Make it account-scoped cache, drafts, and pending-operation storage |
| Web parser/regex as primary natural-language capability | REFACTOR | Keep deterministic helpers; add contextual interpretation and measurable coverage |
| source health/coverage reporting | REFACTOR | Separate transport, interpretation, ambiguity, failure, and normal capability boundary |
| Today read model / action target semantics | REFACTOR | Preserve domain facts; require actionable targets and truthful freshness/save state |
| Opportunities list/detail read models | REFACTOR | Preserve domain; improve composition, continuity, history truthfulness, and context |
| current App shell/page-state monolith | REPLACE | Rebuild production shell by stable feature boundaries and shared application services |
| manual route state where it harms navigation | REPLACE | Adopt stable URL/back/restore semantics |
| Today / Opportunities / detail / capture / settings presentation | REPLACE IN SLICES | Reimplement on final primitives while keeping domain/read-model semantics |
| accumulated global CSS override layers | REPLACE / DELETE AFTER MIGRATION | One token/primitive source; remove old layers as consumers disappear |
| duplicate historical daily entrypoints | DELETE AFTER MIGRATION | No permanent parallel UI/write authorities |
| compatibility adapters serving a verified migration need | PRESERVE TEMPORARILY | Time-box, instrument, then retire when no consumer remains |
| source-code string checks used as product/visual acceptance | REPLACE AS PRIMARY EVIDENCE | May remain as static guards; cannot certify usability or visual quality |
| browser/E2E tests that exercise real behavior | PRESERVE BUT EXPAND | Add dense data, failure, cross-client, responsive, accessibility, and comprehension evidence |
| production self-test contract/security checks | PRESERVE BUT EXPAND | Keep them; do not describe them as end-to-end product certification |

## Rewrite restraint

REPLACE does not mean rewrite adjacent correct systems.

A replacement must have a defined migration boundary, preserved invariants, evidence of parity, a retirement target, and rollback behavior. Database normalization, new backend stacks, or distributed-service decomposition require demonstrated necessity, not architectural preference.

## Sunk-cost restraint

Historical investment, test count, or COMPLETE status cannot keep an implementation that materially blocks the target experience.

The burden of proof applies in both directions: preserve correct foundations; retire harmful legacy once migration evidence exists.

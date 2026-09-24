# PJSDAS Consumer-Grade Refoundation v1 — Canonical Status

Package: PJSDAS-CONSUMER-GRADE-REFOUNDATION-v1
Version: 1.0
Registration baseline inspected: main@fbc9cb7577da14eae9855205c27f1f926d407cbf
Prior canonical roadmap state observed: UU-07 COMPLETE; UU-08 READY — NOT_STARTED before this handoff
Product origin: https://todayaction.com

## Package state

Status: ACTIVE — CGR-03 COMPLETE; CGR-04 PRODUCTION_PENDING_EXTERNAL; CGR-05 final certification in progress
Current production-pending phase: CGR-04
Last completed phase: CGR-03
Current engineering phase: CGR-05 ENGINEERING_INTEGRATED — final certification in progress
Automatic continuation: ENABLED through dependency-safe CGR-05 final convergence under EXECUTION_PROTOCOL.md; production deployment is intentionally batched until the next stable exact integrated candidate, and deferred production gates remain mandatory for final closure

## Phase state

| Phase | State | Notes |
|---|---|---|
| CGR-00 | COMPLETE — CONTRACT & SCOPE REGISTERED | Docs-only design convergence, architecture/validation/migration contracts, six-phase plan, and execution handoff; no runtime implementation |
| CGR-01 | COMPLETE — AUTHORITATIVE COMMAND FOUNDATION | Typed server commands, durable receipts, object-aware conflict/Undo, account-scoped cache/pending recovery, bounded snapshot compatibility, production migration/canary and exact-main gates complete |
| CGR-02 | COMPLETE / PASS | Today Vertical Slice production command canary, exact-main engineering and cleanup passed at runtime `408faba1b34f31614dba8c5ec84b656c8dca9866`; see `receipts/CGR-02.md` |
| CGR-03 | COMPLETE / PASS | Engineering evidence plus production list/detail/deep-link/decision/action/Undo canary and synthetic identity cleanup passed on exact deployed runtime `0c70dcc6780a0be4d2ba2623700b549a46ac9342`; see `receipts/CGR-03.md` |
| CGR-04 | ENGINEERING_COMPLETE / PRODUCTION_PENDING_EXTERNAL | Original engineering closure PR #133 remains valid, but production audit exposed a real Gmail interpretation defect later repaired in PR #146. Latest product-runtime repair is `58bd9dcbcc01b0a52b1e093a966e5992970f7bde`; exact-main CI `35965614599` and Browser E2E `35965614627` passed. Production still serves the older stable runtime, so final current-live source certification remains pending |
| CGR-05 | ENGINEERING_INTEGRATED / FINAL_CERTIFICATION_IN_PROGRESS | Long-session `35942876277`, cross-browser RC `35961179744`, broad Browser E2E and expanded real VoiceOver all pass. PR #146 also removed a repeated connected sign-out reliability flake on latest product runtime `58bd9dcbcc01b0a52b1e093a966e5992970f7bde`. Remaining frontier is one batched exact-production deployment, source canaries, and final evidence reconciliation |

## Ultimate Usability handoff

- UU-00 through UU-07 remain historical implementation/evidence.
- UU-08 is HOLD — NOT_AUTHORIZED while this package is active.
- UU-09 is HOLD — NOT_AUTHORIZED while this package is active.
- Future iPhone implementation is not authorized by this package.
- Release publication remains a separate owner decision.

## Preserved foundation

The following are frozen as preserved foundations unless a future CGR phase demonstrates a concrete correctness defect:

- Opportunity / Process / Action / Prep semantics;
- ScheduleNode / occurrence / temporal precision;
- deterministic Decision Rules / ranking;
- Semantic Intake policy kernel;
- DecisionRequest;
- Supabase transactional workspace;
- CAS / command ledger / receipts / provenance;
- source identity / idempotency;
- Gmail cursor / lease / continuation / replay protection;
- exact-SHA release / authorization / security gates.

## CGR-01 closure

Functional integration main: `0b295f15d2eb74b2cc240bad47a02137cb5749ac`.

CGR-01 moved the CGR-02 prerequisite connected-Web mutation families to typed authoritative server commands with durable receipt recovery, object/dependency-aware conflict and Undo, account-bound cache/draft/pending behavior, and explicit bounded snapshot compatibility. Production Supabase migration `20260923033356 cgr01_authoritative_commands` is applied. Exact-main CI, Browser E2E, Vercel, Pages, Production Self-Test, and publication-disarmed release gate all passed.

Closure evidence: `docs/consumer-grade-refoundation-v1/receipts/CGR-01.md`.

CGR-02 engineering was integrated at `cb98205edaaf5c71b99a33cb751310b3226657f2` and recorded while external certification was pending in `receipts/CGR-02-ENGINEERING.md`. The owner-authorized dedicated synthetic account canary later passed against exact production runtime `408faba1b34f31614dba8c5ec84b656c8dca9866` with verified two-session command/receipt/Undo and cleanup; final evidence is `receipts/CGR-02.md`. The first failed canary's revoked account had zero commands and unchanged workspace and was removed by guarded recovery before the successful run. CGR-03 engineering integrated through PR #127 and the real VoiceOver repair PR #131 at runtime main `2ebd8358dae4999eb16dbd66393ae2029062385d`. Exact-main CI `35895579807`, Browser E2E `35895579623`, and real VoiceOver/visual run `35895579943` succeeded. That earlier runtime was deployment-rate-limited; the later integrated runtime `0c70dcc6780a0be4d2ba2623700b549a46ac9342` reached production and passed the frozen CGR-03 canary `35945236292` with synthetic identity cleanup. See `receipts/CGR-03.md`. CGR-03 is COMPLETE; CGR-04 remains production-pending.

The owner has superseded the former one-phase-ahead throughput cap with dependency-safe continuous engineering for the frozen CGR-00..CGR-05 package. CGR-04 engineering merged through PR #133 at `0acf71aca95708cd46cc9f50011e62a3a6ca23cf`; exact-main CI `35909962934`, Browser E2E `35909962931`, and real VoiceOver/visual run `35909963042` succeeded. Its sole writer is released. CGR-04 remains PRODUCTION_PENDING_EXTERNAL, not COMPLETE; its current-live source canaries are tracked in `DEFERRED_FINAL_GATES.md`; CGR-03 is now closed there. CGR-05 engineering is integrated and final certification is in progress. Final CGR-04/CGR-05/package COMPLETE remains impossible until every applicable deferred production canary/evidence item actually passes. UU-08/UU-09 remain on hold and release publication remains a separate owner decision.

## CGR-05 integrated engineering candidate

PR #137 integrated at runtime main `8d4da747305f97b1d86709bc9d9d138082ccfd4c`. Exact-main CI `35942856418` and Browser E2E `35942856408` passed; candidate full CI `35942483468` and Browser E2E `35942511137` passed at `e78b24d523425791e8503eb21aa9d42c1dafe4a8`. The last runtime change before test/docs/policy integration was `119afe53cdaebf3a7abf1bb37f41d62bb85cad8a`; macOS visual and real VoiceOver run `35940801520` passed against that same runtime. The separate two-hour headless connected-session run `35942876277` completed SUCCESS on the integrated candidate. See `receipts/CGR-05-ENGINEERING-CANDIDATE.md` and `CGR05_LEGACY_AUDIT.md`.

This is an integrated engineering candidate, not CGR-05 COMPLETE. The two-hour connected-session gate, final Chromium/Firefox/WebKit/mobile RC hardening, dense workspace, account isolation, lost-response/conflict recovery, keyboard, responsive/large-text, degraded-state and expanded real VoiceOver engineering journeys pass. Production audit on the older deployed runtime `0c70dcc6780a0be4d2ba2623700b549a46ac9342` proved live Gmail transport but also exposed a real interpretation defect: one Southern Asset Management written-test reminder with no matching Opportunity produced unrelated target choices and multiple DecisionRequests. PR #146 repaired that defect plus the repeated connected sign-out race at latest product-runtime change `58bd9dcbcc01b0a52b1e093a966e5992970f7bde`; exact-main CI `35965614599` and Browser E2E `35965614627` passed. Therefore the old Gmail production observation is diagnosis evidence, not final source PASS. Production must advance to the later stable exact integrated candidate before final source certification. The existing CGR-03 production browser canary can be rerun on that final SHA for Web; the prepared CGR-04 MCP canary covers real `/api/mcp` current-chat semantics, replay, cross-session resolution and PAIA no-grant fail-closed behavior. No active delegated authorization grant currently exists for PAIA, so an authorized PAIA transport must not be fabricated or described as active. CGR-04/CGR-05 certification remains pending. No release publication is claimed.

## Registration result

The package defines reconstructed product responsibility, concrete consumer-grade target experience, technical refoundation boundary, preserve/refactor/replace decisions, fixed CGR-00 through CGR-05 development plan, outcome-based validation model, migration and legacy-retirement rules, execution/owner-decision protocol, and exact contracts for all six phases.

This registration result is historical CGR-00 evidence. Current phase eligibility and authorization are defined only by the Package state / Phase state sections above and the current owner instruction.

# PJSDAS Consumer-Grade Refoundation v1 — Canonical Status

Package: PJSDAS-CONSUMER-GRADE-REFOUNDATION-v1
Version: 1.0
Registration baseline inspected: main@fbc9cb7577da14eae9855205c27f1f926d407cbf
Prior canonical roadmap state observed: UU-07 COMPLETE; UU-08 READY — NOT_STARTED before this handoff
Product origin: https://todayaction.com

## Package state

Status: COMPLETE — STABLE CONSUMER-GRADE BASELINE
Current production-pending phase: NONE
Last completed phase: CGR-05
Current engineering phase: NONE — PACKAGE CLOSED
Automatic continuation: STOPPED. Owner Amendment `OWNER_AMENDMENT_2026-09-25.md` converts the unavailable fresh-recruiting-Gmail event from a blocking exit criterion into post-closure observation `OBS-CGR-001`. No UU-08/UU-09/new CGR phase/release publication is authorized by this closure.

## Phase state

| Phase | State | Notes |
|---|---|---|
| CGR-00 | COMPLETE — CONTRACT & SCOPE REGISTERED | Docs-only design convergence, architecture/validation/migration contracts, six-phase plan, and execution handoff; no runtime implementation |
| CGR-01 | COMPLETE — AUTHORITATIVE COMMAND FOUNDATION | Typed server commands, durable receipts, object-aware conflict/Undo, account-scoped cache/pending recovery, bounded snapshot compatibility, production migration/canary and exact-main gates complete |
| CGR-02 | COMPLETE / PASS | Today Vertical Slice production command canary, exact-main engineering and cleanup passed at runtime `408faba1b34f31614dba8c5ec84b656c8dca9866`; see `receipts/CGR-02.md` |
| CGR-03 | COMPLETE / PASS | Engineering evidence plus production list/detail/deep-link/decision/action/Undo canary and synthetic identity cleanup passed on exact deployed runtime `0c70dcc6780a0be4d2ba2623700b549a46ac9342`; see `receipts/CGR-03.md` |
| CGR-04 | COMPLETE / PASS UNDER OWNER-AMENDED CONTRACT | Final exact production runtime `58e9f7f4bd584139ffeb8c17a3ee6c8c15d94c3a` passes Production Self-Test and production certification run `36030107785`. Web and real `/api/mcp` current-chat paths pass; PAIA is truthfully inactive/fail-closed without a delegated grant; repaired-runtime Gmail transport accounted 12/12 real messages with 0 unresolved and no guessed business objects. The unavailable fresh natural recruiting-email event is preserved as post-closure observation `OBS-CGR-001`, not claimed as PASS. |
| CGR-05 | COMPLETE — STABLE CONSUMER-GRADE BASELINE | Exact production `58e9f7f4bd584139ffeb8c17a3ee6c8c15d94c3a`: CI `36029890017` SUCCESS; Browser `36029889958` 71/71 clean with sign-out and offline capture both first-pass; Pages `36029890057` SUCCESS; Production Self-Test `36030107858` SUCCESS; real macOS visual + VoiceOver `36029889938` SUCCESS; one-shot CGR-02/03/04 production certification `36030107785` SUCCESS. Long-session and cross-browser RC evidence remain valid. Owner Amendment `OWNER_AMENDMENT_2026-09-25.md` closes the only environment-dependent wait item as a post-closure observation. |

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

The package is COMPLETE under the owner-amended validation contract. Runtime `58e9f7f4bd584139ffeb8c17a3ee6c8c15d94c3a` is the certified production runtime. Exact-main CI, 71/71 Browser E2E with zero retry/flaky, real macOS visual, real VoiceOver, Production Self-Test, long-session/cross-browser evidence, and the one-shot CGR-02/03/04 production certification all pass. CGR-02 verified authoritative command/receipt/Undo and cleanup; CGR-03 verified production list/detail/deep-link/DecisionRequest/action/Undo with cross-session readback and cleanup; CGR-04 verified real production `/api/mcp`, current-chat Semantic Intake, one bounded DecisionRequest, replay idempotency, decision resolution and PAIA no-grant fail-closed behavior. The CGR-04 canary truthfully records that delegated ChatGPT-host OAuth and authorized PAIA transport were not certified because those capabilities were unavailable/inactive. Gmail ran live after the repaired backend was active: 12/12 real non-recruiting messages were accounted, 0 unresolved, with only ingestion/audit timeline effects and no guessed business objects. Owner Amendment `OWNER_AMENDMENT_2026-09-25.md` reclassifies the unavailable fresh natural recruiting-Gmail event as post-closure observation `OBS-CGR-001`; it is not represented as a passed canary. Release publication remains separately disarmed by `.github/release-plan.json` (`publishOnProductionSuccess: false`).

## Registration result

The package defines reconstructed product responsibility, concrete consumer-grade target experience, technical refoundation boundary, preserve/refactor/replace decisions, fixed CGR-00 through CGR-05 development plan, outcome-based validation model, migration and legacy-retirement rules, execution/owner-decision protocol, and exact contracts for all six phases.

This registration result is historical CGR-00 evidence. Current phase eligibility and authorization are defined only by the Package state / Phase state sections above and the current owner instruction.

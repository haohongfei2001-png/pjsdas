# CGR-01 — Authoritative Command Foundation Closure Receipt

State: COMPLETE
Functional integration main: `0b295f15d2eb74b2cc240bad47a02137cb5749ac`
Implementation PR: #120

## User outcome

Connected Web mutation families required by CGR-02 no longer depend on a client-authored whole-workspace snapshot as business authority.

The covered path is now:

`client intent -> typed server command -> authoritative revalidation -> transactional commit -> durable receipt -> local read-model/cache projection`.

The user can safely recover an unknown response by command/receipt identity, retry idempotently, receive a concrete same-object conflict, switch accounts without exposing another account's cache/drafts/pending queue, and Undo across unrelated later revisions without erasing the unrelated update.

## Runtime delivered

- typed authoritative commands for bounded user domain commands, Web Semantic Intake, DecisionRequest resolution, and compensating Undo;
- stable command identity plus durable receipt identity;
- object/dependency metadata on authoritative receipts;
- stale-command rebase when intervening authoritative writes affect only unrelated objects;
- concrete fail-closed same-object conflict semantics;
- dependency-aware Undo;
- account-scoped drafts and pending operations with reconnect/focus/session replay;
- explicit unknown-outcome state after transport loss and receipt-first recovery;
- session-expiry/pre-execution authorization rejection distinguished from unknown commit outcome;
- account A cache eviction before account B exposure;
- Today action completion/Undo, Tell PJSDAS, DecisionRequest resolution, and fixed-event completion routed through authoritative commands in transactional connected mode;
- bounded whole-snapshot compatibility requires explicit purpose and is ledgered with rich object receipts;
- stale snapshot CAS remains fail-closed.

## Preserved foundation

CGR-01 retained the existing Opportunity / Process / Action / Prep semantics, ScheduleNode and occurrence history, temporal precision, deterministic ranking, Semantic Intake policy kernel, DecisionRequest, Supabase JSONB workspace, CAS, provenance, source identity, authorization, idempotency, Gmail continuation/lease/replay behavior, and exact-SHA release gates. It did not normalize or rewrite the database.

## Production schema

Applied production migration:

- Supabase project: `pjsdas-auth` / `yyrzwpoxlxpafdlbkdtg`;
- migration version: `20260923033356`;
- migration name: `cgr01_authoritative_commands`;
- additive index: `pjsdas_command_ledger_user_revision_idx`;
- additive RPC: `public.pjsdas_commit_workspace_v2`.

Permission verification after migration:

- RPC is `SECURITY DEFINER`;
- `service_role EXECUTE = true`;
- `authenticated EXECUTE = false`;
- `anon EXECUTE = false`.

Supabase advisors reported no new CGR-01-specific privilege defect. Existing unrelated Auth/Gmail lints remain outside this phase.

## Required journey evidence

The connected browser suite proves:

1. server commit followed by lost response, failed first receipt lookup, reload, receipt recovery with the same command identity, and no duplicate command;
2. authoritative action completion plus a later unrelated mutation, followed by Undo preserving that unrelated mutation;
3. phone-width, keyboard-triggered same-object conflict with concrete semantic feedback and refreshed authoritative cache;
4. account A sign-out then account B with A data removed from the live UI, A draft absent, and A pending command not replayed into B.

Additional integration tests prove:

- cross-source unrelated updates rebase safely;
- same-object updates fail closed;
- dependent updates block Undo;
- occurrence completion/reschedule execute against occurrence identity;
- Web Semantic Intake and DecisionRequest resolution execute server-side;
- first-party Web source authorization fails closed;
- undeclared whole-snapshot writes are rejected;
- bounded stale snapshot writes cannot replace newer authoritative fields;
- session reauthentication replays the stable pending command safely.

## Production canary

A bounded production database canary executed the v2 commit RPC against the real transactional workspace inside an explicit transaction:

- first commit -> `COMMITTED`;
- exact retry -> `ALREADY_APPLIED`;
- compensating Undo -> `COMMITTED`;
- exact Undo retry -> `ALREADY_APPLIED`;
- explicit `ROLLBACK`;
- post-check confirmed no canary ledger rows persisted.

No external recruiting action occurred and no user-visible canary data remained.

## Exact-main evidence

Functional integration main: `0b295f15d2eb74b2cc240bad47a02137cb5749ac`.

- CI run `35817846185` / #1225 — SUCCESS; 179 test files / 771 tests passed; build and security gates passed.
- Browser E2E run `35817846058` / #557 — SUCCESS; 39/39 Chromium journeys passed.
- Vercel commit status — SUCCESS for exact functional main SHA.
- Deploy PJSDAS to GitHub Pages run `35817846092` / #484 — SUCCESS; exact backend match, production contract, frontend build/manifest and Pages deploy passed.
- Production Self-Test run `35817943508` / #126 — SUCCESS; exact commit, transactional authority, CGR-01 capability markers and frontend manifest all passed.
- Publish verified PJSDAS release run `35817964354` / #91 — SUCCESS with publication remaining disarmed.

## Snapshot compatibility boundary

Whole-snapshot connected writes are not ordinary authority for the migrated CGR-02 prerequisite families.

Retained uses are explicitly bounded to:

- `legacy_uncovered_web` — unmigrated legacy Web operations pending later CGR route migration;
- `migration_recovery` — explicit migration/recovery flows;
- `compatibility` — deliberately supported compatibility callers.

Missing purpose is rejected. Every retained compatibility write remains CAS-checked and now produces object-aware receipt metadata. CGR-02/CGR-03 own further retirement as their routes migrate.

## Remaining limitations

- CGR-01 does not implement the final Today visual/read-model vertical slice; that belongs to CGR-02.
- Some Web operations outside the CGR-02 prerequisite mutation families still use the explicitly bounded `legacy_uncovered_web` compatibility path until their owning phase migrates them.
- Final cross-client presentation/freshness targets and visual baselines are CGR-02 responsibilities.
- No iPhone work, UU-08 work, new paid service, permission expansion, or external recruiting consequential action was started.

## Handoff

CGR-01 is COMPLETE.

CGR-02 may be marked READY — NOT_STARTED, but this closure does not authorize or start CGR-02.

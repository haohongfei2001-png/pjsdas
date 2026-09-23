# CGR-01 — Authoritative Command Foundation

State: COMPLETE

## User-visible outcome

Routine connected changes no longer depend on replacing an entire client-authored workspace snapshot.

For covered actions, the user receives truthful pending/saved/unknown-result feedback, safe retry, concrete conflict handling, and undo that is not blocked merely because an unrelated object changed later.

## Scope

- define and implement typed authoritative business commands for mutation classes required by CGR-02/CGR-03;
- execute commands on the authoritative server against current state;
- return structured receipts;
- implement account-scoped cache/draft/pending-operation behavior;
- add receipt lookup for unknown network outcomes;
- establish object/dependency-aware conflict handling;
- establish dependency-aware compensating Undo;
- move covered connected Web writes off daily whole-snapshot mutation;
- retain existing domain logic and transactional workspace.

Minimum command coverage before exit includes the mutation families required for the CGR-02 journey: semantic fact intake, occurrence completion/reschedule as applicable, DecisionRequest resolution, and Undo/compensation.

## Non-goals

- no wholesale database normalization/rewrite;
- no final Today visual redesign;
- no full Opportunities redesign;
- no new external recruiting action authority;
- no new paid infrastructure unless separately approved;
- no iPhone implementation.

## Preserved invariants

Domain meanings/stable identities, ScheduleNode/occurrence/temporal precision, deterministic ranking/decision logic, Semantic Intake policy, DecisionRequest, server transaction/CAS/ledger/receipt/provenance/idempotency, source authorization, and exact-SHA/security/release gates.

## Architecture changes

- routine connected mutation becomes client intent -> typed server command -> authoritative validation/transaction -> structured receipt;
- Web pages consume command/read-model services rather than author replacement snapshots;
- local persistence becomes account-scoped cache/drafts/pending operations in connected mode;
- receipt identity supports recovery from lost responses;
- conflict/undo evaluation uses affected objects/dependencies rather than only global workspace equality.

## Migration

Introduce the command path compatibly. Migrate covered operations one family at a time. Do not keep active-active business authority.

Whole-snapshot write may remain temporarily only for explicitly uncovered legacy operations, import/recovery, or bounded rollback. Every remaining daily use is enumerated before exit.

## Legacy retirement

Before exit:

- retire whole-snapshot connected daily mutation for all command families required by CGR-02;
- mark remaining snapshot uses with purpose and retirement phase;
- prevent old/stale clients from overwriting newer authoritative fields.

## Required tests

- domain parity between legacy and new commands;
- server-side stale-state revalidation;
- duplicate command idempotency;
- source authorization;
- same-object and independent-object concurrency;
- response-lost-after-commit recovery;
- receipt lookup;
- compensating Undo with unrelated later updates;
- dependent later update blocking/narrowing Undo;
- account A/B cache isolation;
- session expiration and reauthentication;
- pending queue replay without duplication.

## Continuous real-user journeys

1. Complete one internal action/occurrence from connected Web, lose the response after server commit, reload, and recover the exact result without duplicate mutation.
2. Make an unrelated authoritative update from another client/source, then safely undo the original independent command.
3. Create a true same-object contradiction and receive a concrete conflict/DecisionRequest rather than whole-workspace local/cloud choice.
4. Sign out from account A and sign in as account B without displaying or replaying A data/drafts/pending commands.

## Visual / responsive evidence

Final visual redesign is not required. New pending/saved/unknown/conflict/undo states exposed in the current UI must be understandable at desktop and phone-class widths and keyboard reachable. Temporary surfaces must not create a new styling framework.

## Production evidence

- exact-SHA CI and browser/integration gates;
- bounded production canary for covered non-destructive/compensatable internal commands;
- authoritative receipt and safe replay evidence;
- no external recruiting action;
- release publication remains disarmed unless separately authorized.

## Failure / degraded scenarios

Offline before submit, timeout before commit, timeout after commit, stale client revision, independent concurrent update, dependent concurrent update, authorization/session expiry, server 5xx, pending queue restart, and account switch.

## Rollback

Use per-command kill switches or route covered operations to safe read-only/manual recovery. A rollback may temporarily re-enable a legacy mutation only if it cannot overwrite newer authoritative data and is explicitly documented; stale snapshot restoration is forbidden.

## Exact exit criteria

- required command families execute authoritatively on server;
- receipts support safe unknown-outcome recovery;
- account-scoped cache/pending behavior is verified;
- independent concurrent changes do not become whole-workspace conflicts;
- Undo works across unrelated later revisions and fails safely across true dependencies;
- CGR-02 required mutation journey has no whole-snapshot daily write dependency;
- remaining snapshot uses are enumerated and bounded;
- all required tests/journeys/failure evidence pass at exact integrated main;
- STATUS.md marks CGR-01 COMPLETE and CGR-02 READY, without starting CGR-02.

## Closure

Functional integration: `main@0b295f15d2eb74b2cc240bad47a02137cb5749ac`.

Canonical evidence: `../receipts/CGR-01.md`.

All exact exit criteria are satisfied. CGR-02 is READY — NOT_STARTED and was not started by this phase.

## Owner decision points


Only if implementation would require a new paid service, new data processor/privacy boundary, irreversible production migration, permission expansion, or material product-value change. Database/library/component choices do not require owner approval.

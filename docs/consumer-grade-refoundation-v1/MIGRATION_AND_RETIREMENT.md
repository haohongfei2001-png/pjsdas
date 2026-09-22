# Migration and Retirement

## Migration order

1. additive authoritative command contracts;
2. account-scoped client cache/pending infrastructure;
3. safe shadow/compare where useful;
4. one complete production vertical slice;
5. remaining daily surfaces;
6. source interpretation/automation closure;
7. certification and legacy retirement.

Never create active-active normal business authorities.

## Snapshot mutation

CGR-01 inventories every caller, classifies normal daily mutation vs import/recovery compatibility,
introduces command equivalents and migrates callers. Whole-snapshot replacement may survive only as
an explicitly named bounded compatibility path.

## IndexedDB

Bind cache/drafts/pending commands to authenticated account identity. Prevent old-account data from
rendering/uploading in a new session. Migrate/clean unscoped legacy data explicitly.

## UI / routing / CSS

CGR-02 establishes final-direction shell + Today in production architecture. CGR-03 migrates the
rest. Temporary adapters require named consumers and retirement conditions.

One new token/primitives owner; isolate legacy CSS; no new global “final polish” layer. Delete only
after zero-consumer proof and visual regression.

## Retirement gate

Remove a legacy path only when production consumers are migrated/terminated, data/identity
compatibility is proven, history/provenance remains readable, replacement has real journey evidence,
rollback does not restore stale snapshot truth, and exact-SHA production evidence exists when
applicable.

## Rollback

Prefer disabling one new path/source autonomy class, forward fix, compensating command or last
compatible client artifact. Never restore an old workspace snapshot over newer authoritative facts.

No bulk real-workspace rewrite is authorized by registration. Native iPhone/UU-08 remains deferred
until CGR-05 + new owner decision.

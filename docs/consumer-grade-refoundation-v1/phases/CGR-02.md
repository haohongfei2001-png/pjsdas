# CGR-02 — Today Vertical Slice

State: READY — NOT_STARTED

## User-visible outcome

The highest-frequency PJSDAS experience becomes a coherent production-grade journey:

Today -> Tell PJSDAS -> explicit understanding -> authoritative save -> updated Today -> visible on another client/session -> safe Undo.

The new Today is the first final-quality slice, not a visual layer over the old application.

## Scope

- implement the final App shell foundation used by later CGR phases;
- implement final Today composition;
- implement final Tell PJSDAS interaction and contextual feedback;
- use CGR-01 authoritative commands/receipts/cache boundaries;
- implement production read-model projection/freshness behavior;
- implement cross-client visibility for the journey;
- establish final design tokens and accessible primitives needed by the slice;
- implement loading, cached-refresh, pending, unknown-save, offline, conflict, and error states;
- freeze reviewed visual baselines for the slice.

## Non-goals

- no complete Opportunities redesign beyond what the journey needs;
- no broad Gmail/PAIA interpretation expansion owned by CGR-04;
- no separate full prototype;
- no new AppV9-style wrapper over active old shells;
- no catch-all anotherPolish.css/global override layer;
- no unrelated feature addition.

## Preserved invariants

All CGR-01 command/domain/security invariants plus deterministic Today ranking and ScheduleNode semantics.

## Architecture changes

- route/session/app-shell responsibility becomes explicit;
- Today reads a stable server-derived/shared read model;
- capture invokes the shared business command/intake boundary;
- UI state no longer duplicates whole workspace collections as independent sources of truth;
- final design primitives become the only allowed basis for newly migrated surfaces.

## Migration

Migrate the Today/capture vertical slice directly to production architecture. Use compatibility adapters only where an unmigrated adjacent route requires them.

Do not duplicate business logic in the new shell.

## Legacy retirement

Before exit:

- old Today daily entrypoint is removed or redirected;
- old capture path for the migrated journey is retired;
- migrated Today no longer depends on obsolete global CSS layers;
- old Today-specific state/event plumbing with no remaining consumer is deleted;
- remaining old-shell dependencies are enumerated for CGR-03.

## Required tests

- Today read-model correctness across realistic states;
- command/receipt integration;
- source context carried into capture;
- mixed input result rendering;
- pending/unknown/save/undo states;
- cross-client refresh/propagation;
- route/back/focus behavior;
- keyboard navigation;
- visual screenshot regression;
- responsive/large-text behavior;
- no false empty flash;
- no stale optimistic state after failed save.

## Continuous real-user journeys

Mandatory golden journey:

1. open Today with realistic existing data;
2. open Tell PJSDAS from Today or relevant context;
3. submit a natural statement that produces a known internal fact;
4. see what PJSDAS understood before/while authoritative save resolves;
5. receive authoritative saved receipt;
6. see Today reflect the result without disorienting reload;
7. observe the same result in a second client/session within the measured target;
8. Undo after an unrelated update has occurred;
9. see both the undo and unrelated update preserved.

Also validate no-action quiet Today, upcoming fixed interview, date-only deadline, real DecisionRequest, and elapsed-unresolved schedule states.

## Visual / responsive evidence

Reviewed baselines are required for normal desktop Today, dense desktop Today, narrow phone-class layout, large-text layout, loading/cached-refresh, pending save, offline, error/unknown result, DecisionRequest present, and no-current-action state.

Evidence must show hierarchy and unobstructed operation, not only screenshot equality.

## Production evidence

- exact integrated main SHA;
- production build/CI/browser/security gates;
- bounded end-to-end canary through the real authoritative command path;
- measured cross-client visibility;
- production receipt/undo evidence without exposing private content;
- publication remains separate.

## Failure / degraded scenarios

Source/read refresh failure while cached Today exists, command timeout after commit, offline capture draft, stale client data, conflict on affected object, DecisionRequest instead of guessed write, session expiry, focus/keyboard recovery after dialog close, long text, and dense schedule.

## Rollback

The new Today route may be disabled while preserving authoritative state and receipts. Rollback must not reactivate stale snapshot overwrite. If necessary, expose a safe read-only fallback while a forward fix is made.

## Exact exit criteria

- mandatory golden journey passes end-to-end on production architecture;
- Today meets target composition and reviewed visual baselines;
- command/save state is truthful;
- cross-client visibility is measured and meets the frozen phase target;
- safe Undo works in the journey;
- migrated Today/capture legacy paths are retired;
- no new global styling layer or parallel app shell was introduced;
- required accessibility/responsive/failure evidence passes;
- STATUS.md marks CGR-02 COMPLETE and CGR-03 READY, without starting CGR-03.

## Owner decision points

A single holistic direction check may be requested only if two materially different final Today interaction/visual directions remain objectively comparable. The owner is not asked to choose pixels, component libraries, spacing tokens, or ordinary interaction details.

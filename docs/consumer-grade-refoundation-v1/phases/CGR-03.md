# CGR-03 — Opportunity Workspace

State: NOT_READY

## User-visible outcome

Opportunities, opportunity detail, decisions, preparation context, and settings become one coherent daily work surface using the same final shell, command semantics, feedback states, and visual system established by CGR-02.

The user can understand where an opportunity stands, what matters next, what to do, and why without navigating engineering-oriented modules.

## Scope

- final Opportunities list/search/filter behavior;
- final Opportunity detail hierarchy;
- complete/recent history truthfulness and navigation;
- next action and schedule context;
- DecisionRequest presentation/resolution;
- Prep/material context integrated into opportunity work;
- final Settings organization around user control;
- connection/capability state translated into user impact;
- route, selection, back, and scroll continuity;
- continued migration of daily Web mutations to CGR-01 command boundaries.

## Non-goals

- no new job-search product domain;
- no new external application/withdrawal/email authority;
- no broad natural-language/source expansion owned by CGR-04;
- no iPhone client;
- no independent design system per page.

## Preserved invariants

Domain identity, process semantics, ranking rules, ScheduleNode semantics, DecisionRequest, provenance, authoritative commands/receipts, source authorization, and security boundaries.

## Architecture changes

- opportunity list/detail consume stable read models;
- prep is contextually projected rather than exposed as an implementation subsystem;
- settings consume source capability/health views rather than raw infrastructure state;
- navigation uses the final route/shell architecture;
- remaining daily Web writes move to typed server commands.

## Migration

Migrate by complete route/journey. Preserve deep links and identity. Compatibility redirects are allowed temporarily.

Every migrated route records old components/styles/write paths it no longer requires.

## Legacy retirement

Before exit:

- old Opportunities and detail daily surfaces are removed/redirected;
- old DecisionRequest presentation paths with no consumer are deleted;
- obsolete Prep navigation whose only purpose was internal module exposure is retired;
- settings remove stale authority/topology wording;
- migrated CSS layers/selectors with no remaining consumer are deleted;
- daily connected Web snapshot writes are eliminated unless explicitly documented as bounded non-daily compatibility.

## Required tests

- list/detail read-model correctness;
- search/filter/selection/back continuity;
- dense hundreds-opportunity rendering;
- long names and mixed-language content;
- full history access and recent-history labeling;
- decision resolution command path;
- prep/material links and route context;
- settings source-impact states;
- keyboard/focus;
- responsive/large-text;
- visual regression;
- ended/stale opportunity states;
- no duplicated rank/business logic in UI.

## Continuous real-user journeys

1. Scan a dense opportunity list, open one, inspect current progress, next commitment, and preparation, then return without losing list context.
2. Resolve an ambiguous same-company/multiple-role DecisionRequest from opportunity context and see the correct result.
3. Reschedule or complete an occurrence from detail and see Today/list/detail remain consistent.
4. Inspect complete history beyond the first recent entries.
5. Restore a broken source connection from Settings and understand what data may be stale.
6. Navigate the same workflows at narrow width without losing access to core actions.

## Visual / responsive evidence

Reviewed baselines for dense/sparse list, normal/long-content detail, active/ended/stale states, DecisionRequest, prep/material context, settings healthy/degraded source states, desktop/phone-class widths, large text, and loading/pending/error/offline states.

## Production evidence

- exact integrated main SHA and required CI/browser/security checks;
- bounded production canaries for list/detail/decision/mutation journeys;
- no private data in public visual/evidence artifacts;
- production route/deep-link verification;
- legacy daily routes confirmed unused/redirected before deletion.

## Failure / degraded scenarios

Partial read failure, stale cached detail, deep link to deleted/merged object, source authorization loss, command conflict, long history, no next action, ended opportunity with stale action, dense workspace, and client refresh during a pending action.

## Rollback

Feature-route kill switch/redirect to a safe compatible read surface is allowed. Authoritative command/data state remains intact. No rollback may restore stale snapshots or resurrect a removed write authority.

## Exact exit criteria

- Opportunities/detail/decisions/prep/settings meet TARGET_EXPERIENCE.md;
- daily Web operations in those surfaces use authoritative command paths;
- list/detail/Today remain semantically consistent across journeys;
- legacy UI/styles/write paths for migrated surfaces are retired;
- dense/responsive/accessibility/failure evidence passes;
- settings communicates real user impact rather than raw infrastructure;
- STATUS.md marks CGR-03 COMPLETE and CGR-04 READY, without starting CGR-04.

## Owner decision points

Only product-value, permission/cost/privacy, destructive identity/data changes, or materially different interaction directions without objective superiority. Ordinary information hierarchy and visual craft decisions are delegated.

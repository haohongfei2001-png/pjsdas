# v1.8 Round 4 — Usability Validation & Friction Removal

## Scope

This round is a code-path usability audit, not an empirical user study. It targets only high-confidence friction visible in current interaction/state behavior.

## Validation questions

1. Can a user recover immediately from an accidental action completion?
2. Does an empty workspace explain how to begin instead of only saying there is nothing to do?
3. Does Decide open in the context most likely to contain actionable information instead of always forcing the same tab?
4. Do these changes preserve the v1.8 five-surface IA and all existing decision/state semantics?

## Changes

### Reversible completion

Completing an Action still uses the existing Action-status ChangeSet path. The UI remembers the Action's previous status for a short transient window and exposes Undo. Undo creates another ordinary Action-status ChangeSet back to that prior status; it does not mutate IndexedDB directly and does not delete audit history.

### Empty-workspace start state

When Opportunities, Actions, Processes, and Prep are all empty, Today shows an explicit start card rather than a generic empty result. The card routes to Discover & Review or Settings / import. No onboarding completion flag is persisted.

### Context-aware Decide entry

Before the user explicitly chooses a Decide tab in the current session, PJSDAS derives the most useful initial context from existing state:

1. review when there are unpromoted Discovery Inbox items;
2. pipeline when there are active recruiting processes and no review queue;
3. opportunities when the active pool exists and the first two do not apply;
4. review for a new/empty workspace.

Once the user clicks a Decide tab, PJSDAS stops auto-switching it for the rest of that mounted session.

## Architecture boundary

- no schema changes
- Snapshot remains v1
- no ranking/scoring changes
- no Portfolio, Prep Graph, Discovery-quality, ChangeSet, or MCP semantic changes
- no telemetry or fake user-testing claims
- no persistent onboarding state
- no hidden mutation path

# v1.8 Round 2 — Interaction & Detail Experience

## Goal

v1.8 Round 1 reduced PJSDAS to five user-goal surfaces. Round 2 makes those surfaces behave like one coherent product instead of five isolated pages.

The core interaction principle is:

> **The same Opportunity should remain the same object wherever the user encounters it.**

Today, Decide / Opportunities, and Pipeline may show different slices of that object, but opening it should lead to one shared detail view rather than three incompatible summaries.

## Opportunity Detail as the object layer

`OpportunityDetailDrawer` is a read-only object view composed from existing state:

- Opportunity identity and role type;
- stored Fit and Opportunity Value;
- current recruiting stage;
- deadline / application group;
- Rich Opportunity source-backed facts;
- component assessment;
- current Job Posting and freshness;
- effective Process state;
- source / application links when available.

The detail layer does **not** create a new scoring model or persistence representation.

Recruiting facts, assessment judgments, source freshness, and process lifecycle remain separate concepts.

## Read-only boundary

Opportunity Detail does not mutate PJSDAS business state.

It may:

- close itself;
- open a public source or application URL;
- navigate to Today;
- navigate to Decide / Opportunities;
- navigate to Decide / Pipeline;
- navigate to Prepare.

It may not:

- change Fit / Opportunity Value;
- promote / dismiss discovery candidates;
- close an Opportunity;
- update a posting;
- apply an Action;
- change Process state;
- mutate Decision Rules.

All business-state writes continue through the existing explicit product / ChangeSet paths.

## Cross-surface navigation

Primary surface state and Decide sub-navigation are owned by `AppV8`.

This lets an object-level interaction deterministically move the user to the correct context instead of requiring them to close a drawer and rediscover the relevant navigation path.

Examples:

- Today Action → Opportunity Detail → Pipeline;
- Opportunity Pool row → Opportunity Detail → Prepare;
- Pipeline card → Opportunity Detail → Opportunity Pool.

Round 2 does not introduce URL routing or a new router dependency. The current local application shell remains state-driven.

## Progressive disclosure

The default interaction should answer the immediate decision first.

Detailed recruiting facts and component assessments continue to use their existing collapsible summaries. The detail drawer composes these existing layers rather than expanding every field at once.

Specialist tools remain contextual under the five v1.8 primary surfaces.

## Narrow-screen / mobile behavior

At narrow widths:

- the primary surface navigation becomes a fixed bottom navigation;
- desktop Opportunity tables are replaced by tap-friendly Opportunity cards;
- Opportunity Detail becomes a full-width sheet;
- action rows and contextual controls stack instead of relying on horizontal scroll;
- desktop data density is reduced, not merely squeezed.

The goal is functional parity, not a separate mobile data model.

## Empty-state principle

An empty state should tell the user what is missing and where the next valid action belongs. It should not expose implementation vocabulary or suggest creating synthetic data.

Examples:

- no Today actions → capture a real change or wait for the next known node;
- no pipeline → record a real recruiting notification when one exists;
- no Prep → Prep appears after explicit/imported preparation assets exist.

## Architecture invariants

Round 2 does not change:

- IndexedDB schema;
- Snapshot v1;
- Drive sync semantics;
- workspace fingerprinting;
- ChangeSet semantics;
- MCP proposal semantics;
- Today ranking;
- component assessment aggregation;
- Application Portfolio;
- Prep Graph;
- Continuous Discovery / posting refresh.

## Acceptance criteria

1. Today, Opportunity Pool, and Pipeline open the same Opportunity Detail component.
2. Opportunity Detail is read-only with respect to PJSDAS business state.
3. Rich facts and component assessment reuse existing components and semantics.
4. Posting freshness is derived from existing posting evidence.
5. App-level navigation owns cross-surface transitions.
6. Detail can jump to Today, Opportunity Pool, Pipeline, and Prepare.
7. Opportunity Pool has a narrow-screen card representation.
8. Primary surfaces have narrow-screen bottom navigation.
9. Five v1.8 primary surfaces remain unchanged.
10. No persistent schema or mutation-protocol changes are introduced.

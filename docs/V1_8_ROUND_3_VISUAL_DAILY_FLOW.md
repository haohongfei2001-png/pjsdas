# v1.8 Round 3 — Visual Hierarchy & Daily Flow Polish

## Goal

Round 3 improves the day-to-day reading and action rhythm of the v1.8 five-surface product without adding another decision engine or changing durable state semantics.

The product should visually answer, in order:

1. What should I do now?
2. What else matters today?
3. What is approaching?
4. What changed and needs recording?

The UI should not give equal visual weight to execution, diagnostics, configuration, and maintenance tools.

## Daily-flow contract

On **Today**, visual order is deliberately:

1. surface header;
2. `START HERE` primary action;
3. time-boxed plan and upcoming nodes;
4. capacity / hard-constraint warning when needed;
5. quick-capture maintenance tools.

This changes presentation order only. It does not change `rankActions`, `buildTimePlan`, stored Actions, or ChangeSet behavior.

The primary action receives the strongest contrast and largest typographic emphasis. Quick capture remains available in the same surface but is visually secondary so the user does not begin each session by maintaining the system instead of acting.

## Decide hierarchy

`Discover & review`, `Opportunities`, and `Pipeline` remain one Decide journey. Their context tabs are treated as a sticky local navigation layer, while specialist tools such as Discovery Radar and Application Portfolio remain contextual helpers rather than top-level visual anchors.

Opportunity tables and pipeline cards use quieter backgrounds and interaction affordances so Fit / Value / timing data can be scanned without turning the surface into a dense control panel.

## Opportunity Detail hierarchy

The Round 2 object layer remains read-only. Round 3 changes only visual hierarchy:

- identity and current stage first;
- Fit / Value / stage / deadline as a compact snapshot;
- `NEXT DECISION` receives higher emphasis than evidence sections;
- source-backed facts, assessment components, posting history, and timeline remain progressively disclosed;
- sticky footer actions remain available without competing with the primary decision block.

No new detail-only score or inferred fact is introduced.

## Empty and first-use states

Empty states use a quieter dashed container and a clear directional affordance rather than looking like broken or missing content. Existing product copy continues to direct a new user toward discovery, import, or progress capture based on context.

Round 3 does not add a second onboarding state machine or persistent onboarding flags.

## Mobile contract

The existing bottom five-surface navigation is retained. Round 3 improves touch and reading ergonomics:

- primary navigation targets are at least 48 px high;
- principal action buttons are at least 44 px high;
- contextual tabs remain scrollable/sticky where needed;
- Opportunity cards remain the mobile alternative to desktop tables;
- the Opportunity Detail drawer remains full-width on narrow screens.

## Accessibility

- visible `:focus-visible` treatment for keyboard navigation;
- no removal of semantic buttons/links;
- `prefers-reduced-motion: reduce` disables decorative transitions/animations;
- visual emphasis must not encode business state that is absent from the underlying model.

## Architecture boundary

Round 3 changes presentation only.

It does **not** change:

- IndexedDB schema;
- snapshot schema (still v1);
- Opportunity / Process / Action / Prep models;
- Today scoring or time-plan algorithms;
- component assessment;
- Application Portfolio;
- Prep Graph;
- Continuous Discovery / posting refresh;
- ChangeSet semantics;
- MCP tools or mutation boundaries.

## Acceptance criteria

1. The v1.8 five-surface IA is unchanged.
2. Today visually prioritizes `START HERE` before plan maintenance tools.
3. Quick capture is still available but visually secondary.
4. Decide local navigation remains the dominant context switch within Decide.
5. Opportunity Detail emphasizes next decision before evidence detail.
6. Empty states read as intentional product states, not failures.
7. Keyboard focus remains visible.
8. Reduced-motion preference is respected.
9. Mobile primary navigation and principal actions meet practical touch-target sizing.
10. No business-state mutation or scoring logic is added by this round.

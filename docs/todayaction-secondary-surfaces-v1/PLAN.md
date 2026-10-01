# Secondary surface adaptation

## Contract

Owner request, 2026-10-01: adapt Settings, Tell TodayAction and detail pages to
the established main interface. Do not redesign the main interface.

Frozen visual reference: deployed main
`37e8487a7f2b5f99d82527895deff20202b70eeb`. User-supplied Settings, capture and
job-detail screenshots were inspected before implementation; private screenshot
contents are not copied into the repository.

## Scope

- Settings and its seven existing disclosure groups, including account/source
  states, preferences, planning, recovery and language controls
- Tell TodayAction dialog, contextual entry and all existing feedback states
- Job details and unavailable job state; decision details and unavailable choice
  state; Schedule's event-detail aside only
- Reachable backup, process-recovery, preparation graph, discovery preview and
  proposal-review overlays

OAuth consent remains a separate authorization surface. Dormant legacy docks
have no new scope. Today, Jobs and Schedule list/navigation composition remains
unchanged. Business operations, wording of authorization/recovery disclosures,
data, command identity, account boundaries and performance budgets are preserved.

## Design

Use the existing TSUI blue/gray palette, white panels, 15px panel / 9px control
corners, 44px controls, consistent headings and spacing. Flatten nested Settings
panels into section rows. Make capture a focused companion with a clear blue
save action. Align detail summary cards and readable disclosure sections.
All overrides live in a secondary-root-only stylesheet, imported after legacy
global styles; no global shell or main-list selector is changed.

## Evidence required

- Local full unit/type/build, selector confinement and independent review
- Exact-reference before/after synthetic screenshots at desktop and phone widths;
  320px / 200% text checks for secondary content
- Exact pixel equality for Today, Jobs and Schedule, including returning from
  lazy-loaded Settings and capture, against the frozen deployed reference
- Existing complete UI/brand/accessibility/Browser/Matrix and strict performance
  gates before integration; inspect actual before/after pixels, not only metrics
- Retain phase-specific screenshot/report paths so later steps cannot erase
  earlier evidence; no relaxed retries, thresholds or skipped assertions

All new test workspaces are synthetic. No private workspace or production
business write is required for design validation.

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


## Owner follow-up: Settings hierarchy and repeated application identity

The owner rejected the Settings result after PR210 was deployed. This follow-up
is based on main `b602e634b76adf2cf82a36c95aa27d4b968202f0`. Reference screenshots
were inspected privately; no real screenshot contents enter fixtures or source.

- Separate account/cross-device state, background workspace connection, public
  job discovery, and recruiting-mail tracking into independently labelled cards.
- Place each source's state, last successful run, action, and warning together.
  Disabling and reconnecting are secondary controls, rather than blue primary
  actions. A enabled switch is not proof of successful execution.
- Keep account mismatch, failed source checks and intake gaps visible. Collapse
  long operational explanations and diagnostics explicitly. Show the full
  necessary permission scope before enable/re-authorize controls can be used.
- Remove only the complete repeated company/role context above an application
  title in Today. Keep other context, right-hand job access and the main layout.
- Cover desktop, phone and 320px/200% text; enabled, partial, disabled and error
  states, scoped action errors, original consent journeys and duplicate titles.

Implementation, local checks, exact-head CI, integration and production readback
are distinct gates. Screenshots and local tests alone do not constitute owner
acceptance. The inherited main Matrix run36901485731 failed its strict long-task
assertion (87ms and59ms); do not erase this evidence or relax its50ms threshold.

# ZMC-07 — Schedule and History consumer model

## Product contract

The default Schedule view and Today show current or future commitments. The Past view contains both recorded history and elapsed occurrences whose outcome remains unknown. Historical unknowns do not create a global task count or recurring Today maintenance prompt. An unresolved outcome surfaces in an opportunity only while it can still affect that opportunity's current process stage; a later real commitment or process progression takes precedence. All source records and occurrence versions remain intact.

## Red-before evidence and regression

- A persisted 300-node workspace opened Schedule on `全部 300`, with a prominent historical unresolved count, while Past excluded those unresolved rows. The headless browser regression failed before the view change and now verifies default Upcoming, quiet context, historical unknowns in Past, and all 300 nodes retained after reload.
- An old unresolved interview sorted ahead of a real future interview in the opportunity read model. The focused unit test failed before the selection change and now verifies future-first selection, no stale outcome risk after later process progress, no interview outcome prompt after offer stage, and retention of a still-relevant interview outcome.
- An expired application deadline already closes the application window; it no longer appears as a separate unresolved occurrence in opportunity detail. The existing date-only deadline regression still verifies the exact local-calendar expiry boundary and the closed-window conclusion.

Local candidate: 208 unit files and 1,096 tests passed; typecheck/build passed; 29 targeted Chromium browser tests passed. Full exact-head gates, independent review, merge, and exact-main production readback are pending. No production business records were changed.

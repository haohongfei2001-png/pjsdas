# ZMC-07 — Schedule and History consumer model

## Product contract

The default Schedule view and Today show current or future commitments. The Past view contains both recorded history and elapsed occurrences whose outcome remains unknown. Historical unknowns do not create a global task count or recurring Today maintenance prompt. An unresolved outcome surfaces in an opportunity only while it can still affect that opportunity's current process stage; a later real commitment or process progression takes precedence. All source records and occurrence versions remain intact.

## Red-before evidence and regression

- A persisted 300-node workspace opened Schedule on `全部 300`, with a prominent historical unresolved count, while Past excluded those unresolved rows. The headless browser regression failed before the view change and now verifies default Upcoming, quiet context, historical unknowns in Past, and all 300 nodes retained after reload.
- An old unresolved interview sorted ahead of a real future interview in the opportunity read model. The focused unit test failed before the selection change and now verifies future-first selection, no stale outcome risk after later process progress, no interview outcome prompt after offer stage, and retention of a still-relevant interview outcome.
- An expired application deadline already closes the application window; it no longer appears as a separate unresolved occurrence in opportunity detail. The existing date-only deadline regression still verifies the exact local-calendar expiry boundary and the closed-window conclusion.
- Independent review found that an undated node could hide a still-relevant unresolved outcome. The selection now places dated current/future commitments first, relevant unresolved outcomes second, and undated nodes last. A focused regression covers that order.
- A second review found date-only unknown outcomes still surfacing after a process update recorded on that same day. Same-day or later process progress now takes precedence because the date-only occurrence cannot establish a later unanswered business fact.
- A third review found that selecting All discarded its URL state; reload silently returned to Upcoming. All now has an explicit `?view=all` URL while a parameterless Schedule URL remains the quiet Upcoming default. The dense browser test verifies reload persistence.

PR #203 final exact head `9bafa637f70ceabd83bf6a82ff979c9ab8199661` passed 208 unit files / 1,096 tests, typecheck/build, full CI, Browser, Firefox/WebKit Matrix, UI, brand, VoiceOver, read-only rollback, Vercel, and independent review with no remaining actionable finding. It merged as main `612bdf5d04fe46079748fe8479202c72863bfd4f`, tree `75e92490de96f43fd9efb8e532cf0195f9adefaf`. Merged-main CI, Browser, Matrix, VoiceOver, deployment, production self-test, and certifications succeeded. Production release manifest and API health returned that exact main SHA. No production business records were changed.

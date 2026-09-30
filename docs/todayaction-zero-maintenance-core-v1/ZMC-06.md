# ZMC-06 — Decision and parser debt

## Product contract

A DecisionRequest is visible only when an active assertion or current intent identifies a current business object, provides two to four distinct understandable choices, and lets the owner change a bounded business state. Old Gmail parsing uncertainty remains in data-quality history. Existing request rows and source evidence are retained.

Gmail reprocessing must not create another open choice when the same source, candidate, reason, and outcomes are merely serialized in a different object-key order or parsed under a later source version. A genuine change to the plausible business choices still supersedes the old request and retains both records.

## Red-before evidence and regression

- A same-source Gmail role choice reprocessed with reversed candidate object insertion order created two persisted DecisionRequests. The focused test failed at `expected 1, got 2`. Canonical business comparison now preserves the original open request and also recognizes an already answered candidate under that reordering.
- A synthetic old Gmail request whose bound statement mode changed to `quote` still appeared actionable despite being source text, not a current fact. A request with one blank choice label or duplicate choice ID also passed the visible-decision gate. Focused tests failed before the read-model guards were added.
- The owner production aggregate recorded 363 open Gmail rows (173 missing fields, 117 target ambiguities, 69 low confidence, four occurrence ambiguities), with no company/role anchor in the 117 target candidates. This is a historical read-only observation, not a mutation target. The dense browser regression stores that exact reason distribution alongside one genuine current Web decision, verifies only that decision appears in Today and the inbox, and confirms all 364 records remain after restart.
- A parser-version sequence for a source with no identifiable company retains source ledger evidence and creates zero user DecisionRequests or process events.

Full phase gates, independent review, merge, and exact-main production readback are pending. No production business records are changed.

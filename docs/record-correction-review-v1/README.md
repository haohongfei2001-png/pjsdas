# Existing-record correction review

The normal authenticated Tell TodayAction dialog contains a **Review existing
records / 核实已有记录** mode. This is a narrow, single-record source-review entry,
not a generic command console or a workspace import.

## Private review packet

Use `todayaction-correction-review-v1` with required `accountId`, `reviewedAt`,
`workspaceVersion` (`txn:N`), `excluded`, `held`, and `entries` fields.
Each exclusion/hold is `{ opportunityId, reason }`. Each entry contains exact
`company`, `role`, `reviewStatus` (`ready` or `needs_review`), and `command`.
Only `correct_application_deadline` and `invalidate_process_event` are accepted.
Their fields match the existing bounded domain command schemas. Unknown deadlines
omit both date and precision. Unknown availability is not an assertion of open
recruiting. Evidence authority and check time must describe actually reviewed
source evidence; no source-read failure is promoted into official verification.

The parser rejects extra fields, malformed rows, duplicate command/target IDs,
excluded/held targets in proposals, oversized files and invalid calendar dates.
One invalid row rejects the entire packet. `needs_review` entries cannot submit.
Exclusions are caller-supplied evidence protection, in addition to canonical
submitted/ambiguous protection enforced again by the server reducer. Canonical
eligibility alone does not resolve external application/identity evidence.

The full file is held only in component memory and clears on close or account
transition. It is never uploaded, saved as a draft, or included in repository
fixtures. Submitted individual commands use the existing account-scoped durable
outbox/receipt mechanism. Do not commit personal review packets or production
source excerpts to this repository.

## Execution and failure boundaries

Both Review and Apply read the current authenticated authoritative workspace with
an account-cache lease. Exact company/role identity and original reviewed owner
tokens must still match. The UI dry-runs the same reducer for protection feedback;
it never changes the reviewed fingerprint to force a later write.

Apply sends one unchanged domain command through `executeConnectedBusinessCommand`
and the existing `/api/workspace` endpoint. The existing server CAS, payload hash,
command ledger and replay protection remain authoritative. There is no optimistic
or local-mode mutation. A checkbox confirms the displayed single record. Double
clicks share one in-flight guard. Unknown delivery is checked through the original
receipt; no new command ID is generated. A pre-existing receipt is described as a
receipt for that ID, not proof that a newly imported different payload ran.

Corrections preserve original audit evidence and have no ordinary Undo. The UI
never offers one. A known server commit remains acknowledged if local projection
or refresh subsequently fails. Stale/conflicting source evidence requires fresh
research/review, not automatic token or source replacement. Account transitions
and component unmount invalidate late UI results; the existing account lease
also protects network/projection work.

## Verification

Synthetic unit tests cover whole-packet refusal, external exclusions, exact
identity/account checks, review-required proposals, unknown date semantics,
calendar validity and stale/application-protected owners. Existing authoritative
executor tests prove one CAS commit, payload-reuse refusal, receipt recovery,
no unsupported Undo, and direct endpoint protection. Permanent browser journeys
cover single-record review/apply/history, double click, accepted response loss,
stale owners, exclusion/partial packets, close/read interruption, account lease
change, signed-out refusal and the hidden natural-language keyboard shortcut.
Full exact-head Browser, Matrix, CI, UI and Brand gates remain mandatory.

Local candidate verification: 222 unit files / 1,283 tests, TypeScript and
production build passed. Local browser execution remains unavailable because the
executor denies browser socket launch; remote full Browser/Matrix journeys and
pixels are required before merge. Only synthetic records are used in tests.

## First remote review and source-time hardening

The first candidate passed all nine new Chromium review journeys. The old capture
keyboard test needed one additional Shift+Tab stop for the new accessible review
button; its original focus-wrap/save/restoration checks remain intact. Desktop
review pixels were inspected; the stale-owner journey also covers a 390px mobile
viewport in the next candidate.

Independent review caught Date.parse rollover in precise timestamps. Shared
source-calendar validation now rejects impossible dates/clocks and offsetless
precise timestamps in the reducer and review parser, including checkedAt and
review audit timestamps. Legitimate date-only deadlines and explicit offsets/
milliseconds remain supported. Independent recheck rejected the original probe
and passed 78 focused tests. Full local follow-up passed 223 files / 1,304 tests,
TypeScript and production build. Full remote gates remain required for the final
candidate; no private packet or production correction has been applied.

## Binding the private file after sign-in

The review panel's collapsed Account binding details show the signed-in email
and exact stable identifier used by its `accountId` comparison. This is the
existing application's `CloudUser.id` (Google subject/local account lease key),
not the distinct Supabase account UUID or a workspace revision. Copy this visible
value into a privately prepared packet only after normal sign-in; do not infer it
from email or inspect credentials. The display contains no access/refresh token
and does not change authorization or automatically bind an imported file.

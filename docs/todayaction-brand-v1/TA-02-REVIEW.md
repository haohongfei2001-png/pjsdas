# TA-02 interface refinement

Status: IMPLEMENTED / VERIFICATION_PENDING. No PASS is inferred from code.

## Baseline findings and corrective scope

Exact before source: TA-01 main `6f4fe9a6528adf40c506cea84695b44b679aa24e`.
Its deployed Live Visual shows the 320px / 200% header's capture label squeezed, low-contrast auxiliary text, and the source retains old beige self-owned authorization styling.

Corrections:
- Header action text can wrap at large text, preserving the full TodayAction label and 44px control targets. Main navigation stays the second mobile row.
- Secondary text uses a darker existing blue-gray; visible focus uses a solid blue outline. Loading, verified account emptiness and unavailable/cache emptiness have distinct truthful copy.
- Long job identity and action/status occupy layout columns instead of absolute positioning; complete detail remains accessible.
- Existing capture and settings controls wrap, keep named focus and preserve receipt/Undo semantics.
- Self-owned consent presentation adopts the established white/blue system. Authentication code, scopes, decisions and redirect behavior are unchanged.

No first task enlargement, new product navigation, list filtering/ranking, business write, storage/schema identity, release version or approved-logo change.

## Verification design

Cloud builds before and after using the same shared synthetic CGR workspace fixtures and the existing demo snapshot. The shared factory/cors helpers were moved without business changes from the existing CGR browser journey; its command/receipt server and assertions remain intact.

Widths 360/390/430/768/1280/1440, text scale 100%/200%, screenshots and measured overflow/label clipping/selected text contrast for:
Today populated, first use, signed-in empty, loading, failed read, verified cache; library/detail; schedule/event; capture/settings; self-owned authorization.
Before issues are retained as observations, never reported as PASS. Candidate assertions enforce no measured overflow/clipping and selected real DOM text pairs >=4.5. This is targeted contrast evidence, not whole-application WCAG certification.
Candidate also checks identical displayed task IDs before/after matrix navigation, no requested business writes, focus/escape restoration, truthful state distinctions. Existing TSUI journeys verify complete 130-node/300-job/history collections and event command/receipt/Undo behavior.

All cloud evidence and any correction after initial candidate render will be recorded here after verification. Device/private workspace/provider-brand/legal evidence remains DEFERRED. #164 remains PARKED and untouched.

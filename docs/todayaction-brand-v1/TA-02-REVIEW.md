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

Cloud builds before and after using the same shared synthetic CGR workspace fixtures and the existing TSUI standalone date-only node fixture. The shared factory/cors helpers were moved without business changes from the existing CGR browser journey; its command/receipt server and assertions remain intact.

Widths 360/390/430/768/1280/1440, text scale 100%/200%, screenshots and measured overflow/label clipping/selected text contrast for:
Today populated, first use, signed-in empty, loading, failed read, verified cache; library/detail; schedule/event; capture/settings; self-owned authorization.
Before issues are retained as observations, never reported as PASS. Candidate assertions enforce no measured overflow/clipping and selected real DOM text pairs >=4.5. This is targeted contrast evidence, not whole-application WCAG certification.
Candidate also checks identical displayed task IDs before/after matrix navigation, no requested business writes, focus/escape restoration, truthful state distinctions. Existing TSUI journeys verify complete 130-node/300-job/history collections and event command/receipt/Undo behavior.

All cloud evidence and any correction after initial candidate render will be recorded here after verification. Device/private workspace/provider-brand/legal evidence remains DEFERRED. #164 remains PARKED and untouched.

## Inner-loop finding 1

[UI Review 36223829603](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36223829603) built the exact baseline but failed before tests were registered: Node's ESM loader requires a JSON import attribute. The fixture is now read through the same local Node file mechanism used by existing repository tests, without dependency or runtime changes. No UI PASS is claimed from this failed harness invocation. Unit/type and read-only rollback passed on the initial candidate.

## Inner-loop finding 2: bounded fixture diagnosis

[UI Review 36223955966](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36223955966) successfully rendered first-use/empty/loading baseline states and measured the inactive mobile switch at 4.00 contrast. Three loaded-state checks found zero tasks. Repository snapshot validation shows the mixed demo schedule nodes refer to demo processes absent from the CGR workspace; this composed fixture is invalid, so the client correctly rejects it. The mix was replaced with the existing TSUI standalone date-only node fixture alongside the shared CGR workspace. Every composed fixture now passes the production snapshot validator before use. Counts and safety assertions remain enforced; no production snapshot validation was weakened. Corrected baseline/after render remains pending.

## Inner-loop finding 3: scoped settings selector

[UI Review 36224205335](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36224205335) rendered valid loaded Today/library/detail/schedule/event/capture states and all freshness scenarios; the composed fixture passed snapshot validation and displayed both exact action IDs. The loaded gallery stopped at Settings because `.cloud-settings-card` matches both the account and AI-access cards. The assertion now uses the exact account heading, preserving the visible-section requirement. The capture-label measurement now checks both horizontal and vertical overflow. No runtime change was needed for this selector correction; corrected candidate render remains pending.

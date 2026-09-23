# CGR-05 — Connected write authority audit

State: OPEN ENGINEERING AUDIT; no retirement claim yet.

Baseline main: `66fa75d0755fbaad5da6a6e0ee94900305262f08`.

## Finding

Connected Web still has a broad daily whole-snapshot route. `CloudContext.syncNow()` calls `runCloudSync()`. In transactional mode, `runCloudSync()` can choose `push_local`, which calls `updateConnectedRemoteWorkspace()` with `snapshotPurpose: legacy_uncovered_web`. The gateway accepts this declared compatibility purpose with expected revision and fingerprint. CAS rejects a newer server revision, but the path remains a second write shape beside typed commands and can submit unrelated local state together. The 120-second auto-sync/focus/online hooks make this a routine path, not a rare migration tool.

## Current consumers

| Consumer | Observed path | Retirement boundary |
|---|---|---|
| Discovery Inbox status, bulk status, promotion | baseline view existed but was not mounted in the active app shell; saved candidates were invisible for direct review | restore the existing review view as an Opportunities context, move status/bulk to typed first-party commands, then retire promotion whole-snapshot write |
| Discovery Profile save | connected path is being converted from local preference mutation plus `cloud.syncNow()` to a first-party account-bound `discovery_profile` command | exact-head CI/browser, cross-client projection and Undo gate; local-only save remains local |
| MCP proposal apply / save to inbox | local ChangeSet/inbox mutation then `cloud.syncNow()` | preserve explicit review and source authorization while moving business mutations to typed commands |
| Settings manual sync | `cloud.syncNow()` | connected mode should reconcile/read and replay pending typed commands without broad routine writes |
| Auto-sync on timer/focus/online | `cloud.syncNow()` | connected mode should use authoritative refresh and pending receipt recovery without broad routine writes |

Already converted daily paths include Today action status/Undo, Tell PJSDAS and DecisionRequest in transactional mode. They must remain typed during retirement.

## Required gate before deletion

For each current consumer, preserve the same user outcome in both local-only and connected modes; verify account/session isolation, unknown-commit receipt lookup, CAS conflict, cross-client visibility, source/provenance and Undo where the operation supports it. Once no supported daily consumer needs `legacy_uncovered_web`, reject that purpose at the client/server boundary and retain only explicit migration/recovery compatibility with a concrete supported caller. Do not replace a failed sync with a false success receipt or restore an old snapshot over newer server facts.

Production architecture certification remains pending exact deployment under `DEFERRED_FINAL_GATES.md`; this audit is code-level evidence only.

## First bounded safety change

Background timer/focus/online refresh in transactional mode now reads and reconciles without silently choosing `push_local` for a whole-workspace commit. When it finds local changes that still depend on a legacy writer, it reports `local_pending` and preserves the local data and checkpoint. Explicit existing sync after a supported legacy mutation remains available until that consumer is converted. The connected passive/explicit boundary has a focused test; this is a containment step, not retirement of `legacy_uncovered_web`.

## Receipt integrity while retiring legacy writes

Connected compatibility commits now enumerate Discovery Inbox items, Discovery Profile, ChangeSets, timeline entries and import metadata in `affectedObjects`. Previously these fields were omitted from the object diff, so a whole-snapshot write touching only those fields could carry an empty affected-object list. The focused receipt-scope regression verifies that a Discovery Inbox change and Profile change are visible to later object-level overlap checks. The existing first-party command test now expects its timeline entry to appear beside the changed Action. This fixes receipt accounting; it does not authorize broad snapshot writes as a final architecture.

Discovery Inbox/Profile/MCP proposal save paths now require `ensureAuthoritativePersistence` before showing requested cloud persistence. A conflict, pulled replacement, busy sync or unknown result cannot be mislabeled as successful remote save. The remaining `legacy_uncovered_web` call still needs retirement. Adding new first-party typed commands must preserve the separate MCP permission boundary: the shared `applyUserCommandSchema` also defines an MCP callable surface, so migrating a Web-only mutation by broadening that schema without a separate authorization check would be a permission expansion.

## Discovery review reachability correction

A full import-reference check found that `DiscoveryInboxView` was present in source but unmounted from the active `AppV8` shell. The MCP proposal route still offered “Save to Inbox”, and saved items continued to affect AI/read and progress-reference logic. This was a real user-journey defect, not an active status-write path as the initial table had assumed. The existing review view is now mounted as a contextual Opportunities tab, preserving Today/Opportunities as the two primary destinations. Single and bulk status changes in connected mode use account-bound first-party `discovery_status` commands with receipt lookup, object conflict, Undo compensation, and cross-client projection. The delegated MCP tool schema does not gain this command; a principal guard rejects delegated callers. Local-only status semantics remain shared through one pure helper. Promotion and proposal inbox-save still use declared legacy whole-snapshot compatibility and remain OPEN retirement work. The browser journey checks status persistence from another client without a snapshot commit. This is engineering candidate evidence until exact-head CI/Browser passes.

## Discovery Profile candidate retirement

The first-party connected Profile save now submits one bounded `discovery_profile` command before projecting the authoritative snapshot locally. The gateway validates every field and rejects delegated MCP callers; `applyUserCommandSchema` is unchanged. The command targets only `discovery_profile:current`, records a durable receipt, and provides a compensation payload for Undo. The Profile card reloads clean remote projection while preserving unsaved edits. The local-only save remains local. A connected two-client browser journey now checks status and Profile commands without any whole-snapshot commit. This is candidate work until exact-head CI/Browser passes; promotion, MCP proposal and manual-sync compatibility remain OPEN.

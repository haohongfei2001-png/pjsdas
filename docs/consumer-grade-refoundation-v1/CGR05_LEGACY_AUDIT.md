# CGR-05 — Connected write authority audit

State: OPEN ENGINEERING AUDIT; no retirement claim yet.

Baseline main: `66fa75d0755fbaad5da6a6e0ee94900305262f08`.

## Finding

Connected Web still has a broad daily whole-snapshot route. `CloudContext.syncNow()` calls `runCloudSync()`. In transactional mode, `runCloudSync()` can choose `push_local`, which calls `updateConnectedRemoteWorkspace()` with `snapshotPurpose: legacy_uncovered_web`. The gateway accepts this declared compatibility purpose with expected revision and fingerprint. CAS rejects a newer server revision, but the path remains a second write shape beside typed commands and can submit unrelated local state together. The 120-second auto-sync/focus/online hooks make this a routine path, not a rare migration tool.

## Current consumers

| Consumer | Observed path | Retirement boundary |
|---|---|---|
| Discovery Inbox status, bulk status, promotion | baseline view existed but was not mounted in the active app shell; saved candidates were invisible for direct review | review view restored; status/bulk and promotion now use first-party scoped commands on the connected candidate; exact-head browser and Undo evidence still required |
| Discovery Profile save | connected path is being converted from local preference mutation plus `cloud.syncNow()` to a first-party account-bound `discovery_profile` command | exact-head CI/browser, cross-client projection and Undo gate; local-only save remains local |
| MCP proposal apply / save to inbox | local ChangeSet/inbox mutation then `cloud.syncNow()` | preserve explicit review and source authorization while moving business mutations to typed commands |
| Settings manual sync | `cloud.syncNow()` | connected mode should reconcile/read and replay pending typed commands without broad routine writes |
| Auto-sync on timer/focus/online | `cloud.syncNow()` | connected mode should use authoritative refresh and pending receipt recovery without broad routine writes |
| Process Event Dock / pasted notification | local ProcessEvent ChangeSet; later manual whole-snapshot sync | connected create now uses the existing bounded `record_process_event` domain command; connected delete uses a first-party scoped command with Undo; local-only mode retains ChangeSet |

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

A full import-reference check found that `DiscoveryInboxView` was present in source but unmounted from the active `AppV8` shell. The MCP proposal route still offered “Save to Inbox”, and saved items continued to affect AI/read and progress-reference logic. This was a real user-journey defect, not an active status-write path as the initial table had assumed. The existing review view is now mounted as a contextual Opportunities tab, preserving Today/Opportunities as the two primary destinations. Single and bulk status changes in connected mode use account-bound first-party `discovery_status` commands with receipt lookup, object conflict, Undo compensation, and cross-client projection. The delegated MCP tool schema does not gain this command; a principal guard rejects delegated callers. Local-only status semantics remain shared through one pure helper. Promotion is now being moved to a first-party scoped command with a reviewed confirmation, Opportunity/Action/ChangeSet audit, and Undo compensation. MCP proposal inbox-save still uses declared legacy whole-snapshot compatibility and remains OPEN retirement work. The browser journey checks status persistence from another client without a snapshot commit. This is engineering candidate evidence until exact-head CI/Browser passes.

## Discovery Profile candidate retirement

The first-party connected Profile save now submits one bounded `discovery_profile` command before projecting the authoritative snapshot locally. The gateway validates every field and rejects delegated MCP callers; `applyUserCommandSchema` is unchanged. The command targets only `discovery_profile:current`, records a durable receipt, and provides a compensation payload for Undo. The Profile card reloads clean remote projection while preserving unsaved edits. The local-only save remains local. A connected two-client browser journey now checks status and Profile commands without any whole-snapshot commit. This is candidate work until exact-head CI/Browser passes; promotion, MCP proposal and manual-sync compatibility remain OPEN.

## Promotion candidate retirement

The reviewed Discovery Inbox promotion candidate now uses a first-party `discovery_promotion` command in connected mode. The server derives the Opportunity, Apply action, ChangeSet and timeline from the already saved candidate; a matching existing Opportunity is reused. The command records affected object refs and a compensation payload, and delegated MCP principals remain forbidden. Local-only promotion keeps its existing path. The accepted timeline now points at the actual reused Opportunity ID when it differs from the candidate ID. Focused unit tests cover creation, audit, Undo and the permission boundary; the connected browser journey checks the confirmation and no whole-snapshot commit. This remains candidate evidence until exact-head CI/Browser passes.

## Signed MCP inbox-save candidate

The connected “Save to Inbox” action now submits one first-party `mcp_save_inbox` command. The server independently verifies the signed proposal, expiry, account binding, transactional revision and complete workspace fingerprint before deriving Inbox items; the browser cannot submit a raw ChangeSet as an authoritative command. It records a discarded ChangeSet for audit and does not add Opportunities or Actions. The delegated MCP command schema remains unchanged. Local-only review keeps its existing local path. Focused tests cover signed-account rejection, the delegated permission boundary and the saved Inbox outcome. This is a candidate until exact-head CI/browser and cross-client evidence pass. MCP proposal Apply and Settings/manual compatibility writes remain OPEN; `legacy_uncovered_web` is not retired.

## Signed discovery-apply candidate

Connected review of a pure Discovery proposal now submits one first-party `mcp_apply_discovery` command with the signed token, selected operation IDs and bounded rejection reasons. The server verifies the same signed/account/exact-baseline boundary, derives only the selected Opportunities and Apply actions, and commits their ChangeSet plus accepted/rejected feedback in one authoritative revision. Unknown selections, duplicate jobs, stale baselines and delegated MCP callers fail closed. Local-only review and other MCP proposal operation kinds retain their existing paths. Focused tests cover selection, feedback, atomic server receipt and stale rejection. Exact-head CI `35924740343` and Browser `35924740322` passed at `a5cc4927c4846ce208d71f0b0d7a3d8b81b68f32`; current-runtime deployment remains quota-blocked. Other non-Discovery proposal Apply and manual sync remain OPEN legacy retirement work.

## Signed Action-status Apply candidate

A connected signed proposal containing only Action-status changes now uses one first-party `mcp_apply_actions` command. The server independently verifies token, account, exact revision and full workspace fingerprint; it then checks each Action's expected status, applies the existing domain status transition in memory, and commits the whole reviewed batch plus ChangeSet in one authoritative revision. Duplicate Action changes, stale status, mixed operation kinds and delegated MCP callers fail closed. Undo restores the prior Action statuses through the existing compensation path. Local-only review and other proposal kinds keep their existing paths. This remains engineering candidate work until exact-head CI/browser evidence passes; whole-snapshot compatibility and other non-Discovery operations remain OPEN.

## Signed Decision Rules Apply candidate

A connected signed proposal containing one Decision Rules replacement now uses one first-party `mcp_apply_rules` command. It verifies the signed account and exact workspace baseline, checks the rules' expected update timestamp, validates the replacement, and commits the rule change and ChangeSet together. Undo restores the previous validated rule set. Mixed proposals stay on the documented legacy path; the delegated MCP command schema is unchanged and cannot invoke this first-party command. Focused tests cover stale rules, account isolation, delegated denial, atomic receipt and compensation. This remains candidate work until exact-head CI/browser evidence passes.

## Signed posting refresh and Discovery Run candidate

Pure posting-refresh proposals and pure Discovery Run record proposals now use one first-party `mcp_apply_source_refresh` command. It verifies the signed account and exact workspace baseline, resolves the expected posting identity and canonical source before updating Opportunity or Inbox evidence, preserves process stage and source history, then commits the reviewed ChangeSet atomically. A zero-candidate Discovery Run records its signed metadata without inventing an Opportunity. Mixed refresh/run batches now fail in both connected and local paths; the previous local path could mark a mixed ChangeSet applied while ignoring its refresh operations. Delegated MCP access remains forbidden. Focused tests cover stale source, mixed-kind failure, zero-candidate Run metadata, account isolation and one authoritative receipt. This remains candidate work until exact-head CI/browser evidence passes; other non-Discovery proposal kinds and manual sync still require retirement.

## Process event creation candidate

The Process Event Dock and pasted-notification flow were additional connected daily consumers of local ChangeSet writes. In transactional connected mode, creation now calls the existing account-bound `record_process_event` domain command before showing success; the server derives event identity, Opportunity relation, Action, schedule and timeline from the authoritative snapshot, and the client projects its committed result. The pasted raw notification remains outside the workspace. Connected deletion uses a new first-party-only scoped command that removes the selected event and generated Action, cancels its schedule, and records a compensating Undo snapshot. Delegated MCP callers cannot invoke the delete command or its Undo. Local-only creation and deletion retain their existing ChangeSet paths. Focused tests check stale deletion, receipt scope, schedule cancellation, compensation, and delegated denial. This is engineering candidate evidence until exact-head CI/browser and cross-client gates pass; other legacy consumers still block whole-snapshot retirement.

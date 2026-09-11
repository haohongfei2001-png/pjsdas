# PJSDAS v1.2 — ChangeSet / `propose_changes`

## Goal

v1.2 lets an authenticated ChatGPT conversation propose PJSDAS changes without giving the MCP server direct write access to the user's job-search workspace.

The trust boundary is explicit:

1. ChatGPT reads the current validated PJSDAS snapshot from Google Drive.
2. `propose_changes` normalizes the requested edit into the existing ChangeSet protocol.
3. The server validates the ChangeSet and binds it to the exact workspace fingerprint and Drive version it was derived from.
4. The server returns a signed, 24-hour review URL. No workspace write occurs.
5. Opening the review URL verifies the HMAC signature, expiry, Drive checkpoint and local workspace fingerprint. Opening the link still does not mutate IndexedDB.
6. Only an explicit **Apply ChangeSet** action persists and applies the ChangeSet. **Discard** records the rejected ChangeSet without changing job-search state.
7. If browser Google Drive sync is connected, PJSDAS requests a sync after Apply. Otherwise the local change remains unsynced until the user connects/syncs.

## Supported proposal inputs in the alpha

`propose_changes` accepts three bounded forms, which may be combined in one proposal:

- `progressText`: uses the existing deterministic natural-language progress parser for applications, recruiting progress/events and manual actions.
- `actionStatusChanges`: exact action IDs with a target status (`todo`, `doing`, `done`, `skipped`). ChatGPT should read the current plan/pipeline first and use the exact ID.
- `decisionRulesPatch`: explicit partial updates to user-visible Decision Rules and/or weights. Existing range and ordering validation still applies.

A proposal is capped at 24 normalized operations. Ambiguous progress updates fail closed and must be clarified rather than guessed.

## Security properties

- The MCP tool itself is non-mutating and never writes the Drive workspace.
- Proposal payloads are normalized ChangeSets; raw `progressText` is not persisted in the ChangeSet.
- Review payloads live in the URL fragment, so GitHub Pages does not receive them in the HTTP request URL.
- The fragment contains an HMAC-SHA256 signed capability token. The signing key is domain-separated from the existing server secret and is never exposed to the browser.
- `/api/proposal-verify` verifies the signature and 24-hour expiry before the browser can review the proposal.
- MCP ChangeSets carry `expectedWorkspaceFingerprint` and `expectedWorkspaceVersion` from the source snapshot.
- The review UI requires the browser's Drive checkpoint to match the proposal Drive version and requires the local workspace fingerprint to match the proposal baseline.
- Existing per-operation optimistic guards still protect Decision Rules (`expectedUpdatedAt`) and Action status (`expectedStatus`).
- Google Drive conflict behavior remains fail-closed; v1.2 does not claim atomic multi-device writes.

## Non-goals for v1.2 alpha

- No direct server-side Apply endpoint.
- No silent automatic application of ChatGPT suggestions.
- No general-purpose arbitrary JSON patching.
- No automatic job discovery ingestion with a rich structured Opportunity detail payload yet. A newly mentioned opportunity through `progressText` uses the existing local defaults until a later proposal schema adds richer opportunity metadata.
- No bypass of the normal Google Drive sync conflict model.

## Acceptance flow

A representative end-to-end test is:

1. In ChatGPT: “使用 PJSDAS，把今天某个任务标记为完成，但先给我提议，不要直接修改。”
2. ChatGPT reads the current plan to resolve the exact action ID, then calls `propose_changes`.
3. The tool returns `applied: false` and a signed `reviewUrl`.
4. Open `reviewUrl`; PJSDAS shows the proposed normalized operations and confirms that opening the link has changed nothing.
5. Click **Apply ChangeSet**.
6. Sync Google Drive if not already connected.
7. Ask ChatGPT to read the state again; the Drive version should advance and the applied state should now be visible.

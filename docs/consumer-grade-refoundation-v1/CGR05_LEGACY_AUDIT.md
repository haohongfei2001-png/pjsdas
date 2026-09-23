# CGR-05 — Connected write authority audit

State: OPEN ENGINEERING AUDIT; no retirement claim yet.

Baseline main: `66fa75d0755fbaad5da6a6e0ee94900305262f08`.

## Finding

Connected Web still has a broad daily whole-snapshot route. `CloudContext.syncNow()` calls `runCloudSync()`. In transactional mode, `runCloudSync()` can choose `push_local`, which calls `updateConnectedRemoteWorkspace()` with `snapshotPurpose: legacy_uncovered_web`. The gateway accepts this declared compatibility purpose with expected revision and fingerprint. CAS rejects a newer server revision, but the path remains a second write shape beside typed commands and can submit unrelated local state together. The 120-second auto-sync/focus/online hooks make this a routine path, not a rare migration tool.

## Current consumers

| Consumer | Observed path | Retirement boundary |
|---|---|---|
| Discovery Inbox status, bulk status, promotion | local mutation then `cloud.syncNow()` | typed authoritative status/promotion commands, receipt and conflict/Undo semantics |
| Discovery Profile save | local preference mutation then `cloud.syncNow()` | account-bound typed preference command or a clearly scoped non-business settings authority |
| MCP proposal apply / save to inbox | local ChangeSet/inbox mutation then `cloud.syncNow()` | preserve explicit review and source authorization while moving business mutations to typed commands |
| Settings manual sync | `cloud.syncNow()` | connected mode should reconcile/read and replay pending typed commands without broad routine writes |
| Auto-sync on timer/focus/online | `cloud.syncNow()` | connected mode should use authoritative refresh and pending receipt recovery without broad routine writes |

Already converted daily paths include Today action status/Undo, Tell PJSDAS and DecisionRequest in transactional mode. They must remain typed during retirement.

## Required gate before deletion

For each current consumer, preserve the same user outcome in both local-only and connected modes; verify account/session isolation, unknown-commit receipt lookup, CAS conflict, cross-client visibility, source/provenance and Undo where the operation supports it. Once no supported daily consumer needs `legacy_uncovered_web`, reject that purpose at the client/server boundary and retain only explicit migration/recovery compatibility with a concrete supported caller. Do not replace a failed sync with a false success receipt or restore an old snapshot over newer server facts.

Production architecture certification remains pending exact deployment under `DEFERRED_FINAL_GATES.md`; this audit is code-level evidence only.

## First bounded safety change

Background timer/focus/online refresh in transactional mode now reads and reconciles without silently choosing `push_local` for a whole-workspace commit. When it finds local changes that still depend on a legacy writer, it reports `local_pending` and preserves the local data and checkpoint. Explicit existing sync after a supported legacy mutation remains available until that consumer is converted. The connected passive/explicit boundary has a focused test; this is a containment step, not retirement of `legacy_uncovered_web`.

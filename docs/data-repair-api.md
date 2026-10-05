# Audited data-repair commands

These commands extend the existing owner/legacy transactional `apply_user_command` surface. They do not add consumer access, grants, credentials, an admin endpoint, or an automatic data migration. A deployed code release makes the capability available; it does not repair any user's records by itself.

## Review first

`get_workspace_integrity` remains read-only. Its optional `review` accepts one of:

- `{kind: "legacy_process_event", eventId}`
- `{kind: "decision_request", requestId}`
- `{kind: "opportunity_merge", canonicalOpportunityId, duplicateOpportunityId}`

The response includes `repairReview` and `meta.workspaceVersion`. Copy the exact returned fingerprints/dependency manifest and current `txn:` revision into the explicit command. Any concurrent change is a conflict, requiring a fresh review. All commands require a unique `commandId`, reason and bounded evidence references. Retries of an already-applied identical command do not write again; reused command identities with different content are rejected.

An integrity warning is a candidate for investigation, not proof of a duplicate. A shared campaign URL can describe different jobs. Different positive posting IDs, application job URLs, roles, business lines, batches or locations must not be silently collapsed. Expired unsubmitted deadlines use the pre-existing fingerprinted `correct_application_deadline` command after source verification; expiration does not prove abandonment or rejection.

## Legacy evidence

`invalidate_legacy_process_event` accepts `eventId`, `expectedEventFingerprint`, exact `sourceRefs`, `expectedWorkspaceVersion`, reason and `evidenceRefs`.

This is a separate explicitly reviewed path. It refuses events referenced by any semantic receipt, including legacy receipts without per-fact ownership; the existing receipt-owned `invalidate_process_event` rules are unchanged. It also refuses linked actions/schedule nodes and nonterminal owned events that require lifecycle reconciliation. It preserves the original event and adds a correction receipt and timeline audit, rather than deleting history or fabricating an original receipt.

Markerless or inconsistent terminal projections on an existing target are blocked as `UNPROVEN_TERMINAL_PROJECTION`; no prior stage is guessed. Only projections that explicitly identify the corrected event are recomputed. Independent later events survive. A reviewed orphan becomes an inactive historical tombstone; unaudited dangling events remain critical. The correction itself is retained as audit history and has no automatic undo.

## Decisions

`dismiss_semantic_decision` accepts `requestId`, `expectedRequestUpdatedAt`, `expectedFingerprint`, `expectedWorkspaceVersion`, reason and `evidenceRefs`.

It works for open or expired questions, regardless of whether the offered choices contain a valid target or an ignore option. It does not select a candidate or create a business fact. Original source, choices and candidate remain intact, with explicit `dismissed` state and audit metadata. Exact source/version/content replay remains dismissed; changed facts or source versions may be reviewed again. Ledger-backed `undo_semantic_command` restores the request only while its exact dismissed state is still current.

## Opportunity merge

`merge_opportunities` accepts canonical/duplicate IDs, `expectedFingerprint`, exact `dependencies`, `expectedWorkspaceVersion`, reason and `evidenceRefs` containing the verified common posting source.

The bounded implementation requires positive matching posting evidence and refuses conflicting profiles/identities, multiple process projections, unresolved semantic decisions, pending changesets, shared application governance or external reminder ownership. Reconcile those conflicts explicitly first. It never sweeps the integrity warning list.

Active event/action/process/schedule/discovery references move to the selected canonical opportunity. The removed opportunity is retained in a durable alias with its complete original provenance; historical timelines and receipts remain unchanged. Read/write identity and fact-key comparisons resolve aliases, preventing source replay from recreating the duplicate or reviving invalidated facts. Native IndexedDB upgrade/hydration/export and command deltas retain aliases. Old-ID profile/archive management fails closed; canonical archive with retained aliases requires a separate reconciliation workflow. Legacy spreadsheet reimport also fails closed while aliases exist.

`undo_semantic_command` uses bounded changed-object compensation. Undo requires the exact post-merge workspace fingerprint and current ledger revision; any newer workspace input, even unrelated input, blocks automatic rollback rather than overwriting it. Merge audit and undo audit both remain.

## Verification and rollout

All new tests use synthetic sources and identities. Focused tests cover source isolation, stale review, no-receipt versus receipt-owned correction, inactive orphan audit, safe dismissal and replay, merge identity conflicts, immutable provenance, alias reads/new writes/replay, compensation conflicts, and IndexedDB reload.

No production data repair is part of the implementation. After final-head unit/type/build, original SQL isolation gates and native-browser gates pass, deploy through the existing release process. Verify the deployed tool schema and read-only review response before using any repair on real records.

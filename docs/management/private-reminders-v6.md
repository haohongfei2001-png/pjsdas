# Private reminder management v6 — source-only contract

This separate `workspace.reminders.manage`, consent-version-6 slice manages private in-product ReminderIntents only. It is not registered in runtime or consent routes; no grant, live migration, external task/calendar action, outbox delivery or standing communication is created. Existing v2–v5 scopes remain unchanged.

## Bounded data operations

- Read bounded private intents and minimal exact owner schedule targets, with canonical fingerprints. External or outbox-linked reminders are not exposed through the private-intent list.
- Create only on a reviewed active latest schedule node, with explicit timezone-bearing trigger time and purpose. The server derives reminder identity, target version and dedupe key. Existing target/purpose ownership is checked even if a legacy imported key is malformed.
- Patch only trigger time or active/paused state, guarded by both reminder and node fingerprints. Cancel keeps the record and evidence; it does not complete or cancel a schedule node.
- Unknown/security/ownership fields and cross-account selectors are rejected. IDs and cursors are exact, including valid stored whitespace. Up to 25 target-specific operations execute atomically; one reminder cannot be targeted twice in a batch. Request/read results are bounded to 256 KiB, individual reminder rows to 16 KiB, with structural and compensation-envelope bounds.
- Active creation, update and restore reject collisions with other delivery owners. External or outbox-linked rows cannot be changed privately. Safe pause/cancel can stop a conflicting private intent without touching external rows.

## Recovery and raw preservation

All paths use validated raw snapshots and never run unrelated schedule/date normalization. Compensation comes only from the owner-scoped ledger and requires its exact SHA-256 fingerprint. The client cannot supply compensation JSON.

Before/after rows, target-node fingerprints and original positions are retained. Restore refuses newer reminder values, changed targets, outbox references, logical purpose conflicts and identity reuse. Existing rows are restored in their current positions, preserving later unrelated collection reordering; removal of newly created private rows restores their absence. Audit history and external receipts are never purged.

Cancellation may safely stop an old active intent whose schedule target is already inactive. Its evidence remains retained, but restore cannot reactivate that inactive target. Retained evidence is not a promise that every later restore is safe. Undefined/sparse array metadata is rejected rather than fingerprinted as null. Compensation bounds account for all before/after rows plus escaped UTF-8 identities and envelope overhead.

## Authorization and SQL boundary

The adapter internally binds the first admitted grant UUID/revision to its executor. Exact owner/client/capability/version proof is required at admission, retry, precommit and non-commit/read response release. v1–v5, foreign, revoked, replaced and regranted proofs cannot authorize old requests. SQL denial never falls back to the generic mutation RPC.

The service-role-only SECURITY INVOKER wrapper locks grant and workspace in the same CAS/ledger transaction. It preserves all non-reminder business data, the complete reminderOutbox, all prior timeline entries, and every external/outbox-linked reminder with its relative order. JSON-null capability/externalLink fields are not treated as absent. Reminder identities, target versions, purpose keys and active-target conflicts are checked under the workspace lock. Undo is restricted to a committed private-reminder command in the same owner's ledger.

## Verification and limits

Retained tests cover reducer boundaries, maximum-size/escaped-ID batch restoration, exact-ID pagination, admission/retry proof binding, replay/hash mismatch, raw execute/undo, result privacy, SQL privileges, cross-version isolation, external/outbox protection and ordering, and actual gateway-to-SQL lifecycle/recovery cases. The real PostgreSQL fixture additionally exercises mutation/revoke/regrant ordering plus concurrent schedule-target and outbox changes. PGlite is not real multi-session evidence; exact-head hosted results must be recorded separately before claiming that gate passed.

Migration `20261002220516_private_reminder_management_v6.sql` depends on source v5 and earlier migrations. No migration or consent activation is implied by source integration. Reconcile live schema history and obtain explicit activation/owner-client consent separately.

A stored active in-product intent is not proof that a notification was delivered. This completes only the bounded private-reminder portion of the broader business-data plan.

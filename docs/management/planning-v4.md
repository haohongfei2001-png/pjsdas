# Planning management v4: source-only contract

This slice is not registered in the production tool catalog or consent routes. It issues no grants and applies no production migration. Existing v2 and v3 consent keep their exact meanings. Activation needs a separately reviewed, explicitly accepted owner/client scope and the prerequisite database migration chain.

## Bounded operations

`workspace.planning.manage`, consent version 4, covers only the singleton decision-rules configuration and time-planning preferences. Read returns raw and effective values plus a canonical SHA-256 fingerprint. A command can patch or reset each configuration once, at most two operations and 256 KiB. Patches use existing field validators, reject unknown keys, invalid real calendar dates, overlapping windows and unsupported numeric ranges. Missing capacity remains unknown; zero means explicitly unavailable.

Reset rules writes the product's recommended defaults. Reset time preferences removes the explicit configuration. Both are recoverable using ledger-owned before/after evidence. Restore requires the exact compensation fingerprint and refuses newer configuration changes. The client cannot submit arbitrary compensation or choose server-owned metadata.

Changing configuration can change future calculated recommendations. It does not rewrite historical scores, job facts, application progress, actions, schedule nodes, deadlines, reminders or past audit rows. Rescheduling is a separate explicit command. No discovery profile, paid-search approval, provider, credential or security setting is writable here.

## Authorization and transactions

The immutable admitted grant ID/revision is checked before work, at retry and precommit boundaries, and before non-commit responses are released. v2/v3 grants cannot authorize these commands. The service-only v4 SQL wrapper locks the exact account/client/versioned grant in the same transaction as workspace CAS and ledger commit. Revocation/regrant cannot replace an in-flight proof. SQL failure never falls back to a less restricted RPC.

The SQL wrapper compares every protected data field under the workspace lock and preserves the entire previous timeline prefix. The v4 gateway preserves validated raw snapshots, avoiding unrelated schedule normalization during read, commit and restore. Older snapshots needing a separate structural migration fail closed rather than acquiring hidden data changes through a planning command.

## Verification and activation limits

Synthetic tests cover raw/effective semantics, no-op behavior, reset/restore, stale fingerprints, unknown deadline exclusions, legacy date preservation, account/client/scope isolation, admission/retry/regrant races, idempotency, SQL role permissions and protected-domain/history checks. PGlite verifies SQL semantics; the dedicated hosted PostgreSQL workflow separately tests actual multi-session lock ordering. Record the exact run result before any future activation; local PGlite is not proof of concurrent sessions.

Migration `20261002195807_planning_management_v4.sql` depends on source migration `20261002175431_opportunity_management_v3.sql`. Neither dependency nor this migration is permission to apply them live. Source filename timestamps may differ from an authorized platform-applied migration's recorded version; reconcile recorded schema history before application.

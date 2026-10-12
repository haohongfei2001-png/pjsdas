# Gmail execution diagnostics (pending review and deployment)

This change adds content-free diagnostics to both existing controlled worker paths and both existing finish RPCs. It does not change budgets, schedules, leases, authorization, data ingestion, or continuation decisions.

## Contract

`metrics.diagnostics` has exactly `version: 1`, `phase`, `processedCount`, and `durationsMs`. Phase names and timing keys are a closed list: claim, token_refresh, workspace_read, gmail_list, gmail_fetch, message_parse, semantic_apply, lease_assert, workspace_commit, checkpoint, complete. Counts are integers capped at 100 (the legacy polling bound; reconciliation still processes at most five). Each cumulative wall-time duration is rounded and capped at 25,000 ms. Timings include the body processing between phase transitions, not just fetch headers.

No emails, subjects, message/user IDs, URLs, tokens, arbitrary error messages, or stack traces enter this object. Unknown phase/key inputs are dropped by the SQL allowlist. Invalid numbers are omitted. The application retains its own collector rather than depending on Error.cause, and snapshots it before the existing error cleanup even when the work signal aborted. Existing provider error semantics remain unchanged.

Diagnostics are sampled before the finish RPC. Thus a successful finish request marks checkpoint with its time so far, usually zero; it does not measure the future network round trip. A failed finish followed by the already-existing error cleanup can report the elapsed checkpoint attempt. No second successful-finish write is added for measurement. If no lease was acquired, no budget remains, cleanup fails, or the process is terminated, the DB may retain older diagnostics. The presence of a newer lease timestamp alone does not prove last_metrics belongs to that execution. Compare existing execution/cycle timestamps and committed ledger evidence.

`gmail_list` groups Gmail profile/history/list requests; `gmail_fetch` identifies payload fetching, including concurrent payloads. The collector discards the source URL immediately after choosing a fixed label. Claim timing starts with each user's lease attempt, not the preceding binding-list call. No claim means there is no owned execution to finalize. Workspace commit includes identity CAS read, fingerprint/diff/validation/serialization, and commit response handling; it is not a server-only SQL duration.

## Database change and compatibility

Migration `20261012145000_gmail_execution_diagnostics.sql` replaces only pjsdas_finish_gmail_execution(text,uuid,uuid,jsonb,jsonb) and pjsdas_finish_gmail_reconciliation(text,uuid,uuid,jsonb,jsonb). It adds the same bounded diagnostic JSON construction after each original safe_metrics allowlist. Function bodies minus that block are byte-identical to migration 20261005211006. The signatures, return types, SECURITY DEFINER, search_path, guards, state transitions and existing ACLs remain unchanged. There are no GRANT, REVOKE, table, column, policy, scheduler, or credential changes.

Older callers without diagnostics or with an unsupported diagnostics version preserve exactly the old safe_metrics result. New callers against old SQL continue normally, but old SQL discards diagnostics. This is observational and does not require coordinated worker shutdown.

`GMAIL_EXECUTION_DIAGNOSTICS_ROLLBACK.sql` contains exactly the two preceding function definitions. Applying it restores the old behavior without deleting data or changing privileges. Existing JSON values remain readable. Neither the forward SQL nor rollback is automatically applied by this code change; production execution requires separate release review.

## Verification

Tests cover cumulative/bounded timings, immutable failure snapshots, rejection of arbitrary labels, absence of error content, both generic cleanup paths, both budget-abort paths, pre-request checkpoint semantics, and byte-exact function-body/rollback parity. SQL structural tests do not substitute for executing the migration in a disposable PostgreSQL validation environment.

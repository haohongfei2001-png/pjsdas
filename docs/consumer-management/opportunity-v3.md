# Opportunity management v3: bounded source-only slice

Baseline: PR227 / e3a9a310. This change does not enable a tool, create a grant, alter v2 consent, run a production migration, or mutate a real workspace. Public signup and distribution remain deferred.

## Implemented command contract

A separately named `workspace.opportunity.manage`, consent version 3 proof admits `opportunity_management`. Version 2 remains exactly the existing independent Prep/manual Action/ApplicationGroup capability. Neither grant version can invoke the other version's operation or atomic SQL wrapper. Production contains no v3 grant resolver, tool registration, activation flag, consent screen or issuance path in this slice.

- `update_opportunity_profile`: exact ID and SHA-256 current opportunity fingerprint, with a strict nonempty typed patch. User-editable fields are roleType, early, prepEstimateMinutes; detail backgroundTag/coreOutput/workMode/candidateProfile/jdSummary/gap/intensity/earlyReason/rules; userFacts location/compensationText/applicationUrl; and named fit/opportunity-value assessment components. Null clears only declared nullable fields/components. There is no arbitrary property path or JSON Patch.
- Assessments accept only explicit score/confidence/rationale values. Resulting axes must each retain at least one component. The existing weighted scorer computes totals using the current unchanged DecisionRules. Existing assessment neighbors, imported facts/discovery evidence, dates, application state, source metadata and all unrelated user application records are preserved.
- `archive_opportunity`: exact aggregate SHA-256 proof, explicit reason, and exact reviewed dependent-ID manifest. Closure follows stored opportunity/process/event/action IDs, expands to every version of each affected schedule occurrence, and includes attached in-product ReminderIntents. The complete original Opportunity/Process/Event/Action/ScheduleNode/ReminderIntent objects and collection positions are retained in the existing owner-scoped command ledger compensation; they are removed from live collections atomically. Existing timeline, semantic receipts and external receipts are never rewritten or purged. This avoids leaving live orphan events that projection code would turn back into actions.
- `restore_opportunity_management`: exact owner command ID and SHA-256 compensation proof. This is the existing authoritative undo path with a v3 check, not client-provided restore data. It restores original order, identity, facts and states, including previously cancelled/completed/superseded nodes. It retains the archive audit entry. Profile edits are likewise reversibly compensated. It does not make an external application, withdraw one, release an application-group slot, send notifications or delete permanent history.

Limits: 20 distinct opportunities per atomic batch, 256 KiB input, 2,500 aggregate objects and 1 MiB retained compensation. An invalid final operation leaves the entire input snapshot untouched.

## Fail-closed boundaries

- Unowned or cross-opportunity effective process-event pointers block archive/restore until reconciled.
- Shared prep/group-derived actions, shared schedule occurrences and schedule-to-Prep relationships require a future explicit reassignment workflow.
- External reminder capability/link/outbox dependencies must be reconciled before archive; this path never creates an external cancellation or delivery.
- Open semantic decisions and promoted DiscoveryInbox links for the affected aggregate block archive/restore; linked-inbox archiving remains a later explicit domain.
- Restore rejects any ID reuse, changed touched object, newly arrived dependent input or reused occurrence identity. Required application-group parent changes and assessment-rule changes also block undo. Unrelated newer records are retained.
- Source/company/role identity renaming, applicationGroup reassignment, imported provenance, raw facts, direct aggregate scores, participation/stage/result, dates/deadline corrections and effectiveProcessEvent fields are absent from the patch schema.
- Retained archives currently live in the existing ledger. There is no archive browser, independent retention catalog, physical purge or durable binary-material store.

## Transaction/security boundary

The same authoritative executor computes complete diffs, projection deltas, affected object/occurrence receipts, CAS conflicts, command hashes and compensation. The first server-admitted grant UUID/revision is copied and bound across reads and CAS retries. No-write/replay paths recheck authorization; committed responses remain truthful if a later revocation occurs. Restore binds the actual owner-ledger compensation proof, including replay paths.

The additive migration permits only the exact capability/version pairs `(workspace.manage,2)` and `(workspace.opportunity.manage,3)` in the existing grant table. No row is inserted or upgraded. The new service-role-only SECURITY INVOKER wrapper locks only a current matching v3 account/client grant `FOR SHARE`, admits only the new operation (or its owner-scoped undo), and calls the existing authoritative workspace transaction. V2 wrapper and consent hash/text remain unchanged. Ordinary roles retain no table or execute access. No generic RPC fallback is permitted after a missing/wrong/stale proof or SQL denial.

Migration filename was generated with pinned Supabase CLI 2.119.0 in an isolated local CLI home. Current Supabase changelog and function-security guidance were checked; no production connection or credentials were used. Synthetic SQL tests validate privileges, schema and grant-version behavior. Real multi-session grant-lock tests run in the existing isolated PostgreSQL 17 CI fixture; local PGlite results alone are not a claim of concurrency validation.

## Verification and remaining coverage

Synthetic tests cover field injection, exact fingerprints, missing/foreign selectors, partial-batch rollback, no-op timestamps, explicit assessment recomputation, archive manifests, retained source/audit records, state/order restoration, shared/external references, newer input/ID conflicts, version/account/client denial, revoke/regrant/replacement at admission/commit/retry, exact RPC selection, receipt replay, restore proof and read-result withholding.

Still intentionally pending: Opportunity identity renaming and broader facts model; source-backed process-event correction/supersession with derived stage/action/schedule reconciliation; ProcessRecord planning-field edits; linked Prep/Action and independent Schedule management; remaining rules/preferences/discovery/material domains; v3 first-party consent and installation/catalog activation. This is progress toward full business management, not full-data read/write completion.

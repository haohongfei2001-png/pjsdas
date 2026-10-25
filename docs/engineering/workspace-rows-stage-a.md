# Stage A: row-capable persistence candidate — NOT DEPLOYABLE

This branch is an isolated implementation experiment, not a production migration. The deployed transactional store does not import it. Both candidate switches (`readsEnabled`, `writesEnabled`) default to false; writer use requires reader capability. No production environment variables, resources, credentials, table layouts, or permissions are changed.

## Implemented vertical slice

- Lossless JSON-wire entity codec: complete entity values, array ordinals, manifest presence/count and unknown envelope fields. Object key order is irrelevant to diff; array order is not. Missing collection, empty collection, explicit null and omitted undefined follow the existing JSON contract.
- HTTP candidate adapter using header → bounded keyset pages → final generation/revision fence, then the existing snapshot validator. One attempt fails closed; it does not introduce unbounded retries or change worker budgets.
- An isolated SQL schema with UUID generation, serialized CAS, exact entity preimages, immutable command receipt/compensation and typed collection validation. The generic entry accepts only the trusted existing-core Gmail family. A separate planning entry uses the real existing management-grant schema and current legacy RPC as a differential oracle, including protected data/audit, Undo-family binding, revocation in both lock orders and regrant receipt replay. This SQL does **not** independently prove a caller supplied the complete semantic effects.
- A real PostgreSQL + PostgREST HTTP test: actual notification parser and Gmail core output, database read → actual core application → small write → exact logical read, receipt replay, concurrent inter-page write conflict, direct HTTP rejection of unsupported guard families, ordinary-role denial and default-off behavior.

SQL is deliberately under `tests/sql/candidates/`, **not** `supabase/migrations`. It must only run in a disposable local synthetic database. The harness rejects remote database hosts, creates a randomly named test database and drops it afterward. Use an existing verified official PostgREST binary; the harness does not download or install software:

```sh
TA_ROW_DATABASE_URL=postgres://postgres@127.0.0.1:55439/postgres \
TA_POSTGREST_BIN=/absolute/path/to/verified/postgrest \
node --import tsx tests/sql/workspace-rows-stage-a.mjs
```

The local PostgreSQL fixture must already define `anon`, `authenticated`, and the existing `service_role` role. The harness does not create production roles. Its connection must be a disposable local cluster administrator, never a production connection tunneled to loopback.

## Frozen candidate protocol

- Schema: `pjsdas_rows_candidate`, contract `workspace-rows-v1`.
- `read_head(target_user_id)` returns owner/workspace, UUID epoch, revision, layout, envelope and manifest.
- `read_page(target_user_id,target_workspace_id,target_epoch,target_revision,after_collection,after_ordinal)` binds page and head to one SQL statement snapshot. Ordered `(collection COLLATE "C", ordinal)` pages contain at most 127 rows; oversized returned page is rejected. Gateway also checks owner/layout/epoch/revision/order/count/completeness and final head.
- `commit_rows(req)` admits only `gmail_semantic_intake` / `automation` / `gmail:primary`. The generic entry rejects management, AI-capture and Discovery authorizations before mutation; the planning entry separately validates its real version-4 grant. Its low-level row primitive lives in a private schema not exposed by the HTTP server. Per-command payload binding, original receipt replay, CAS/preimage, structure and compensation persist in one transaction. Persistent business conflicts use explicit PT409 rather than serialization SQLSTATE40001, preventing transport-level automatic transaction retries for a condition that cannot resolve by retrying the same request.
- Planning grant authorization is checked before replay; an already-applied command retains the original immutable grant receipt even after valid regrant, while a new commit must bind its current grant.
- Candidate request/row caps are experiment limits, **not approved new product limits**. Large singleton/entity/page behavior still needs production-contract decisions. Post-response byte checks are not a hard server memory bound. Complete snapshot assembly still uses application memory.

There is no product layout activation, seed/cutover service, old-writer adaptation, recovery RPC, or production feature flag in this slice. An old-blob mutation trigger in the isolated model is **not** proof that the real old RPCs are safe.

## Required writer/read compatibility matrix

| Existing entry | Candidate status | Required before activation |
|---|---|---|
| workspace v1/v2/v3/v4 | NOT ADAPTED | DB-enforced generation-aware logical write; old calls fail closed, original replay/snapshot semantics |
| bootstrap + consumer bootstrap | NOT ADAPTED | Existing rows read logically, no raw overwrite; original owner/consent contract |
| management v2 | REJECTED | Real grant locking/revocation and operation/effect protections |
| opportunity v3 | REJECTED | Opportunity/related-entity allowed effects and immutable audit |
| planning v4 | ISOLATED GUARD/HTTP PROOF | Real grants, protected data/audit, Undo binding, both revoke orderings and regrant replay pass; production routing/layout/ledger integration still open |
| discovery profile v5 | REJECTED | Current scope/profile proof and CAS |
| private reminder v6 | REJECTED | Intent/outbox and existing authorization constraints |
| consumer business v7 | REJECTED | Every business family, compensation/Undo and grant constraints |
| durable AI capture | REJECTED | Capture record + workspace commit atomicity and replay/authorization |
| Discovery commit | REJECTED | Scope, claim, trusted budget hold/admission and receipt semantics |
| Gmail normal semantic write | TRUSTED-CORE CANDIDATE ONLY | Real execution lease/binding/finish integration and original ledger contract |
| 305 empty checkpoint/drain | NOT ADAPTED | Pending logical absorption, guarded cutover and old-inflight rejection |
| central store/readiness/export/backup | NOT WIRED | Layout-aware complete logical reader and generation-coherent recovery |
| direct old table write | MODEL GUARD ONLY | Actual table/layout protection with unchanged ordinary-user permissions |

Rejected does not mean implemented. Tests deliberately prevent an unsupported family from silently falling through to the generic candidate.

## Recovery and rollout hard gates

Two independently usable **row-compatible** releases must exist before any canary. Rolling application code back must retain the active row layout and support all business writes; simply disabling reads or returning to old full-snapshot RPCs is unsafe. Restoring an old blob is a separate full-materialization operation and may reintroduce the original cost. No immediate blob rollback is claimed.

Stage A must still prove all real guarded writers and old calls, 305 pending absorption/cutover, immutable history, grant revocation races, original Gmail commit-first/finish recovery, actual production-route transport limits, migration crash recovery, resource capacity and a viable row-compatible rollback release. No new paid capacity or time-budget increase is assumed.

Only after a frozen exact DDL/ACL/layout/rollout/recovery change set, all applicable tests, and separate explicit production approval can this leave the experiment stage. This candidate must not be merged or deployed as a new production layout based only on the vertical-slice tests.

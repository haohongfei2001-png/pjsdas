# TodayAction consumer management contract — draft, 2026-10-02

Status: target contract and phased implementation plan; not a released API or live grant. See batch-1.md for the implemented subset. Same backend, existing authoritative command transaction/ledger. PR216 compatibility frozen. This document deliberately separates business-management implementation from changing live persistent access.

## Coverage matrix
|Domain|Existing capability|Target operation coverage|Integration constraints|
|---|---|---|---|
|Opportunity|add; limited fact/deadline/preference edits; abandon|read/create/update/archive/restore; typed merge later|Preserve source facts vs user corrections; rebuild process/schedule projections; do not expose derived scores as arbitrary writable data|
|Process/application|submission + recruiting facts|read/create/update/archive/restore with semantic transition|No external application/withdrawal/offer acceptance; application group constraints apply|
|Process event|record/invalidate; web delete|read/create/correct/archive/restore|Original source fact remains immutable audit evidence; corrected effective fact version drives state|
|Action|manual create/status|read/create/update/archive/restore|Derived apply/prep/event actions require editing authoritative parent or explicit user overlay; cannot be overwritten by next recompute|
|Schedule|complete/cancel/reschedule occurrence|read/create/update/cancel/restore|Use occurrence identity and append schedule versions; archive != completion; source vs user temporal constraints remain distinct|
|Prep|read graph|read/create/update/archive/restore|Existing Prep fields only; rebuild affected graph/action derivations|
|Application group|portfolio read|read/create/update/archive/restore|total is user capacity; used/remaining are derived; delete with members rejected unless explicit reassignment plan|
|Decision rules|read + proposal/review|read/update/reset-defaults|Validate complete resulting object, recalculate affected priorities, preserve complete previous rules for undo|
|Discovery profile|read/web update|read/update/reset|No new inference stored as preference without explicit instruction|
|Time preferences|capacity/windows commands|read/update/reset timezone/windows/date overrides|IANA timezone from user, valid windows, DST tests|
|Discovery inbox|read/promote/status|read/status/correct/archive/restore|Candidate creation remains existing source-backed ingestion, not arbitrary incomplete discovery_item creation|
|Reminder intent|read/semantic requests|read/create/update/cancel/restore private policy|External delivery requires separate verified capability/grant; no email/calendar side effect in generic CRUD|
|Materials|No dedicated entity or binary store|phase 2 metadata/text/reference model, then private binary versioning|Do not create new paid service; no arbitrary external fetch; URLs alone not ownership proof|
|Timeline/ledger/receipts|read/audit|read/export only|Corrections add records. No generic editing of audit, token, identity, grants, system counters|

Exploratory full-domain schemas cover shape validation, not all production enums/fields. In particular add remaining rules component-weight maps, typed assessments and opportunity detailed fields only after mapping their existing validators. Do not claim full coverage until the matrix and all existing persisted fields are reconciled.

## First coherent production batch
1. Add typed management read/mutate contracts and pure domain reducers for existing Prep, manual Action and ApplicationGroup.
2. Initial reversible archive uses existing ledger before/after compensation, retaining full objects without a snapshot migration. A later archive browser or independent retention catalog requires an explicit migration contract; do not silently purge ledger evidence.
3. All writes enter authoritativeBusinessCommandSchema via `business_management`, not raw snapshot or database write. Compute affected object refs/field scopes and read-model invalidation; use original commandId/baseRevision/idempotency ledger.
4. Register management MCP tools only with a server-side v2 user/client management grant. No default enablement for current email/profile-only connections. Read-only profile/capabilities describe upgrade required truthfully. Keep all v7 tool names/schemas working.
5. Tests for reducer, schema, command store, auth gate, tools/list and Web/MCP equivalence before enabling anything.

## Command semantics
- Server determines account from validated token. Tool schemas have no owner/account/client/security/SQL fields.
- CRUD operations strict-discriminate entity type, only allow writable business fields, explicit null clears supported nullable fields. Unknown/empty patches rejected.
- IDs from read tools, exact matches only. Same string ID in another workspace is still not visible; missing and foreign references share NOT_FOUND result.
- Batch first version: maximum 50 commands, atomic transaction, deterministic commandId-derived create IDs, size cap. All validate before commit; no hidden partial-success mode. Every target/reference must resolve in owner workspace. Future create-reference dependencies need explicit local operation handles, not guessed IDs.
- Each batch uses one exact baseRevision and receives command receipt, changed entity versions, affected object refs, undo capability and current workspace revision.
- Archive is reversible business removal, never purges audit or deletes account. Referential rules reject removal of parent with active children unless operation contains exact planned cascade/reassignment; blanket cascade flags not accepted.
- Restore references an existing owner tombstone plus version. Must reject ID reuse, stale versions, missing parents or conflicts.
- Undo targets owner command receipt. Restore only touched fields/objects when their revision still matches; reject conflicts with later changes rather than overwrite them. Undo itself appends a command.
- Pure validation has no external side effects; no write is inferred from quoted/imported instructions.

## Capability / consent migration contract
Existing authorizations stay v1 and keep existing bounded behaviors. Add a separate server-owned capability grant record with `(account_id, oauth_client_id, consent_version)` identity, granted capability set, consent-text hash/version, granted_at, revoked_at. Proposed v2 capabilities: workspace.read, workspace.manage. Data-source ingestion grants remain separate and cannot imply management. Never derive grants from user-editable JWT metadata or client-supplied flags.

Flow: existing connector may read current grants/status -> explicit user OAuth/first-party authorization screen explains all business domains, reversible writes, batch operations, retention, external-action exclusions -> authorization completion creates v2 grant -> each operation checks current unrevoked grant -> disconnect/revoke removes access. A scope string is not enough without validated enforcement. Old v1 tokens must never gain management simply because code deployed. No background migration auto-grants powers.

JWT validation must bind issuer, expiry, audience/resource and client. Current Supabase `/auth/v1/user` verification is existing foundation; audit audience/resource and custom scope support against current provider docs before choosing final implementation. Use application capability consent if provider cannot issue custom OAuth scopes, but it still requires explicit matching account/client approval. Do not activate new live permissions in this development batch.

Service-role database access bypasses RLS: owner context must be fixed server-side and propagated into all RPCs, references, ledger, snapshots, archives and materials. DB service-role credentials must never enter package, tools, browser or tests.

## New-user/bootstrap contract
`initialize_workspace(commandId, timezone)` authenticated first-party authorized onboarding only, default empty schema-valid workspace with default rules/preferences; no arbitrary snapshot input. Idempotent unique(account_id); returns existing workspace without reset if present. Preserve existing migration-required flow for recognized legacy Drive state and require explicit import/migration decision. No Drive/Gmail permission needed to start blank. Timezone belongs to workspace preferences; explicit settings update does not reinterpret historical instants, and date-only business facts stay date-only. Browser guessed timezone is shown before saving.

## Consumer plugin package
New draft `plugin.json` + `mcp.json` remote streamable-http declaration, metadata/assets/privacy/support, no apps/.app.json mapping or secret. Stable universal production MCP URL, selected only after canonical endpoint/publication-owner check. Keep dev/test package separate; don't hard-code user-specific IDs. Metadata accurate for read/write, reversible/destructive, bounded private workspace. No generic raw JSON/sql tool.

Publication gates: verified publisher; account permission; domain challenge; endpoint/OAuth scan; dedicated synthetic reviewer account and sample workspace; five positive/three negative test cases + walkthrough + privacy policy; approved publication. Do not submit or change production security/grants merely to test package. Existing installed connection refresh/scan path must be observed, not assumed. Acceptance checks use real installed tool catalogue, not health alone.

## Mandatory tests before full enablement
- Every matrix domain and every mutable field: create/read/update/clear/archive/restore + audit receipt.
- Wrong account IDs on entity, parent, event, archive, commandId and undo: no read/write existence leak.
- v1/read-only/revoked/expired/wrong audience/wrong client tokens cannot manage.
- Same command same hash replay returns prior result; different hash same command fails. Parallel revisions cannot both overwrite.
- Bulk >50/payload limit rejected; final invalid operation leaves entire batch unchanged; repeated item targets deterministic.
- Archive/restore: all associations and derived views consistent; restore after ID collision rejected; historical source evidence not erased.
- Undo after unrelated change works when safely scoped; undo after same-field update conflicts; no reverting unrelated later edits.
- Ordinary explicit internal commands execute without second review click; ambiguity asks only missing target; permanent deletion has separate action-time confirmation path.
- New-user bootstrap and double-click retry; existing migrated account never reset; legacy import remains explicit; schema upgrade roundtrip.
- Timezones UTC/Asia/Shanghai/Europe/London; DST missing/repeated local time; date-only vs datetime preserved.
- All old v7 tool schemas/216 exact-fact corrections remain compatible; actual installed catalogue shows newly approved tools.
- Full lint/type/unit/build/critical browser suites plus regression tests from PR216.

## Sources checked
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/deploy/app-review


## Source implementation progress, 2026-10-02

The original matrix remains the target, not a blanket completion claim. v2 supports independent Prep/manual Action/ApplicationGroup; v3 adds bounded Opportunity profile edits and aggregate archive/restore; v4 adds exact Decision Rules/time-preference management; v5 adds exact Discovery Profile patch/reset/restore. See `../management/planning-v4.md` and `../management/discovery-profile-v5.md` for limits and independent consent gates. Source integration does not activate these new scopes. Process/event corrections, linked/derived Prep/Action reconciliation, broader schedule operations, inbox archive/tombstones, private reminder policy coverage, material storage and archive-browsing remain incomplete. Existing semantic commands retain their prior capabilities; this inventory does not disable them or authorize external actions.

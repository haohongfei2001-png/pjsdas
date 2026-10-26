# Stage A: row-capable persistence candidate — NOT DEPLOYABLE

This branch is an isolated implementation experiment, not a production migration. The transactional store has an explicit reader/writer bridge injection, but no deployed caller supplies it; there is no environment switch. Both candidate switches (`readsEnabled`, `writesEnabled`) default to false; writer use requires reader capability. No production environment variables, resources, credentials, table layouts, or permissions are changed.

## Implemented vertical slice

- Lossless JSON-wire entity codec: complete entity values, array ordinals, manifest presence/count and unknown envelope fields. Object key order is irrelevant to diff; array order is not. Missing collection, empty collection, explicit null and omitted undefined follow the existing JSON contract.
- HTTP candidate adapter using header → bounded keyset pages → final generation/revision fence, then the existing snapshot validator. One attempt fails closed; it does not introduce unbounded retries or change worker budgets.
- An isolated SQL schema with UUID generation, schema-version downgrade protection, serialized CAS, exact entity preimages, immutable command receipt/compensation and typed collection validation. The command audit retains principal/client, original provenance, expected revision/effective time and caller-generated lifecycle/affected-object context; SQL-owned status/identity/revision/Undo availability override caller context. The narrow Gmail entry accepts only its original automation/source. A separate trusted-core base entry preserves the existing service-side semantic boundary, but rejects guarded families and their protected Undo targets; those must use the dedicated SQL entry. Separate planning and discovery-profile entries use the real existing management-grant schema and their current legacy RPCs as differential oracles, including protected data/audit, Undo-family binding, revocation in both lock orders and regrant receipt replay. This SQL does **not** independently prove a caller supplied the complete semantic effects.
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
- Production-shaped transport candidate: 15 explicit `public.pjsdas_rows_v1_*` invoker wrappers, created and revoked/granted atomically in the disposable fixture. Only existing `service_role` can execute; `anon` and `authenticated` are denied. A second real PostgREST instance exposes **public only** and runs the actual central store, capture, bootstrap, all six management families and controlled Gmail recovery through `/rest/v1/rpc/` (local fixture removes only the gateway prefix). The implementation schema remains unexposed; no dashboard exposed-schema change is assumed. Public wrappers additionally require the activated owner/epoch, unlike intentionally shadow-capable private experiments: pre-activation public reads/writes fail closed. This read-only preflight adds no lock-order inversion; the guarded writer still rechecks generation after original authority locks. These are source-only candidates, not applied production functions. Production cache reload, gateway limits and activation remain separate gates.
- `read_head(target_user_id)` returns owner/workspace, UUID epoch, revision, layout, envelope and manifest.
- `read_page(target_user_id,target_workspace_id,target_epoch,target_revision,after_collection,after_ordinal)` binds page and head to one SQL statement snapshot. Ordered `(collection COLLATE "C", ordinal)` pages contain at most 127 rows; oversized returned page is rejected. Gateway also checks owner/layout/epoch/revision/order/count/completeness and final head.
- `commit_rows(req)` admits only `gmail_semantic_intake` / `automation` / `gmail:primary`. The generic entry rejects management, AI-capture and Discovery authorizations before mutation; the planning/profile/reminder/opportunity/business entries separately validate their real version-4/version-5/version-6/version-3/version-7 grants. Its low-level row primitive lives in a private schema not exposed by the HTTP server. Per-command payload binding, original receipt replay across retained and current ledgers, CAS/preimage, structure and compensation persist in one transaction. Conflicting same-ID histories fail closed; a command committed before cutover cannot be applied again afterward. Persistent business conflicts use explicit PT409 rather than serialization SQLSTATE40001, preventing transport-level automatic transaction retries for a condition that cannot resolve by retrying the same request.
- Management grant authorization is checked before replay; an already-applied command retains the original immutable grant receipt even after valid regrant, while a new commit must bind its current grant.
- Candidate request/row caps are experiment limits, **not approved new product limits**. Large singleton/entity/page behavior still needs production-contract decisions. Post-response byte checks are not a hard server memory bound. Complete snapshot assembly still uses application memory.

The opportunity guard projects only its six affected collections plus application-group/outbox dependencies and reuses the existing validation rules; retained timeline history is checked by append-only effects, not fully aggregated. Large affected collections can still incur aggregation costs: this is not a zero-temporary-IO guarantee. Ambiguous same-ID histories across the experimental and retained ledgers fail closed; a production shared-ledger migration is not implemented.

AI admission must use the row-aware head after layout activation: continuing the old admission RPC would read a stale retained blob revision even if confirmation were adapted. The candidate includes an epoch-fenced admission entry preserving the existing policy/one-reservation checks; settlement remains the existing layout-independent function. The actual central capture ledger now routes admission to this entry using bounded identity reads, rejects duplicate/uncertain admissions before any model dispatch, and confirms/replays through the actual command executor over synthetic HTTP. Production configuration and complete mixed-version rollout remain release gates.

Discovery requires original command provenance, not only receipts. Its private candidate history view combines retained and new records only after checking duplicate identity consistency. The candidate acquires the original workspace lock before its row head for shared history admission; that lock alone is not old-writer exclusion. The separate isolated layout-fence fixture supplies the exclusion proof described below. Tests use synthetic terms and injected HTML, never external search or model calls. Differential management oracles run under a separate synthetic owner with an explicitly mapped grant UUID: otherwise comparing both implementations under the same owner/command would incorrectly test a duplicate application rather than two independent commits. Original authority state and business input remain equal; actual grant-revocation races use the unmodified candidate grant.

The isolated layout-fence fixture now patches the **actual existing public RPC definitions** in the disposable database, preserving owner/ACL/security/RLS. Activation binds the staged epoch, schema and revision and compares the retained original blob exactly; this one-time comparison is not a normal-write cost claim. Old v1–v4, all six management guards, bootstrap, AI/Discovery, 305 checkpoint/drain and direct legacy table writes fail closed after activation. Actual two-session races prove blocked old v3/305 calls cannot cross activation, while an old write winning first prevents stale-stage activation. An unversioned raw edit also prevents activation. A real pending 305 run survives logical staging and a subsequent row commit.

This catalog-derived fixture is **not production migration DDL**. No product activation/seed service, recovery RPC or production feature flag exists. Direct service-role raw SELECT can still return the retained blob: central store/export/backup routing and complete old-backend retirement are mandatory, not solved by a write trigger. The logical-snapshot helper rejects active layouts rather than returning stale data. Candidate shadow mode before activation is only for differential tests; a product router must require a verified active epoch.

## Required writer/read compatibility matrix

| Existing entry | Candidate status | Required before activation |
|---|---|---|
| workspace v1/v2/v3/v4 | REAL OLD-CALL FENCE PROOF | Old calls/replays reject active layout, including lock-wait cutover races; central default-off bridge and original replay/current-snapshot semantics have real HTTP proof; complete product route enablement remains open |
| bootstrap + consumer bootstrap | CENTRAL HTTP PROOF | Old calls reject active layout; current logical existing-bootstrap response and original allowlist/empty-input checks pass without overwrite |
| management v2 | CENTRAL + GUARD HTTP PROOF | Existing broad v2 authority, actual core commit/Undo/replay and revoked grant rejection; v2 cannot replay or Undo v7 commands and no grant promotion is introduced |
| opportunity v3 | CENTRAL + GUARD HTTP PROOF | Actual profile/archive/Undo core and legacy differential; retained order/source facts/audit, exact dependency closure, grant and revoked replay; activated central command/Undo/readers pass; production rollout remains open |
| planning v4 | CENTRAL + GUARD HTTP PROOF | Real grants, protected data/audit, Undo binding, both revoke orderings and regrant replay pass; activated central command/Undo and original grant reader pass; production rollout remains open |
| discovery profile v5 | CENTRAL + GUARD HTTP PROOF | Real current profile core/restore, scoped grant, protected fields/audit, Undo binding, both revoke orderings and replay pass; activated central command/Undo and original grant reader pass; production rollout remains open |
| private reminder v6 | CENTRAL + GUARD HTTP PROOF | Actual reminder create/restore and legacy differential; target/version/dedupe, null capability fields, immutable external/outbox values and protected relative order; activated central command/Undo and original grant reader pass; production rollout remains open |
| consumer business v7 | CENTRAL + GUARD HTTP PROOF | Actual active action/group create/update/archive/Undo; exact v7 consent hash, evidence/preimages/order, protected raw data/version, revoked replay; retired preparation creation stays disabled |
| durable AI capture | CENTRAL + GUARD HTTP PROOF | Layout-aware at-most-once free-policy admission, existing settlement, actual semantic core and atomic preview consumption; injected terminal failure rolls back rows/ledger/preview, wall-clock expiry after lock wait and consumed replay pass; no model/provider call |
| Discovery commit | CENTRAL + GUARD HTTP PROOF | Real verifier/domain facts and grant/automation authority; retained-history cap and original claim/settlement, exact-copy history de-duplication, ambiguous histories fail closed, real two-session cap/CAS race, declined holds cannot record successful facts; the activated central store repeats this entire matrix through public-only RPCs; scheduler configuration remains off |
| Gmail normal semantic write | CENTRAL SOURCE HTTP PROOF | Actual nonempty domain batch through the existing source/store, small row request, original audit/receipt and lost-response retry; the actual controlled worker now proves lease/binding/assert/commit-first/finish and new-run recovery over local HTTP; production rollout remains open |
| 305 empty checkpoint/drain | ISOLATED CUTOVER PROOF | Real pending logical absorption and old-inflight rejection pass; the controlled worker creates row adapters from its budget-bound fetch; rollback release remains open |
| central store/readiness/export/backup | CENTRAL READ HTTP PROOF | Explicit reader injection performs metadata-first layout routing, full logical read and final epoch fence; logical history combines retained/current receipts with fenced keyset pagination; legacy write routes reject active layouts. Header-only readiness and existing bootstrap authorization are tested without stale-blob fallback; production enablement and recovery/export verification remain open |
| direct old table write | REAL TABLE FENCE PROOF | Actual legacy table UPDATE/DELETE, even no-op or marker removal, reject after activation; original permissions preserved; raw SELECT still needs routing |

Rejected does not mean implemented. Tests deliberately prevent an unsupported family from silently falling through to the generic candidate.

## Recovery and rollout hard gates

The central store reader is tested over real PostgREST HTTP with only the Supabase gateway path prefix rewritten locally. It reads current row revision rather than the frozen old table revision. Missing schema, malformed metadata, mismatched owner/epoch and cutover during a legacy read fail closed; none cause a silent blob fallback. The same injected store reads command identity, Undo history and Discovery progress from the combined logical ledger. A 260-command synthetic fixture proves no one-page truncation; conflicting duplicate identities and mixed-generation pages are rejected. The explicit bridge now binds server-read preimages and dispatches all guarded families to their dedicated entries. Real HTTP runs the actual central executor and workspace source for nonempty Gmail, ordinary domain write/Undo, and all six management grant families after layout activation. Every family uses its real grant HTTP reader, dedicated SQL guard, original receipt replay, exact Undo, and revoked replay/Undo rejection. Original lost-response retries retain their original expected revision and return the original receipt with current logical state. A stale request can only replay or conflict, not replace newer state. The synthetic large-snapshot test submits under 100 KB per tested commit; this is not a production latency or capacity claim. The old 305 optimization declines active rows without touching progress, allowing the existing normal semantic path instead. Existing bootstrap keeps current row state without resending or overwriting the large initial blob; consumer empty-start still checks the original allowlist and empty-input contract. Header-only readiness uses one shared deadline and never infers an approved search budget. The actual capture ledger admission/finish/confirmation path is exercised without any provider call. The actual controlled Gmail worker now runs a synthetic nonempty provider batch against real claim/lease/assert/commit/finish RPCs. Both a lost successful commit response and a finish failure before execution preserve the cursor; a new run re-reads actual receipts and completes without a duplicate business commit. This retains commit-first/replay safety, not a falsely claimed atomic cursor-plus-business transaction. Its injected row adapter is created from the worker budget-bound transport, so row requests cannot bypass the existing deadline. Synthetic provider responses do not prove live Google behavior. Public-schema transport is proven locally; actual platform limits, remaining activated caller integration, full migration/recovery and two independently usable rollback builds remain open, so this is **not yet a complete row-compatible release**.

Two independently usable **row-compatible** releases must exist before any canary. Rolling application code back must retain the active row layout and support all business writes; simply disabling reads or returning to old full-snapshot RPCs is unsafe. Restoring an old blob is a separate full-materialization operation and may reintroduce the original cost. No immediate blob rollback is claimed.

Stage A must still prove all real guarded writers and old calls, 305 pending absorption/cutover, immutable history, grant revocation races, original Gmail commit-first/finish recovery, actual production-route transport limits, migration crash recovery, resource capacity and a viable row-compatible rollback release. No new paid capacity or time-budget increase is assumed.

Only after a frozen exact DDL/ACL/layout/rollout/recovery change set, all applicable tests, and separate explicit production approval can this leave the experiment stage. This candidate must not be merged or deployed as a new production layout based only on the vertical-slice tests.

## Dormant shared runtime

`PJSDAS_WORKSPACE_ROWS_READS=1` constructs the public-schema row reader in the central store/source and capture ledger; `PJSDAS_WORKSPACE_ROWS_WRITES=1` additionally supplies its writer and requires reads. Both default off. These flags do not create tables, expose a schema, migrate data, activate an owner, or authorize spending. Explicit server adapters are never mixed with ambient writers. Every instance retains its supplied fetch closure, including the controlled Gmail deadline. The actual central HTTP fixture exercises these normal constructors with only local process flags, not manually injected row adapters. A failure-first fixture caught a missing stored-schema preimage in the source's initial runtime wiring; source and store now resolve the same capability before reading.

For any activated owner, reads must remain on in both rollout and rollback releases. Turning reads off or deploying an old backend is **not** a recovery action. The SQL old-writer fence does not make direct raw `SELECT` safe; all active backend callers must be row-capable before cutover. No production flags were changed by this candidate.

## Local migration and resource admission evidence

The local-only driver uses an explicitly owned loopback fixture database, one
transaction and a locked legacy workspace. It copies the logical state without
normalization, verifies a full lossless keyset readback, and only then activates
the epoch marker. Actual connection loss at six durable boundaries leaves no
partial head, entities or marker. A lost post-COMMIT acknowledgement resumes as
already active without importing again. This is a synthetic transaction proof,
not an approved production migration runner or a full backup/restore drill.

The resource fixture measures fresh table + index + TOAST sizes for the same
synthetic content. It counts **both** the original blob and the head's retained
legacy copy, plus items and ledger. Highly compressible synthetic content can
make the old blob much smaller than separate rows. These figures cannot predict
production headroom; migration copies, WAL, subsequent ledger growth, vacuum and
rollback releases require a separate capacity decision. No extra capacity has
been purchased or assumed.

Failure-first real HTTP tests exposed three accepted writes that became
unreadable: a header over the reader limit, a single oversized entity, and many
ordinary entities exceeding a fixed-count page. Candidate admission now rejects
unsupported postimages before mutation (also atomically in SQL), while ordered
pages stop at a byte boundary rather than aggregating 127 unbounded values.
Short nonempty pages advance the same revision/epoch-fenced cursor. The current
1 MiB header/entity-page, 32 MiB total row representation and 65,024 entity bounds
are **experimental eligibility limits, not approved product quotas**. The
complete persistence contract, including history and production eligibility,
remains an activation gate. Two independently usable row-compatible release
artifacts are still required; none of these tests authorizes cutover.

The same failure-first check covers immutable audit records. History pages now
use an explicit byte-bounded continuation (including the original Discovery
cycle ordering and 161-record overflow sentinel), rather than assuming that
127 receipts are small. Individual audit rows must fit the candidate's 2 MiB
history page; an oversized new receipt rolls back the entire write, and an
ineligible retained receipt prevents local migration before activation. A large
supported receipt, multi-page Undo history and multi-page cycle history are
checked over real HTTP. The 32 MiB per-history-read budget remains an explicit
resource gate, not a claim that every existing or future history query fits.
This does not authorize pruning history or introducing a user-facing quota.

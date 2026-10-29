# Staged protected-command coverage: local matrix and v3 slice

**NOT DEPLOYABLE.** A server-owned default-off runtime route and local candidate
public RPC wrappers now exist; no production migration/configuration is applied.
All original A/B fast-path thresholds remain unchanged.
This matrix follows `transactionalWorkspaceStore.ts`, `workspaceRowsCandidate.ts`
and the actual candidate guard SQL, not operation names invented for the protocol.

| Existing family / authority | Required final lock order and original invariants | Staged coverage |
| --- | --- | --- |
| First-party `abandon_opportunity`, original Undo | Owner head → stage; original-command family, epoch, CAS, complete preimages, original compensation and immutable receipt | Actual API entry: 2,102-effect complete V5 abandon, staged original Undo/replay; head-before-stage ordering shared with protected finalize |
| Opportunity management v3 / `workspace.opportunity.manage` | Original grant SHARE → owner head UPDATE → stage UPDATE. Exact owner/client/revision/capability/consent, complete reviewed dependency closure, raw source facts, unaffected rows/presence, retained order, append-only history; original-ledger Undo evidence and ambiguity refusal | Frozen effect-only proof: 2,053/2,052 effects. New actual scoped runtime: complete V5 compact-ID archive/Undo stages both; long-ID audit counterexample remains unsupported. Original ≤2,500 changes / ≤1 MiB evidence and cached-replay authority retained |
| Broad management v2 / `workspace.manage` | Original v2 grant SHARE → head; cannot use or replay v7 authorization; current domain-core retirement restrictions remain authoritative | Not staged. Must retain original v2/v7 family separation and legacy replay semantics |
| Business management v7 / `workspace.business.manage` | Original exact consent text/version/revision/client grant SHARE → head; raw protected facts, selected-row evidence and dependency closure, exact original Undo evidence | Not staged. Do not route through v2 or the v3 guard |
| Planning management v4 / `workspace.planning.manage` | Grant SHARE → head; current time-preferences header and appended audit only; original historical Undo family, never re-enable retired scoring writers | Not staged. Legal one-effect header/compensation counterexample below; byte codec is not final SQL authority |
| Discovery-profile management v5 / `workspace.discovery-profile.manage` | Grant SHARE → head; only discovery profile header and appended audit, original Undo family | Not staged; no generic management bypass |
| Private reminder management v6 / `workspace.reminders.manage` | Grant SHARE → head; exact private/in-product reminder permissions, protected outbox/provider state, original Undo authority | Not staged; an external-delivery capability must never be inferred from upload |
| AI capture `ai_capture_confirm` / first-party durable preview | Head UPDATE → preview UPDATE; exact request/observation/revision, READY expiry via wall clock after locks, COMMITTED command binding, original immutable replay; preview consumption atomic with row effects | Not staged. Admission separately locks head → funding policy, reserves once, retains uncertain provider reservations. No provider request/budget relaxation belongs in staging |
| Discovery `ingest_verified_discovery`, automation-only `checkpoint_discovery_search` | Connection/consent or source-bound grant SHARE → retained workspace UPDATE → row head UPDATE; exact generation/subject/client/source; original claim/settlement identity, cycle/batch ordering, immutable funding hold and wall-clock budget window | Not staged. Upload cannot claim a batch, settle a cursor or reserve a second hold. Empty checkpoint cannot mutate business rows |
| Existing-row bootstrap / explicit consumer empty-start | Optional current audience SHARE → active owner generation lock; existing generation returns EXISTS, never overwrites/imports supplied data | Not a generic bulk-write operation. Fresh import/migration and huge materialization remain separately gated |
| Gmail / automation lease and consent, plus other first-party domain operations | Existing worker/central route, exact owner and original command/Undo authority, epoch/CAS and receipt semantics | No additional staged family is claimed here. A valid first-party operation is not automatically an allowed staged operation |

## Why v3 is the minimum useful protected slice

The existing pure `applyOpportunityManagement` accepts a reviewed archive with
2,050 existing owned actions. It produces 2,053 row effects (including an ordinal
shift of a retained opportunity and the new audit row). Its original compensation
has 2,051 changes and is 718,732 UTF-8 JSON bytes; the input also fits the original
256 KiB command bound. `restoreOpportunityManagement` returns 2,052 effects and
preserves the appended history. The original legacy SQL accepts both. The row
fast path refuses the valid archive because its existing cap is 2,000 effects.
This is capability parity, **not a new product limit or a reason to raise caps**.

## Implementation boundary

- `large_begin_opportunity` binds an immutable family/owner/epoch/request/hash and
  grant ID/revision/client proof. Staging deliberately does **not** cache an
  authorization decision or return a cached command receipt from begin. Ordinary
  roles cannot use the staging surface.
- Upload appends exact ordered effect wires only. No business snapshot, revision,
  preview, cursor, budget hold or command receipt changes until finalization.
- `large_finish_opportunity` initially reads stage metadata without taking its
  lock, then enters the complete original v3 guard. The original grant is locked
  before the head; the stage lock is last. First-party finalization now also takes
  head before stage. Begin/append never acquire head or authority row locks while
  holding a stage lock. Future cleanup must respect this order too.
- The complete existing v3 semantic guard is retained. A source-parity test
  removes only the explicitly named transaction envelope and effect-relation
  adaptations and demands exact equality with the original guard. Effects come
  from a set-returning relation, not a reconstructed all-effects JSON array.
- One SQL transaction applies every effect, checks the final complete state and
  writes one original-format receipt/compensation. A stage cache is not permission:
  even a completed stage must recheck current grant and original Undo family.
- The original guard still builds its affected-collection projections and bounded
  evidence arrays. This is **not constant-memory finalization**, and no latency,
  disk/WAL reduction or production capacity claim follows from paged upload.

## Migration stopping conditions are still mandatory

`stagedPrototypeMigrationDecision()` remains ineligible. Unsupported protected
families, complete large-header/entity APIs, compensation/history materialization,
staging reservations/cleanup/retention and the original protocol compatibility
pair are unresolved. Even v3 is not declared universally covered: its existing
1 MiB compact evidence limit can fit a legitimate command whose combined staging
metadata (including JSONB text overhead) exceeds the prototype 1 MiB admission.
The frozen effect-only slice did not solve that case. The new complete-document
protocol removes that transport barrier but not the original full-audit reader
bound: the actual V5 2,053-effect archive is still refused atomically, while the
separate byte-large 1,803-effect V5 archive and original fastpath Undo pass. A
third compact-ID legal V5 fixture stages both 2,053-effect archive and 2,052-effect
Undo through the real scoped runtime, preserving all fields. Neither result
narrows the original product contract. The experimental stage count/byte/expiry controls remain
local resource controls, not approved product quotas. Do not use current-state
fit, this v3 proof, or the previous A/B compatible builds to authorize activation.

Old-reader retirement, final static DDL/ACL/owner/RLS review, independently proven
production capacity and two hosted staged-compatible rollback builds remain
separate prerequisites. No old blob fallback or rewrite is added. The original
production saving problem is not declared fixed by these local tests.

## Verified local gates

The native `workspace-rows-staged-opportunity-prototype.mjs` proof uses a fresh,
owned loopback PostgreSQL/PostgREST database. It verifies original legacy/core
output, unchanged fast-path refusal, complete staged upload, real disconnect
rollback, concurrent single receipt, original Undo and reverse-order refusal,
revocation/regrant, observed authority/head lock waits, expiry after waiting,
late preimage rollback, cross-ledger ambiguity and retired epoch rejection.
Its configured `work_mem` is 2,184 KiB; this is synthetic stress evidence only.

The original large-abandon/byte-fragment native proof also passes. The complete
existing row/central/worker/public-transport/migration/native matrix passes,
including the independently frozen serial A source interoperability test. That
A/B test is **not** a staged-compatible hosted rollback pair. Full unit suite:
386 files / 5,085 tests passed. TypeScript passes. No assertion, original fast-path
limit, domain evidence bound, timeout or provider budget was relaxed.

## Subsequent integration evidence: do not overread the frozen checkpoint

The preceding native/full-suite results belong to frozen `d036b343…`, not the
new inactive-reader/document-protocol integration branch. The new actual application
entry now routes only the independently proven first-party abandon/Undo and v3
opportunity/Undo families through the server-owned default-off staged factory.
The real complete V5 abandon receipt exceeded the old prototype's 1 MiB metadata
admission even when its individual effects fit; complete document fragments now
preserve it without stripping receipt or compensation fields. Earlier compact V2 direct-RPC fixtures did not prove
full handler receipt parity. See [complete document protocol](workspace-rows-staged-documents-protocol.md)
for exact original V5 preservation and the handler → core → authority → bridge →
upload → one final transaction → original receipt/Undo dependency chain.

| Family | Proven effect-count statement | Why that does not prove unconditional fast-path eligibility |
| --- | --- | --- |
| Current Planning v4 | One audit append; original header-only Undo has zero row effects | Legal three retained configuration values, each 262,100 B, yield delta+compensation 2,098,867 B; complete authority/receipt is additional. Metadata/header/compensation fragments required |
| Discovery-profile v5 | One audit append; header-only Undo has zero row effects | Complete before/after headers and retained compensation still count; no complete 2 MiB request bound is proved |
| Private reminder v6 | Forward ≤25 selected reminders + one audit; update-only Undo ≤25 effects | Creation Undo deletes a row; later unrelated appended rows can shift ordinals. Input operation count is not a deletion/Undo effect bound. Complete header/images/compensation bytes still unproved |
| Opportunity v3 | Legal archive fixture already has 2,053 effects | Complete V5 receipt/header/evidence bytes are independent of count; existing evidence bound does not imply old begin metadata fit |
| First-party abandon | Legal real-handler fixture has 2,102 effects | Complete persisted V5 metadata also exceeds old begin admission, independently of effect upload support |
| Other management, AI capture, Discovery, Gmail | No unconditional full-effect/full-byte proof established | Original closure/order/lease/budget/preview guards remain mandatory. Do not infer a cap from selected input count or route generic INVALID to staging |
| Existing-row bootstrap | Existing generation is authorization/replay, not a bulk rewrite | Import/materialization is a separate capability; no staged bootstrap overwrite is authorized |

All size classifications must examine the **complete validated request**. Compact
JSON below a limit also does not establish SQL JSONB-text below that limit. No
claim above removes original header/entity/history/compensation reader stops.

Inactive reads have a separate minimal [unconditional bridge patch](workspace-rows-inactive-reader-integration.md).
Its real API-entry/native HTTP test includes inactive full-v4 with narrowed raw
snapshot ACL and active-reader refusal. It is not a hosted A′/B′ rollback pair.

## Current local integration verification

The integration branch passes **389 unit files / 5,140 tests**. The original
large-command native proof (including strict apply-check parity), original v3
native proof and complete Stage-A/native central/worker/public/migration matrix
also pass. A separate public-only native run exercises the actual server entry,
complete V5 metadata and original authority in both staged directions, narrowed
inactive-read ACL, the compiled A′ reader entry, cancellation/lost-response and
persisted-byte integrity failures. These are local synthetic correctness gates,
not production rollout, capacity or end-to-end latency approval.

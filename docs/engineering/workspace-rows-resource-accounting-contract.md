# Resource accounting — executable local mechanism, not activation

Base: `25a45ff1eda1d8cf1cb02f2e84f73886be70df9f`. The new pure module is
`gateway/workspaceRowsResourceAccounting.ts`; its new focused test is
`tests/workspaceRowsResourceAccounting.test.ts`. No existing runtime, reader,
authority, SQL, migration, ACL, credential, provider or configuration is changed.
Nothing imports the module in a product path. No production resource is allocated.

## What this implements (and what it does not)

A deterministic, serializable, immutable metadata state machine implements exact
admission, cumulative held/occupied byte accounting, precharged idempotent append,
terminal resolution, two-phase reclamation and inventory reconciliation. It is
**default off**. Enabling requires explicit safe-integer `commandBytes`,
`ownerBytes`, `globalBytes`; zero deliberately means deny-all. There are **no
numeric defaults**, new production expiry/retention/fairness rules, environment
flags, automatic deletion, or implicit reservation minting. The existing fixture
8 MiB reservation and SQL prototype intervals are not adopted as product policy.

This is not a DB transaction, authorization check, running collector, memory/disk
hard limiter, physical-space estimator or production concurrent-capacity proof.
It neither stores nor reads a receipt, compensation, projection delta or document
body. IDs/hashes in this API are metadata, not evidence that bytes exist. Trusted
adapter observations below must be established outside the reducer, under the
specified atomic fences. A caller-supplied `fenceId` is not a security proof.

## Existing identities/fields, preserved rather than replaced

| Existing source | Existing field/semantics | Sidecar mapping/limitation |
| --- | --- | --- |
| `large_document_reservation` | `stage_id`, `user_id`, `workspace_id`, `reserved_bytes`, `expires_at` | Same `stageId` primary identity, owner/workspace, admitted bytes and exact expiry converted to milliseconds; no new stage ID or widened reservation |
| `large_command_intent` | PK `(user_id,command_id)`; unique `stage_id`; `identity`, `binding`, `encoded`, `deadline_at` | Same command uniqueness and complete binding, `preparedSha256`, `manifestSha256`, original absolute `deadlineAt`; no epoch-based budget reset |
| `StagedRequestBinding` | stage/family/user/workspace/epoch/revision/command/payload/operation/principal/authority | Imported type, all fields compared structurally on every operation; grant is the original grant/revision/client, never a substitute regrant |
| `large_document_bundle` / fragment | `manifest_sha256`, `next_offsets`; `(stage_id,document_name,byte_offset)`, `bytes` | Stable document allocation ID and byte offset/digest. Exact duplicate consumes no second charge; existing protocol fragment length rules remain external |
| `large_stage` / effect | `received_bytes`, `next_ordinal`, `rolling_digest`, `final_digest`, `result`; `(stage_id,ordinal)`, `wire`, `effect` | Wire and JSONB are separate occupied representations, not aliases. Existing received_bytes counts wire only; do not claim it counts whole storage |
| `createAuditSpool` | request-local provisional file, request-finally disposal | Each simultaneously live process/request copy needs its own allocation ID; file disposal alone is not durable ledger release |

The sidecar's one command reservation may contain many independently named
allocations; `reservedBytes` must cover their **sum**, not merely the maximum of
decoded intent or documents. Existing SQL checks each shape independently against
a prior reservation and are **not already a cumulative admission implementation**.
A future atomic adapter must prove/migrate this difference before using this API.
Existing reservations/partial stages cannot be silently reinterpreted as empty
accounting records. Inventory first; insufficient preapproved capacity fails
closed. The pure mechanism cannot grant service-role the currently absent right
to mint reservations.

This slice covers a staged command's existing reservation. It does not fabricate
a stage identity for arbitrary standalone history reads. Their admission needs a
separately reviewed adapter/namespace and unchanged original audit authority.

## Units and accounting

All numbers are nonnegative **safe integer bytes**, never characters/base64 code
units. Each admitted reservation is charged at full `reservedBytes` to the global
pool, owner `userId`, and command `(userId,commandId)` until release. Overflow
fails closed; JSON round-tripping cannot lose integer precision. Cross-owner equal
command IDs are distinct; same-owner reuse across workspace/epoch/stage is refused.

`resourceTotals` derives three values without trusting cached aggregates:

* `heldBytes`: sum of unreleased reservation capacities (the admission budget).
* `occupiedUpperBoundBytes`: all precharged pending/present allocation chunks not
  yet acknowledged physically absent. A missing pending write remains charged.
* `confirmedPresentBytes`: the subset whose exact writes were acknowledged.

Always `confirmedPresentBytes <= occupiedUpperBoundBytes <= heldBytes`.
**Do not add heldBytes and occupiedUpperBoundBytes**: that double counts occupied
capacity. Each separate encoded/decoded/wire/JSONB/spool copy is charged separately.
`intent-encoded`, `intent-decoded`, `document-fragments`, `effect-wire`,
`effect-jsonb`, `audit-spool`, `storage-overhead` are explicit kinds. The adapter
must choose and document exact measurement for each representation; actual DB row,
index, WAL, allocator and filesystem overhead is **not magically included** in
logical byte lengths. A physical-space guarantee needs its own measured envelope.
This metadata model retains records/tombstones and is not an unbounded-scale
production data structure or a policy for metadata retention.

## API and transition table

```
createResourceLedger(configuration?)                 // disabled by default
transitionResourceLedger(state, expectedRevision, action, now)
restoreResourceLedger(serializedSnapshot)             // blocks new bytes
inspectResourceInventory(state, observedEntries, complete)
resourceTotals(state) / assertResourceLedger(state)
```

Every transition validates the snapshot, exact binding and safe integers; it
returns a fresh deeply frozen state or the unchanged state for a replay. Failed
transitions leave the original untouched. `expectedRevision` must match even for
replays. The adapter atomically persists its successor with compare-and-swap;
two successors computed from the same snapshot must never both be installed.
`disabled` means this mechanism did nothing, **not** an admission/authorization.
The adapter owns a trusted clock; client timestamps cannot extend either deadline.

| Action | Preconditions | State/accounting effect |
| --- | --- | --- |
| `inventory` | Exact-revision, complete consistent namespace scan under a write/finalizer fence | Verified scan permits new admission/append; any orphan/mismatch/missing-confirmed/incomplete scan blocks them. Does not delete or reduce charge |
| `admit` | Verified inventory; original binding/reservation authority; now before both exact absolute dates; all three capacity tests | `open`; charge full reserved capacity atomically. Exact duplicate returns original state, including stopped/released tombstone; changed immutable identity/bytes/deadline refused |
| `append` | `open`, inventory verified, neither deadline reached; stable allocation kind/ID; contiguous byte offset; exact digest/length | Persist pending precharge **before physical allocation**; repeated exact slot does not charge twice. Overlap/gap/changed duplicate refused |
| `confirm-append` | Same writable guards, exact precharged slot/length/hash | Pending -> present; upper bound unchanged. A late acknowledgement after stop cannot reopen bytes |
| `begin-finalize` | New original attempt only while writable | Persist `finalizing` marker **before dispatch**. Only `applied` with resulting phase `finalizing` is a new dispatch permit |
| `mark-unknown` | Same persisted original attempt | `finalizing` -> `unknown`; full capacity retained |
| `stop` | cancellation/process-crash, or actual expiry of either original date | `open` -> `stopped`; `finalizing` -> `unknown`. Never establishes rollback or frees bytes |
| `resolve` | Exact reservation revision; original authoritative command lookup and permanent terminal finalizer fence | `committed` or `not-committed`; no free capacity. Committed proof requires retained original receipt/projection/compensation |
| `begin-reclaim` | Resolved outcome, exact reservation revision, independent physical `writerFenceId` | `reclaiming` with stable reclaim ID; no release. All old DB/file writers are stopped/fenced, not just finalizers |
| `confirm-removed` | Same reclaim ID/fence; trusted exact namespace absence after deletion | Mark allocation absent, reduce occupied/confirmed only, keep capacity held |
| `release` | Same reclaim ID; every allocation acknowledged absent | `released`; reduce held capacity once; preserve binding and tombstone; never re-admit original identity |

An exact `begin-finalize` retry with the same attempt ID can return the current
`unknown`, resolved or released record. This is **not** permission to dispatch
again. Likewise an admission replay of a released record is not a live capacity
grant. The caller must inspect phase/disposition. A pending precharge is not
proof of complete documents: all existing SQL reconstruction/hash/shape/current
authority/CAS/original Undo checks remain mandatory and in their original order.

## Physical bytes and the two different fences

For DB-backed bytes, precharge + exact slot insertion + confirmation may be one
atomic transaction. A duplicate verifies the stored exact bytes before ACK, as
the existing SQL does. Byte-identical hashes in this model do not replace that
comparison or whole-document hash validation.

For filesystem/decode buffers, persist precharge first, then write to an exclusive
immutable `(stageId, allocationId, offset)` address with exact idempotent
conditional-write semantics. **Do not call an unconditional append on replay**.
A second concurrent copy requires a new allocation ID and its own precharge.
A crash after precharge and before a write conservatively leaves pending charge;
a crash after writing and before acknowledgement does the same. Inventory can
observe these bytes but never uncharge a missing pending slot automatically.

There are two independent terminal facts:

1. **Finalizer fence / original business outcome.** In the same locked transaction,
   revoke all future finalization of this immutable stage, drain/serialize any
   already dispatched finalizer, and inspect the original authoritative command
   ledger. Absence before that fence is not rollback evidence. Network timeout,
   cancellation, lease expiry, stale CAS, HTTP failure or a missing `large_stage.result`
   is not enough. A committed observation must retain the immutable original
   receipt, projection delta and compensation used by replay/history/Undo; reading
   it still requires the current original authority. Its actual resultingRevision
   comes from the original ledger, not an assumed expectedRevision + 1.
2. **Physical writer fence.** Before reclamation, stop/join or permanently fence
   every writer with a precharged pending write. A stale worker must be unable to
   recreate a deleted namespace or append through an open handle after absence
   acknowledgement. `writerFenceId` is separate evidence bound to the exact
   reservation revision. An original-ledger outcome alone does not prove this.

Only then persist the reclaim intent, remove **temporary owned copies**, verify
absence, and persist each acknowledgement. A crash after deletion but before ACK
repeats the same idempotent deletion/absence check; it does not assume success.
Retained business ledger rows, original receipt/projection/Undo compensation,
raw historical audit blobs, and any sole unresolved recovery copy are **never a
deletion target** of this resource module. Unknown-finalize records remain pinned
indefinitely until a legitimate resolver establishes their outcome; this slice
chooses no retention TTL or destructive “eventual cleanup” shortcut.

## Required atomic lock/transaction integration (not yet implemented)

Existing supported paths use original authority/grant -> workspace head ->
`large_stage` -> document bundle; upload currently locks stage/bundle only. The
current pure model does not change those paths. A safe future sidecar integration
must update **all** participating writers/readers/reclaimers consistently:

1. Perform the existing read-only `require_active_layout` preflight and original
   authority gate before releasing any bytes; acquire the original grant/share
   lock for v3. Do not add the resource lock before that authority lock. The
   public preflight is read-only; the later `assert_row_generation` metadata lock
   is distinct. Never replace authority with a cached accounting decision.
2. Acquire a **global accounting serialization lock**, then owner, command and
   reservation sidecar locks, sorted by exact stable identities if a transaction
   touches multiple keys. No existing workspace-metadata/head/stage/payload lock
   may already be held when first acquiring the accounting lock. Prefer one
   command per transaction. A multi-owner collector must pre-acquire every
   required original authority lock in a globally consistent order, or split
   into per-command transactions; it must never hold global accounting and then
   discover/acquire a new authority lock held by a writer waiting for global. The simplest correct initial adapter
   serializes all resource mutations globally; this is a correctness baseline,
   not a fairness/performance promise.
3. Acquire the original `pjsdas_workspaces` metadata lock where the family
   requires it, then candidate workspace head -> stage -> bundle/payload locks
   (with original grant locks already held); revalidate owner/generation,
   reservation expiry, original deadline, identity and current authority after
   waiting. Upload paths must adopt this ordering; merely adding a budget query
   inside the old stage-locked append function would invert the order.
4. In one transaction, evaluate all three aggregate checks, insert/update the
   immutable reservation/append identities, authoritative bytes where applicable,
   aggregate counters and CAS revision. Same-owner admission contenders cannot
   check stale sums and both commit. Read/modify/write counters must not use
   independent transactions or process-local mutexes.
5. Resolution/reclamation uses the same ordering, terminal finalizer fence,
   original ledger lookup and writer fence before exposing a deletion plan.
   Retain tombstones/unique constraints so retries cannot recreate a freed stage.
   Original business finalization remains exactly one transaction; adding a
   sidecar must not split its mutation/audit/CAS atomicity.
6. At startup/recovery, block admission and writers until a complete consistent
   namespace inventory at the recorded revision is reconciled. Its explicit
   `observedRevision` must match; a stale CAS requires a fresh fenced scan, not
   the old entries resubmitted with a new revision. Physical writers can change
   bytes before their confirm-append revision, so revision alone is not a scan
   fence. Never wait for worker quiescence while holding a DB lock that those
   workers need to finish. Detect unknown
   bytes/missing-confirmed/corruption; quarantine and keep capacity unavailable.
   Do not silently delete orphans. Resolving them needs original bindings/authority
   and approved recovery capacity/policy, not an invented unlimited bucket.

The exact implementation must inspect lock interactions of **every** existing
public wrapper, grant revoker and legacy writer and produce real multi-session
failure/race tests before deployment. This lock order is a proposed integration
contract, not evidence that current SQL already follows it. Per-process spool
namespaces require durable fencing or demonstrated process death; a DB row lock
alone cannot revoke an arbitrary filesystem write.

## Verification scope and remaining gates

The focused suite covers defaults, boundaries/overflow, owner/command separation,
all representations, replay and changed duplicate failure, CAS-loser retries,
cancel-before/after-dispatch orderings, expiry without deadline reset, both
resolved outcomes, original-audit retention requirement, two-phase reclaim,
crash cuts, inventory faults, immutable snapshots and a seeded mixed trace
checked against an independent flattened BigInt accounting oracle.

These are **serial model/property/differential checks**, not SQL differential
verification or a production concurrency/capacity proof. New module only; no
real PG/HTTP path is connected. Needed before activation: approved exact capacity
and retention/fairness policy; measured physical representation envelope;
authorized DB sidecar/ACL/transaction integration; real two-session admission,
append/reclaim/finalize races; filesystem stale-writer fencing; process kill/restart
fault matrix and inventory scale tests; compatibility/rollback proof and explicit
publication authority. Existing transport deadlines and capability limits remain
unchanged. No tests or documentation here authorize production activation.

### Recorded local validation (2026-10-26)

* Focused test: **1 file / 25 tests pass**, single worker, no file parallelism;
  includes a deterministic 600-step arithmetic differential trace.
* Focused strict TypeScript check of the new module and its test: **pass**.
* Independent read-only review: **pass within pure-mechanism scope** after adding
  the separate physical writer fence and scan observation revision.
* No full-repository unit/build gate, PG/HTTP test, process-kill experiment,
  real durable sidecar, multi-session transaction or production capacity claim.

Tests ran only after the parent's performance-measurement window ended. No new
package was installed; the existing dependency tree was temporarily linked for
this worktree. Source/test files stayed unchanged while commands were running.

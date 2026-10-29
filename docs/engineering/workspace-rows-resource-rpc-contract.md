# Resource accounting inside the original public RPC transaction — local only

Base: `3d12ae12d8f22ca2d9cb9a32fb1a92705b70f62e` (the preceding independent
Postgres proof), whose application base is `103d8c92c485f1e8fd5cba901e75b1de403fbc91`.
This slice does **not** connect `PgResourceReservations` or a Postgres client to
Vercel. Runtime TypeScript, options, entry factories and release profiles are
unchanged. The application still calls its original public PostgREST RPCs.

## Transaction boundary and activation

`tests/sql/candidates/workspace-rows-resource-rpc.sql` installs private SQL
primitives into the exact existing functions in a disposable fixture database.
The fixture-only catalog patcher checks each unique insertion boundary and
preserves the original body, invoker security and ACL. This is not a deployable
migration. No extra public RPC, schema exposure, provider, network channel,
credential, paid resource or production action exists.

No policy or scope rows are installed by SQL. The fixture owner must explicitly
seed **all** limits and enroll a previously empty user's stage/intent namespace.
Enrollment is an offline fixture seed before serving that owner, not a proved
concurrent activation protocol. Existing stages/intents cause an enrollment failure; there is no implicit zero
inventory migration. Only enrolled owners participate; other original paths
remain off. The original 8 MiB reservation is retained as a genuine insufficient-capacity
negative case: counting independent persisted representations denies finalization
before mutation. Separate fresh positive fixtures explicitly pre-seed 16 MiB
original reservations before admission, with 16 MiB command / 32 MiB owner /
264 MiB global limits. These are **synthetic arithmetic**, not product
policy/defaults or proof the original 8 MiB admits this workload. No existing
admitted reservation is enlarged, and baseline original 8 MiB tests are unchanged.
Service-role cannot enroll users or mint original reservations. Existing broad
local service table privileges are not a production isolation/security proof.

Original durable admission and its resource reservation/initial bytes commit
once in the same transaction. Appending original document/effect data precharges
its representation in that same transaction; failure/backend loss rolls both
back. Original finalization writes business rows, revision CAS, original full V5
audit, stage result and resource committed observation in one transaction.
No BEGIN/COMMIT wrapper or external callback is nested inside those RPCs.

## Locks, identity and authority

All scoped writers use:

`original grant -> global pool -> owner -> command reservation -> head -> stage -> bundle/effects`.

Both durable read and admit acquire resources before their first head lock.
Every document/effect upload, outer document finalizer and nested direct original
finalizer is covered. Initial stage INSERT's implicit head FK lock is covered.
Nested calls repeat only canonical already-held locks. Incoming request keys,
family, original grant/client/revision and manifest hash must agree with the
immutable durable binding; a caller cannot route a canonical reservation through
a different grant after holding global. Legacy effect-only begin APIs fail closed
for enrolled owners; the actual app uses the durable document route.

`require_active_layout` remains an unlocked preflight. This slice does not add
metadata locking after head. Existing ordinary writers have metadata -> head and
never request global; existing revokers obtain the original grant first and
never request global. Thus they do not create an inverse edge. Production
multiwriter/activation, direct privileged DML and legacy inventory migration
remain separate gates; local observed tests do not prove arbitrary production
callers obey the order.

## Logical representation accounting

Counters reuse the preceding normalized pool/owner/reservation/allocation/chunk
schema, not a full-ledger JSON blob. Covered **persisted logical fields** are:

* original durable identity + binding + encoded intent JSON representation;
* initial stage request binding;
* manifest text and parsed manifest separately;
* every document fragment bytea;
* effect wire text and parsed effect JSONB text representation separately;
* reconstructed original stage request; and
* the original stage-result copy, including complete V5 receipt/projection.

Before replacing the initial request, the new request is precharged. Only after
its exact bytes/hash are confirmed in the original stage row does the old
binding allocation become a retained metadata tombstone with zero occupied/
present. No original audit, compensation, receipt, stage or intent is deleted. The
compressed/base64 prepared intent remains durable; its decompressed application
object and any JS serialization buffers live outside this DB accounting proof.
Original fragments, effects, reconstructed request and result stay charged after
commit/Undo because this slice has no approved reclamation lifecycle.
The full reservation remains held. Fixed-size `rpc_peak_occupied` fields on
pool/owner/reservation record the historical maximum at each atomic precharge;
replacement reduces current occupancy but never that peak. The fixture compares
**each named representation**, not just the grand total, against independent
queries of the original physical tables. These are still logical field sizes,
not observed disk, IO or RSS peaks. A refused transaction does not persist an
over-limit peak; the negative fixture separately reports its exact attempted
precharge, post-replacement logical size, and final-result lower bound from the
unchanged V5 projection. It never fabricates a committed result for that failure. Replayed exact existing chunks do not charge
twice and do not authorize rematerialization of a removed allocation.

`present <= occupied <= held` is a logical-fields invariant, **not a disk or
memory bound**. SQL parameters, decompression/JSON materialization, temporary
buffers, tuple/MVCC versions, TOAST, indexes, WAL, metadata and runtime filesystem
spools are not a proven physical envelope. Original business head/item/ledger
receipt/projection/compensation storage is authoritative product data, not this
temporary-staging reservation ledger; it is also outside these counters. The accounting does not copy the
original payload into `temporary_bytes`; tests inventory original tables.
Effect charges are batched per original bounded upload page; page size and all
existing transport caps remain unchanged. The global lock spans each database
transaction including the existing finalizer, not an external request sequence;
contention/throughput remains unmeasured at production scale.

## Unknown, expiry and original recovery

Lost ACK, caller cancellation, expired original deadline or absent result never
releases capacity. There is no autonomous reaper, destructive TTL, refreshed
intent, grant, stage or deadline. The original total 10 s admission budget is
unchanged. The original ledger remains the sole receipt/replay authority.

The existing authorized `read_history(mode=command)` route can observe a
completed stage under the matching original authority and resource/head locks.
A different current grant never acquires a second grant after global; it simply
uses the normal history reader and leaves resource observation untouched.
Frozen/unknown/stopped resource state does not hide an original valid receipt.
An absent original ledger is not noncommit proof. The original finalizer's
internal readability probe is not mistaken for completed stage publication.
Resource outcome stores only original revision plus receipt/compensation hashes,
not replacement receipt/Undo data. There is deliberately **no reclaim/release
integration** in this slice: even committed/stopped capacity stays held. Safe
reclamation requires separate original finalizer fencing and physical inventory
policy before any deletion can be authorized.

## Tests and provenance

`workspace-rows-resource-rpc-native.mjs` is an additive copy of
`workspace-rows-staged-documents-prototype.mjs` at the base SHA. Every original
assertion remains. The only baseline differences are a provenance comment, two
additional local SQL fixture installations, and an appended call to the separate
`workspace-rows-resource-rpc-proof.mjs`; verify the normalized file against
`node scripts/validation/workspace-rows-integration-source-contract.mjs`.
Both harnesses receive the same mechanical historical-reader resolver change;
their complete normalized assertion bodies remain equal. Original source hashes
and the exact accepted portability differences are recorded in the composition
manifest, without depending on unpublished Git objects.

The appended proof uses actual `api/workspace.ts`, actual scoped-v3 factory,
original full V5/unknown/Undo data, original public-only PostgREST, current grant,
original strict network trampoline and original deadlines. Direct SQL is used
only to seed/inspect the disposable fixture and observe real transaction/lock
cuts; it is not the runtime adapter. No direct resource method mock substitutes
for admission/upload/finalization. All validation must run serially against a
frozen SHA with retained failures and before/after source hashes. Unrun checks
are not passed. Generated local evidence lives in ignored run directories and is not public proof.

Open: production/static SQL/ACL rollout, restart inventory lifecycle, existing
scope migration, capacity/fairness/retention policy, full reclaim integration,
filesystem stale-writer/process death, standalone history spool admission,
physical storage/memory envelope, global-lock performance, regional RTT and
compatible hosted rollback. No push, PR, CI, merge, deploy or production changes.

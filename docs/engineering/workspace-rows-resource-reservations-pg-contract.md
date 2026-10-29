# Normalized resource reservation adapter — local Postgres proof only

Baseline: `103d8c92c485f1e8fd5cba901e75b1de403fbc91`. The pure mechanism's three
new files are imported unchanged from `7d996cdc30ce62d21c0138c23252e8af4111ed05`.
New files only: independent sidecar SQL, TS adapter, synthetic authority fixture,
native transaction runner, and this contract. No existing runtime, options,
staged bridge, durable intent, reader, authority implementation or migration is
changed. Nothing registers this adapter in the application. No new dependency,
provider, credential, ACL, quota, time policy, paid resource, or production write.

## Storage and scope

`tests/sql/candidates/workspace-rows-resource-reservations.sql` creates a separate
`ta_resource_reservations` namespace. It is **not a deployable migration** or
public RPC. All SQL runs only in a uniquely named disposable database on the
already-existing loopback PostgreSQL fixture. No roles or ACL are changed.

The pure reducer remains an independent oracle, not a persistence layout:

| Table | Key / representation | Mutation scope |
| --- | --- | --- |
| pool | one fixed-size global counter/limits/generation row | Incremental totals + global serial lock |
| owner | exact original user ID, three counters | One owner per transaction |
| reservation | original stage ID; unique `(user_id, command_id)` | One command's binding/deadlines/phase/counters/fences |
| allocation | `(stage_id, allocation_id)` | One independently live representation; contiguous cursor |
| chunk | `(stage_id, allocation_id, byte_offset)` | Immutable exact length/digest + pending/present status |
| temporary_bytes | same exact slot, bytea | Only sidecar-owned temporary copies, never original audit |

Append reads only the selected reservation/allocation/offset and adjusts fixed
counter rows. It does not load or rewrite every user, command, document or chunk.
Reclamation scans only the target stage before fencing, then deletes/acknowledges
one allocation at a time. Startup reconciliation is deliberately a complete
namespace scan; aggregate SQL returns issues/counters rather than full bodies to
JS. There is no full-ledger JSON blob. The small immutable binding/outcome objects
are per command. The metadata tombstones are retained indefinitely in this slice;
metadata compaction/retention, recovery inventory scale and global lock throughput
are not solved policy/performance problems.

Bytes are logical bytea/representation sizes. Pending precharges count against
occupied upper bound even before any physical row exists. `present <= occupied
<= held`; occupied is not added to held. PostgreSQL heap/TOAST/index/WAL overhead,
materialization of caller buffers before this API, filesystem spools and other
runtime copies are not hard-bounded by these counters. `storage-overhead` exists
as an explicit kind but no assumed envelope is silently charged.

## Configuration and restart

`PgResourceReservations.start(db, authority, configuration?)` is coordinator
startup/recovery, **not a per-request factory**. Default configuration is off;
enabling requires all three explicit safe-integer byte limits, with zero a valid
deny-all policy. Limits cannot change on restart; no epoch resets or minting of
capacity occurs. Fixture limits/expiry values demonstrate arithmetic only.

Startup takes the global lock, replaces a coordinator generation, increments the
revision and persists `inventory_verified=false`. All old handles become stale.
The returned handle can be shared by multiple independent DB connections. It
must call `reconcile` before any new admission or bytes. Reconciliation first
commits a freeze separately, so scan errors/timeout/disconnect cannot restore an
earlier verified state; the subsequent scan also validates contiguous offsets. A crash after a durable
precharge leaves that charge held. Restart never infers request-finally cleanup.
A complete, consistent actual-byte scan is performed under the same global
writer fence, checks hashes/lengths and counter sums, and records its exact
observed revision. Orphans, missing-confirmed bytes, mismatches or counter faults
keep the namespace frozen; no orphan is automatically deleted and no pending
charge is automatically forgiven. The runner's explicit repair of injected
fixture faults is not an adapter recovery policy.

This is coordinator-driven recovery, not an autonomous liveness monitor. An
unannounced worker death cannot by itself freeze another already-running
coordinator. A production coordinator/process lifecycle and complete legacy/FS
inventory must be designed before connecting this API.

## Transaction and authority interface

Each API operation currently owns `BEGIN ISOLATION LEVEL READ COMMITTED` through
COMMIT/ROLLBACK on a dedicated connection. Existing caller transactions are rejected using a native SAVEPOINT state probe
before BEGIN, leaving the caller transaction untouched: PostgreSQL nested BEGIN
is not an independent transaction. Do not
share one connection among concurrent calls. The argument must be one physical
client exclusively owned by one in-flight operation, never a pg.Pool query
facade or Promise.all calls on a shared client; a transaction-state probe cannot
prevent same-client interleaving. Methods do not retry an uncertain
commit automatically; the stable identity permits an exact retry on a fresh
healthy connection after inspecting state. The native runner demonstrates both
terminated-session rollback and a committed-but-lost ACK.

The only original-domain integration points are trusted `ResourcePgAuthority`
callbacks, all executed with the same live connection:

1. `lockOriginalAuthority`: acquire the existing original grant/share authority
   lock; reject wrong/revoked/current-revision mismatches. No generic grant.
2. Adapter takes global pool -> owner -> reservation locks (unique command index
   prevents same-owner command re-use across stage/workspace/epoch).
3. `lockOriginalHeadStageAndValidate`: existing workspace metadata -> head ->
   stage order; revalidate generation, binding, principal and current authority
   after waits. It must **not discover/acquire another authority lock** here.
4. `readOriginalAdmission`: read the pre-existing authorized exact reservation,
   immutable identity and original absolute deadline. Caller capacity is not an
   admission argument, and the adapter cannot create the original reservation.
5. `fenceAndReadOriginalOutcome`: permanently fence/drain original finalization,
   read the original authoritative command ledger and require retained original
   receipt, projection and Undo compensation for committed outcomes. This is
   trusted SQL integration code, not a request-supplied proof object.

Hooks must perform only SQL on the supplied connection, no HTTP, filesystem IO,
worker joins or waiting for tasks that require locks held by this transaction.
The global lock lasts through the short atomic metadata/bytea mutation and
COMMIT, not across external physical work. A future external-write adapter would
need persist-precharge -> release transaction -> durable exclusive write ->
confirm, with an independently established writer fence. This implementation
proves only the owned bytea namespace.

### Bidirectional deadlock check and integration gate

The required common order is:

```
original authority/grant -> global pool -> owner -> command reservation
  -> original workspace metadata -> head -> stage -> allocation/chunk/bytea
```

One command per transaction; split multi-owner cleanup rather than discovering
an authority key while holding global. No path may hold head/stage and later
request global. Existing grant -> head -> stage methods that never touch global
do not alone create a cycle: they cannot wait for global. However, **partially
upgrading** an old stage-first upload to add an accounting query does create a
potential inversion against a global-first writer. Similarly a revoker holding
head/global and later acquiring grant can deadlock with grant-first admission.
All wrappers, uploaders, finalizers, revokers and reclaimers must be audited and
updated together before activation. The fixture proves grant-before-global wait
with real blocked sessions and NOWAIT head/global probes; it does not prove all
existing production callers follow this order.

No global lock is acquired before the original grant on command operations.
Startup/reconciliation are exceptional namespace-only maintenance: they acquire
global but **never acquire any original grant/head/stage afterward**, and cannot
form the opposite edge. Counter mutation is serialized at global; owner/command
locks document and preserve subordinate ordering, not a scalability claim.

## Terminal resolution and safe release

`beginFinalize` is dispatch intent. Only `applied` + `finalizing` permits a new
original dispatch. Same attempt replay in unknown/resolved/released phase is not
a dispatch permit. Cancellation, original expiry, process-crash stop, timeout,
or `markUnknown` retain all capacity. Unknown may remain pinned indefinitely;
this slice defines no destructive retention TTL.

`resolve(expectedReservationRevision)` calls the real authority integration
hook in the locked transaction. The synthetic test fixture permanently fences
its original stage and then reads its original command/audit rows; it tests an
in-flight business commit winning first and the resolver seeing revision 37,
not an assumed expectedRevision+1. It also proves missing retained audit evidence
rolls back both resolution and the terminal fence.

`beginReclaim(reclaimId, expectedReservationRevision)` requires that terminal
outcome, scans the complete stage temporary namespace under the writer lock,
and atomically persists a distinct physical DB writer fence tied to the exact
reservation revision plus observed inventory revision. A stale write cannot
enter while the global lock is held and cannot write after the permanent fence
commits. `removeAllocation` deletes only sidecar-owned temporary bytea, verifies
absence in the same transaction, and reduces occupied/present counters. The
original capacity stays held until `release` sees every allocation removed and
no stage bytea remaining. Release adjusts owner/global capacity once; immutable
stage/command tombstones refuse re-admission. There is no deletion path to
original receipts, raw history, projection deltas, compensation or sole unresolved
recovery copies.

## Required parent integration, explicitly still open

* Current API transaction ownership is an independent fixture boundary. Parent
  integration must use a common transaction-scoped adapter/SQL primitive so
  original mutation/audit/CAS + sidecar finalization cannot be split across two
  commits. Do not simply call this stand-alone wrapper inside a business tx.
* Wire exact original admission, original authority and current grant validation;
  preserve original `grant -> head -> stage` relative order while inserting the
  new accounting locks at the specified point across **all** writers.
* Inventory/migrate existing reservations and partial stages before enabling.
  Old rows cannot be treated as empty. Insufficient approved capacity fails
  closed; no service-role reservation minting privilege has been introduced.
* Establish actual privilege isolation/ACL deployment and tamper resistance.
  This artifact makes no production security claim about an owner-role fixture
  whose SQL can directly edit the tables. There are no public RPC grants here.
* Establish physical filesystem stale-writer prevention, process death/join,
  recovery inventory and reaper cuts. DB backend termination is **not** proof of
  a killed filesystem writer or a cross-process spool reaper.
* Agree exact capacity/fairness/retention policies and measure physical storage
  envelope, large-inventory cost and global-lock contention before activation.
* Keep rollback compatibility and runtime flags default off. Publication is
  neither performed nor authorized by these local tests.

## Reproduction and evidence

Run only in an exclusive local PG/CPU window using the integration runner's
shared lock. For a fresh checkout, install the committed dependency lockfiles
and configure verified binaries according to
[reproducible validation](workspace-rows-reproducible-validation.md). `TA_ROW_DATABASE_URL` is guarded as loopback port
55439. The runner creates/drops only its own uniquely named synthetic database.
Freeze source/runner/fixtures before execution and preserve SHA256 manifests.

```
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module ESNext \
  --moduleResolution Bundler --types node --strict --skipLibCheck \
  gateway/workspaceRowsResourceAccounting.ts gateway/workspaceRowsResourceReservationsPg.ts \
  tests/workspaceRowsResourceAccounting.test.ts
node node_modules/vitest/vitest.mjs run tests/workspaceRowsResourceAccounting.test.ts \
  --maxWorkers=1 --no-file-parallelism
node --import tsx tests/sql/workspace-rows-resource-reservations-native.mjs
```

The runner records exact source hashes, gate status and cleanup checks in a new
ignored local run directory. No previous private evidence catalog is required or
published. Clean-checkout runtime validation is **NOT_RUN** until these commands
are actually executed; no unrun gate is a pass.

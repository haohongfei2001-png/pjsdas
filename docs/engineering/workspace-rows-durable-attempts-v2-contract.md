# Durable prepared intent v2 / execution attempt v1 (local, default off)

Baseline: `19e46a95bd4c183abae36d59e300a0e9db22562a`. This repairs the original durable outbox recovery promise. It does not extend approval, lease, resource expiry, capacity, retention or supported command families.

## Immutable and mutable state

- New `workspace-prepared-intent-v2` contains the exact original `before`, prepared `input`, and manifest hash, but **no execution deadline**. Original command/stage/owner/client/grant ID+revision, payload hash, expected epoch/revision, snapshot/projection/lifecycle/compensation/effective-time (including absent values) never change. No reducer/provider reruns after admission.
- The existing immutable intent row gains explicit protocol discrimination; v1 deadline/hash/bytes retain their original meaning. v2 has no intent execution deadline.
- A separate bounded current-attempt row carries DB-issued UUID, monotonic generation, DB-issued deadline <=10 seconds, and irreversible terminal reason. A retry replaces only this execution metadata, not the original intent or reservation. This is not an append-only attempt log or new retention policy.
- DB `now()` remains the existing finalization-transaction timestamp for a new receipt; replay returns the original receipt unchanged.

## State machine / serialization

`ABSENT -> ADMITTED -> ATTEMPT(g,id,deadline) -> COMMITTED`, or `TERMINAL_UNCOMMITTED`. Interrupted/expired attempt remains ADMITTED, and an explicit same-ID recovery may acquire another attempt. No unbounded automatic retry.

Each recovery resolves the original command under grant -> global -> owner -> resource-command -> head -> attempt/stage locks before issuing a new attempt. Head lock drains any in-flight finalizer; receipt absent outside this boundary is never proof of noncommit. A committed command returns its existing outcome, not a new business write. A concurrent retry reuses the same still-live attempt ID/generation/deadline (no renewal). Only an expired attempt is replaced under that same serialization boundary. The begin transaction’s DB budget includes lock waiting; immutable-byte preflight and admission have their separate existing bounded request budgets. The worker conservatively subtracts full monotonic RTT from the returned DB remaining budget, never compares DB time with its own wall clock. Every document/effect/finalization call binds its exact attempt ID/generation and checks the unchanged deadline before AND after the original SQL work. No per-page renewal. Old APIs cannot write a v2 intent without its attempt context.

The original reservation expiry and reserved bytes are unchanged. Resource accounting explicitly discriminates v1 intent deadline from v2 current-attempt deadline; actual expiry remains independently mandatory. Same transaction retains all original business/audit/CAS/resource writes. No reclaim, release or capacity extension.

## v1 and compatibility

v1 complete, unexpired intents can finish under their original deadline. Already committed receipts always retain their original authorized reader. Expired uncommitted v1 resolves under the same authoritative lock boundary, records a nonresurrectable `LEGACY_INTENT_EXPIRED` tombstone, and returns a nonretryable terminal outcome. Missing complete bytes for an old partial stage still fails closed. No v1 bytes rewritten, rehashed, resigned or interpreted as v2; no assumption that these local candidates ever reached production.

The current release can recover all three known audit modes by exact original manifest. Turning off new admission does not turn off read/recovery. A compiled old writer cannot write v2; read-before-write deployment must include this v2 reader/fence before enabling new v2 admission. No production migration or readiness claim.

## API / frontend

Only server configuration selects v2. Browser DTOs cannot select protocol/audit mode/deadline/grant. The original `/api/workspace` and scoped entry remain the application boundary, and SQL traffic stays public-only PostgREST. New versioned RPCs are internal server transport, not a direct-PG runtime.

Definitive DB-fenced uncommitted outcomes use `WORKSPACE_RECOVERY_TERMINAL` (nonretryable); clients preserve their durable draft/journal, perform their existing dependency-safe rollback, and show explicit not-saved/conflict rather than infinite unknown. Temporary auth/network/DB unavailable stays pending/unknown; it is not falsely reported cancelled. Ordinary grant prevalidation can reject a scoped request before intent resolution, and must not claim terminal noncommit without DB resolution.

## Acceptance scope and retained limits

Real >=60-second disconnected admitted-uncommitted command plus cold process/API and scoped retry; original bytes and one business commit. Actual 10-second single-attempt rollback, delayed old generation, concurrent retries, lost ACK, interrupted/cancelled request, revoked/replaced grant, epoch/CAS change, real reservation expiry and exhausted capacity. V5/unknown fields/Undo, three audit modes, old v1 terminal, rollback reader fence, frontend terminal/pending/confirmed. Original historical 80/81 and 5000ms failures remain evidence, never rewritten as pass.

## Internal cancellation and accounting boundaries

`large_v2_intent_cancel(identity,target_user_id)` is a service-only internal primitive, not a browser action. It requires the exact original current owner/client/grant proof, drains the authoritative finalizer boundary, resolves the original ledger first, and only then persists `CANCELLED`. A transport AbortSignal never invokes it and never proves cancellation. With revoked/replaced/missing authority, access is refused without claiming noncommit.

Only a fixed admitted reservation's cumulative representation exhaustion becomes `RESOURCE_EXHAUSTED`: its failing writer subtransaction rolls back, then the outer transaction re-locks/resolves before recording terminal. Temporary pool/owner admission capacity or unavailable policy remains retryable and does not mint/extend resources. An already committed outcome discovered by read/begin/cancel is a compact outcome/revision signal; the original bounded authorized audit reader supplies the original receipt.

The current-attempt row is bounded per admitted intent, not an accumulating attempt history. Existing logical representation counters continue to measure original durable payload copies; SQL control metadata, indexes/heap/TOAST/WAL and process/FS overhead are still separate unapproved sizing gates. This patch does not claim that new control metadata costs zero physical storage or extend the existing reservation policy.

## Synthetic validation status at Draft publication

- **PASS on runtime source `88c369b52ec038df1657a8ed89685fd1083f0eba`:** real
  at-least-one-minute disconnection followed by new-process API/scoped same-ID
  recovery; 185 focused tests; TypeScript and exact frontend/API/scoped builds;
  5,276 unit tests across 397 files. Safety, lock/resource, client-double, audit
  modes, historical compatibility and original SQL regressions have separate
  grouped results, not one complete green acceptance run.
- **PASS, compile only on source packaging `dce4ed0fb14db3af45c1cbfc4ebcc6a5203f41ba`:**
  four historical source-closure/hash/tamper checks and six independent bundles
  in a source archive without Git history or sibling worktrees. Existing locked
  tool packages were reused; no bundle was executed and this was not fresh
  dependency-install evidence. Packaging changed no runtime or candidate SQL.
- **FAIL / unresolved:** retained mixed-load readability and bounded-attempt
  deadline failures, including earlier full-pair failures. Isolated successes
  and later same-ID recovery do not erase the original failed runs.
- **BLOCKED:** the local real-browser/IndexedDB runner could not launch Chromium;
  zero cases ran. Client storage doubles and other mock-browser CI are not proof
  of this durable-v2 browser acceptance scenario.
- **NOT_RUN on the final packaged source before publication:** fresh dependency
  installation, full TypeScript/unit/native PostgreSQL/HTTP/pair acceptance.
  Applicable CI must be read for the exact published commit separately; old-head
  CI and earlier runtime results must not be relabeled as final-commit results.

These are generalized synthetic engineering summaries, not production observations.
Admission remains default off. Hosted fallback capability, production SQL/ACL,
physical storage/crash/retention and activation remain unaccepted.

## Repository-native core / safety / barrier gate

The Stage A synthetic CI job now contains the native recovery acceptance harness,
using the same checked-out runtime and candidate SQL as Stage A. This packaging
adds no runtime, SQL, dependency, production configuration, retention, GC or
capacity policy change. It is not the historical full-pair, all-audit-mode,
browser-to-PostgreSQL or hosted-fallback acceptance gate.

After the original Stage A suite, **three serial, independent owned fixture
DBs** run against the existing PostgreSQL 17 service and verified PostgREST 14.5:

| Group | Entry | Required unique labels |
| --- | --- | --- |
| Core | `workspace-rows-durable-v2-acceptance.mjs core` | 4 |
| Safety | `workspace-rows-durable-v2-acceptance.mjs safety` | 17 |
| Barriers | `workspace-rows-durable-v2-barriers.mjs` | 7 |

These paths are under `tests/sql/` and execute with `node --import tsx`. Unknown
selectors fail closed. The safety group is one continuous run on one fixture,
not a stitched seven-case prefix and ten-case tail. All 28 labels must occur
exactly once and pass; absent, extra, duplicate, failed or `NOT_RUN` labels do
not constitute a green native gate. No automatic retry or rerun-to-green is
provided. A failed group stops execution; later groups remain `NOT_RUN`.

### Preserved assertions and budgets

- Core uses a real at-least-60-second socket disconnection for both admitted API
  and scoped commands, with their original processes exited and different PIDs
  on recovery. It checks the same original command IDs, immutable prepared
  bytes, authority, reservation, business time and exactly one business commit.
  The two original protected Undo cases are separately interrupted and recovered;
  **they do not claim a second minute-long Undo outage**.
- Safety preserves real 10-second rollback, old-generation rejection, concurrent
  same-ID attempt reuse, both lost-ACK paths, authority cancellation and the
  original read/resource fences. Grant reapproval calls the existing public
  consent function and keeps the same grant ID with a newer revision. An
  inconsistent head/layout epoch is only a safe refusal, not proof of
  DB-confirmed terminal noncommit. Resource-OFF negatives use a never-enrolled
  owner rather than removing a protected scope.
- Barrier tests observe actual PostgreSQL lock waits and both cancel/finalizer
  orders, exact duplicate-page accounting, fixed 8 MiB representation exhaustion,
  16 MiB success and pre-admission pool exhaustion. The original 264 MiB synthetic
  pool fills through real admissions; no reset, reclaim, expansion or renewal is
  used to make the continuous safety group pass.
- The CI job remains capped at 10 minutes, with PostgREST pool 2,
  `work_mem=2184kB` and the existing 10-second statement/attempt budgets. It runs
  as the container's `postgres` OS user inside the service's isolated network;
  no host networking, privileged mode, new service or `pg_hba` weakening is used.
  Each fixture creates only its own temporary `LOGIN NOINHERIT` authenticator
  with an independent random synthetic password, then removes it at cleanup.
  PostgREST never authenticates as the database superuser.

### Source identity and evidence boundary

`workspace-rows-durable-v2-source.mjs --manifest <path>` hashes the current
checkout-relative allowlist. CI records the actual checkout commit/tree and the
PR head separately: a PR merge checkout must not be mislabeled as the head SHA.
The hash manifest and its expected SHA256 accompany the transported source and
are verified before and after each group. The transport includes only `api/workspace.ts` from `api/` for the
real workspace handler, excludes Git metadata and ambient credentials, and
requires neither historical Git objects nor sibling working trees. Path escape,
manifest tampering or changed source fails the gate.

The shared fixture owns its database, authenticator, observer connections and
worker/PostgREST processes. Failure cleanup is still attempted; a cleanup or
source-verification failure fails the group rather than preserving a green
status. Only sanitized `result.json`, `cleanup.json`, the source manifest and
CI group/cleanup state are eligible for the artifact. Raw payloads, JWTs,
passwords, child stdin/stdout, private diagnostic logs and database directories
are not uploaded. The wrapper removes its owned temporary work and private logs.
Barrier diagnosis records only allowlisted RPC names, numeric timing/status/byte
counts, attempt generations/deadlines and relative test-file error locations. It
never records original bodies, full SQL, credentials or absolute paths. These
observations do not renew attempts or alter the assertions.
Pure contract tests cover the label sets, selectors and source-manifest
boundaries without starting PostgreSQL.

### Result interpretation and retained failures

Adding this gate is not evidence that its final published commit has passed it.
Read the exact checkout/PR-head mapping, all three new group results and cleanup
results for that execution. A complete success may be described only as
**native core/safety/barrier automatic-gate PASS**, not full-v2, full-pair,
production or release readiness. Existing real-IndexedDB/reload CI is a separate
narrow acceptance gate, not a substitute for these native cases.

Earlier failures remain part of the record: the old duplicate-grant fixture's
`23505`; old full/native deadline failures; the real scoped/pages Undo attempt
timeout; historical sixth-producer `57014`; and the 51 ms causal-profiling result
still marked `NOT_ATTRIBUTED`. A corrected fixture or later lower-load pass does
not erase or explain those failures. GC work remains private and outside this
native gate. Admission remains default off and hosted/physical-storage/crash/
retention/activation gates remain unaccepted.

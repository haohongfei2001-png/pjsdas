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

# Conservative Undo dense-slot candidate

This is a new reconstruction from public source `5e9be3fe86f549c97776ca0c9afa15032d0bf936`, not a recovery or certification of an unavailable private candidate.

The two fixture-only opportunity guards use integer slots for the ordinary, identity-preserving Undo subset and aggregate original JSONB values once. Canonical nonnegative integer indices up to nine digits, exact JSON string identities, and distinct per-kind indices are required. All other cases execute the prior scalar-sidecar loop unchanged. No authority, epoch, grant, receipt, resource, deadline, SQL permission or deployment setting is changed. No production migration is added.

## Checks

Run only against an owned synthetic loopback PostgreSQL 17 fixture with the existing prerequisite roles. First create the existing native-source manifest for the frozen commit/tree, then provide its path/hash and identity through the existing `TA_V2_SOURCE_*` environment contract. The manifest covers the runner, all fixture modules and SQL inputs; it is verified before imports and again after cleanup. The evidence file must be a new absolute run-exclusive path; existing evidence is never overwritten:

```sh
TA_ROW_DATABASE_URL=postgres://postgres@127.0.0.1:55438/postgres \
TA_UNDO_VALIDATION_WINDOW=synthetic-owned-fixture \
TA_UNDO_EVIDENCE=/path/outside/checkout/undo-dense-proof.json \
node --import tsx tests/sql/undo-dense/proof.mjs
```

The proof owns and removes a random database. It verifies the immutable pre-scalar oracle and exact complete pre-dense inner-guard hash, compares four implementations using PostgreSQL `IS NOT DISTINCT FROM`, and tests both real fast-path entry and original fallback. Precision values never round-trip through JavaScript before the equality decision. Explicit C, ICU and nondeterministic-ICU loop replicas isolate collation behavior; they are **not** claims that the unmodified public guard ran with a nondeterministic database default.

Performance uses the same synthetic arguments, alternating implementation order, five samples each, PostgreSQL clocks, `statement_timeout=10s` and `work_mem=2184kB`. It measures reconstruction and complete **inner guard**, not HTTP, full transactions, v2 attempts, mixed-load acceptance or production performance. Results are observational; no budget is increased and no timing threshold is relaxed.

Also run the existing `workspace-rows-opportunity-guard-equivalence.mjs`, Stage-A native HTTP suite, staged-opportunity HTTP suite, focused unit tests, full unit tests and TypeScript checks. Broader durable-v2/full-pair/release acceptance remains separate. No old rollback matrix or earlier performance observation establishes those gates.

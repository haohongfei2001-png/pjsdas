# Synthetic HTTP payload-shape diagnostics

2026-10-25 UTC. Test-only follow-up based on main `bbaa45ef`. No production,
migration, feature flag, timeout setting, gateway or workflow change.

## Question, not a production reproduction

The earlier repeated-string / small-receipt fixture establishes a particular
PostgREST materialization regression. It does **not** demonstrate production
latency or exclude other costs in structured, less-compressible snapshots.

The new matrix uses generated synthetic data only. It does not copy, inspect or
reconstruct private workspace content. In particular, the large-receipt case is
an independent return-path boundary probe.

## Added matrix

Each shape runs through both v3 and v4 in the existing PostgreSQL 17 / PostgREST
v14.5 CI fixture:

| Shape | Generated snapshot JSON bytes | Generated receipt-context JSON bytes |
| --- | ---: | ---: |
| Structured nested arrays, 7,000 synthetic records | 4,514,046 | 2 |
| Fixed-seed high-entropy payload | 4,000,031 | 2 |
| Large receipt only, tiny snapshot | 18 | 3,000,030 |

These are locally verified **generated JSON** sizes, not stored PostgreSQL sizes
or CI performance results. Seeds and schemas are stable. High-entropy values are
synthetic ASCII characters, not tokens, credentials or user records.

For each case, one actual HTTP ANALYZE/BUFFERS request is rolled back, then one
ordinary HTTP request commits into a freshly reset disposable fixture workspace.
The test verifies rollback through revision/ledger readback, and ordinary commit
through its receipt and revision. It never retries an uncertain request.

Logs include request JSON bytes, response JSON bytes, serialization time, HTTP
plan/commit time, PostgreSQL planning/execution time, `pg_column_size` for stored
snapshot and receipt, their expanded JSONB text byte counts, and temporary blocks
at the plan root and individual nodes. Node block counts are inclusive and must
not be summed. `pg_column_size` is not interchangeable with expanded JSON bytes.

Existing flat small-receipt assertions remain unchanged. New shapes do not assert
zero spill or a production latency bound. The large returned receipt can spill
even if raw JSON avoids input/snapshot-return materialization. The matrix has a
95-second request budget, capped 15-second requests, and the existing bounded SQL
readback timeout; no database timeout configuration is altered. An incomplete
case logs available measurements and fails rather than silently skipping it.

## Evidence status

Local checks: syntax, whitespace, deterministic seed behavior and generated size
bounds passed. No local server was started. Real HTTP, stored sizes, spill and
timing measurements remain pending the existing SQL CI run. This diagnostic batch
needs no production deployment and is not evidence that the production timeout
or Supabase IO risk has been resolved.


# Opportunity management raw-preservation repair

Source-only repair; v3 remains unregistered and unissued. Existing live v2 logic, consent and SQL are unchanged.

## Retained baseline failure

`evidence/opportunity-raw-baseline-20261002.json` captures the synthetic before/after receipt on tree `f3335c354f8224932ff8a0ffe45f3c98b206aa96`: updating only `unknown-0.early` deleted unrelated `apply:unknown-1.dueAt` and `timingMode`. Whole-snapshot normalization happened in the reducer, executor, final commit preparation and undo path. Source-only v3 had not been activated, so this is not evidence of a live user mutation.

## Repair

- Use validated raw snapshots for v3 reads, apply, post-reduction, CAS retries, commit fallback and undo. Missing legacy collections require a separate explicit migration; this operation never silently materializes them.
- The adapter internally constructs its transactional raw reader/executor and binds the immutable first admitted grant. Replacement/revoked grants cannot enter between adapter and executor admission. Exact whitespace-bearing object IDs are preserved.
- Preserve neighboring metadata, source facts and original collection order. Existing archival dependency rules and undo conflict protection remain.
- A new service-role-only SECURITY INVOKER migration replaces only the v3 wrapper. It retains the grant SHARE lock and locks the workspace before checking unrelated raw data, exact declared rows, source-fact exclusions, retained ordering, append-only prior history and archive ownership/dependency boundaries. Direct RPC archive undo also refuses newer dependent nodes/outbox links, validates stored parent/rule guards, and reconstructs the exact permitted insertion order. Undo evidence comes from the owner ledger. Stale CAS remains a conflict; a fresh revision never authorizes unrelated changes.

## Verification

The regression and actual CAS-conflict test preserve the unrelated raw date through read/apply/undo. Full 1,894 unit/integration assertions in 248 files and app/gateway types passed before final SQL fixture additions. Sixteen actual gateway-to-PostgreSQL scenarios cover raw profile/archive recovery, later unrelated data, newer target refusal and direct forged payload rejection. Real separate-session grant revoke/regrant, queued stale raw snapshot, fresh-revision collateral rewrite and undo races are required in both local and hosted chains.

Local PGlite was killed with exit137 even for an unchanged fixture; no passing result is claimed for that attempt. A separate disposable official PostgreSQL17.11 instance supplied real SQL verification instead, using an isolated port/data directory and synthetic credentials. Hosted SQL plus full exact-head browser gates remain required before adoption.

## Retained performance adoption evidence

PR232 performance run `37075891702`, head `ebd32e60`, passed all four strict performance tests with no long tasks. The 3,940-history capacity fixture settled p95 was37ms; complete43/57ms, cancel57/66ms, reschedule44/55ms. Artifact `11257690980` retains one WebKit dense cancel first-attempt153ms versus150ms limit, which passed the workflow's existing retry. Prior main passed that same cancel test. The optimized Today selector is bypassed on that schedule surface, with no selected opportunity; no functional regression was reproduced. This first-attempt failure is retained, not erased by the retry. All thresholds, fixtures, sample counts and retry policy are unchanged.

The source gateway and direct RPC both retain the1MiB compact-JSON evidence limit and2500-object bound. A deterministic SQL compact-byte verifier counts object/array delimiters, key/string escaping and scalar bytes; exact decimal numerics retain every significant digit while using the JSON fixed/exponent notation cutoffs; no floating-point conversion or rounding occurs. Traversal is capped at128 levels and short-circuits once its byte count exceeds1MiB. PostgreSQL pretty-text size is not a substitute for compact wire size. Near-limit raw metadata and exponent cases are compared against JavaScript JSON.stringify, while genuinely oversized direct-RPC evidence is rejected.

The retained near-limit failure is1,019,572 compact bytes versus1,179,681 PostgreSQL JSONB-text bytes. The verifier matches JavaScript serialization on more than1000 deterministic finite binary64 samples and escaped UTF8 structures, separately preserves exact high-precision JSONB decimals, and rejects oversized/deep evidence at the direct RPC. The helper is executable only by service_role.

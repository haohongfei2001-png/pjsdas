# R02 / #156 Production Acceptance and Canonical Closure

Package: `TODAYACTION-RELIABILITY-CLOSURE-v1`  
Engineering: **PASS**  
Production contract: **ACCEPTED_WITH_ACTIVE_UNRESOLVED**  
Package: **COMPLETE_WITH_UNRESOLVED / STOPPED**  
Writer: **RELEASED**

This closes the active-versus-lifetime audit contract. It does not claim that real source ambiguities are all resolved or that current Coverage is green.

## Authorization and exact source

The owner explicitly authorized applying the merged R02 migration and one bounded ingestion-debt reconciliation on the real private transactional workspace, with read-only baseline/readback, append-only history, unchanged Gmail permissions/cursor, and package closure on contract acceptance.

- PR: [#176](https://github.com/haohongfei2001-png/pjsdas/pull/176), merged.
- Verified runtime main: `7c3022d42e1fe9029d99491a2289709320bd4465`.
- Source migration: `supabase/migrations/20260926230000_ingestion_debt_reconciliation_scheduler.sql`.
- Exact SQL SHA-256: `0bf42d002f489196522350d2d3f72c1d4fbcd0d2f7fb71d88d58f7839d248e40`.
- Applied database migration: `20260927050521 / ingestion_debt_reconciliation_scheduler`.
- R02 cron provisioned at `42 * * * *`, **active=false**, verified after migration and execution. Continuous activation was not performed.
- Existing Gmail primary scheduler remains `*/10 * * * *`; existing discovery/R01 schedules were not changed.

## Engineering and exact-main gates

Before production reconciliation, exact main passed:

| Gate | Evidence | Result |
| --- | --- | --- |
| CI | [36266626616](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36266626616) | 201 files / 909 tests; TypeScript, audit, production build and standby bundle PASS |
| Browser | [36266626645](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36266626645) | 82 passed; no flaky retry on exact main |
| Matrix | [36266626662](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36266626662) | PASS |
| Brand | [36266641852](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36266641852) | PASS |
| UI | [36266641991](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36266641991) | PASS |
| Pages / production read-only Self-Test | [36266626694](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36266626694), [36266721061](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36266721061) | PASS, exact runtime SHA |

The PR-head Browser run had one account-sign-out cleanup flake that passed its configured retry; the exact-main run passed all 82 directly. That observation is retained rather than presented as zero retries on the PR.

## Read-only baseline and bounded execution

Production project: `yyrzwpoxlxpafdlbkdtg`. One transactional workspace; worker bounds remain 10 workspaces / 2000 unresolved keys per workspace. No private messages, titles, account identifiers, credentials, or full snapshots are included in this receipt.

An initial read-only baseline at `2026-09-27T05:05:03.238679Z` was revision 631. Existing background intake naturally advanced it to revision 632 and appended 14 non-resolution timeline rows before the authorized reconciliation. The write is therefore compared against the refreshed immediate baseline below, not the earlier checkpoint. Domain and Gmail permission/cursor fingerprints remained unchanged across that interval.

- Dry-run request **1019**: HTTP 200, `dryRun=true`, one workspace, 178 keys, predicted 178 resolutions (`resolved=1`, `active_unresolved=177`).
- Immediate pre-write baseline: `2026-09-27T05:06:44.784248Z`, revision **632**.
- Only mutating request: **1020**, HTTP 200, `dryRun=false`, one successful workspace, zero failed workspaces, **178 appended resolutions**.
- Command ledger: one `ingestion_debt_reconciliation` operation, **COMMITTED**, CAS expected revision **632**, resulting revision **633**, `principal_kind=automation`.
- Provenance: `sourceId=ingestion-debt-reconciliation`, `adapterVersion=active-unresolved-v1`, writer `ingestion-debt-reconciliation-worker`.
- Readback: `2026-09-27T05:07:33.360177Z`, revision **633**.

| Durable quantity | Before | After |
| --- | ---: | ---: |
| Timeline rows | 2781 | 2959 |
| Original ingestion ledger rows | 1615 | 1615 |
| Lifetime unresolved source-record keys | 178 | 178 |
| Active unresolved source-record keys | 178 | 177 |
| Additive resolution rows | 0 | 178 |
| R02 committed commands | 0 | 1 |

There are 178 distinct resolution IDs and zero dangling target/fingerprint references. The single resolved result is backed by a committed semantic receipt. Current Coverage remains **not all caught up** because active unresolved remains 177, including a transport gap. The latest Gmail run itself also contained unresolved inputs; no claim of universally healthy intake is made.

## Append-only and permission/cursor invariants

The following database-computed comparison fingerprints matched exactly between revision 632 and 633. They compare canonical JSON; they are change detectors, not security signatures.

| Invariant | Before = after MD5 |
| --- | --- |
| Entire original ingestion ledger | `02f7c30b7564a7f401ef520d90abde1d` |
| Original unresolved ledger rows | `e6bc9c1f8100df8eefbcdc3fee226d1f` |
| All non-resolution timeline rows | `531dd08faf0d238e975bf6e846f219aa` |
| Entire domain data excluding timeline | `f3e885afec518254d7fcfdaa26ddb196` |
| Gmail scopes, consent, enabled state and primary/continuation cursors | `9a874022438e1dfbde65fba202c9be23` |

No historical outcome was edited/deleted, no domain objects were reopened or created to clear Coverage, and no Gmail permission/cursor was changed by R02.

Post-write **read-only** dry-run request **1021**: HTTP 200, `changed=false`, 178 keys evaluated, **0 appended resolutions**. This proves unchanged-state replay is idempotent without executing another mutating reconciliation.

An invalid bearer probe returned HTTP 401 `AUTOMATION_AUTH_REQUIRED`. The new RPC deliberately grants `anon` execute only behind the existing Vault worker-token check; `authenticated` execute remains false. Tokens were never exported from Vault.

## Unresolved and deferred observations

The remaining 177 active records are explicitly retained:

| Reason | Count |
| --- | ---: |
| No safe canonical/source identity evidence (`unlinked_unresolved`) | 134 |
| Live process ambiguity | 30 |
| Open semantic decision | 12 |
| Active transport gap | 1 |

These are not fabricated PASS results and are not silently cleared by age. They remain visible active debt; resolving private historical identity/business facts is outside this completed narrow contract.

Supabase advisors report the intentional worker-token-protected `anon` SECURITY DEFINER boundary ([advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)), existing service-only RLS tables without end-user policies ([advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)), and existing disabled leaked-password protection ([documentation](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)). No unrelated auth policy or paid-plan change is part of R02.

Automatic approval review rejected exporting complete timeline payloads for an optional verification. Narrow database aggregates, invariants, command receipt and dry-run readback were used instead; no private timeline was exported and no verification gate was represented as that rejected export.

## Canonical closure

Contract acceptance is based on the immutable lifetime ledger, evidence-backed active reduction, preservation of genuine uncertainty, CAS/provenance receipt, and read-only replay idempotency. Issue #156 may be closed as completed with unresolved business observations retained.

`STATUS.yaml` is canonical: both rounds are closed at their documented production outcomes, the writer is released, and this reliability package is stopped. R02 cron remains inactive. No additional reconciliation write, feature, Release, CGR reopening, or old Reliability Hotfix package reopening is scheduled by this closure.

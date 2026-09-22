# UU-06 Production Closure Evidence — 2026-09-22

Round: `UU-06 — Gmail and Discovery Intake Closure`  
Owner delivery mode: OA-06 10-minute Gmail history polling  
Final runtime: `main@a0dd19046cb4615af07c3d5ffe571bff314431b2`

This evidence is intentionally aggregate/redacted. It contains no raw email body,
token, credential, private workspace export, or unnecessary personal identifier.

## Final implementation and publication gates

PR #114 is the final bounded reliability correction.

Candidate `bc214150c5086e748e8c40819dbc34098f6dafa1`:

- CI `35739928156`: SUCCESS;
- Browser E2E `35739927961`: SUCCESS.

Exact merged runtime `a0dd19046cb4615af07c3d5ffe571bff314431b2`:

- CI `35740220581`: SUCCESS;
- Browser E2E `35740220572`: SUCCESS;
- Deploy `35740220575`: SUCCESS;
- Production Self-Test `35740607006`: SUCCESS;
- Release workflow `35740642068`: SUCCESS with publication still disarmed;
- Vercel commit status: SUCCESS.

The final worker remains bounded:

- PJSDAS controlled Gmail execution ceiling: 25 seconds;
- Vercel `api/automation-gmail.ts` maximum duration: 30 seconds;
- scheduler cadence remains `*/10 * * * *`;
- Gmail permission remains `gmail.readonly`.

No Billing, Pub/Sub, Push activation, IAM expansion, OAuth-scope expansion, or
release-publication authorization was introduced.

## Owner consent and initial coverage

The owner performed the first-party Settings enablement and the production binding
holds explicit `gmail_intake_consent_version=uu06-v1`.

The bounded initial intake:

- covered the previous 90 days;
- included archived mail and excluded spam/trash;
- completed provider pagination before advancing the durable Gmail history watermark;
- wrote the explicit `coverage-boundary:uu06-90-days` marker;
- established a durable Gmail history cursor;
- cleared fallback/page-token/pending-message continuation after complete consumption.

Earlier live failures are retained in history, including disabled Gmail API diagnosis
and bounded-execution exhaustion during initial tuning. They are not rewritten as
successful runs.

## Natural scheduler and live incremental canary

Production pg_cron job 15 runs every 10 minutes. Natural executions were observed
through the complete activation/backfill/incremental sequence.

Final-runtime live canary at `2026-09-22 14:30 UTC`:

- natural cron execution: succeeded;
- worker HTTP result: 200;
- processed users: 1;
- successful users: 1;
- failed/coalesced/deferred users: 0;
- mode: `history`;
- received: 4;
- accounted: 4;
- unresolved: 0;
- execution duration: 9.120 seconds;
- durable history cursor remains present;
- `gmail_last_success_at` advanced;
- `gmail_last_error` is NULL.

This satisfies OA-06's owner-release requirement for truthful scheduled incremental
processing under the real production scheduler.

## Replay and duplicate safety

A previous failed finalization left already-consumed Gmail history records eligible
for replay. Final runtime makes replay source-idempotent by stable Gmail
`sourceRecordId`.

The 14:30 live run provides bounded production proof:

- run received/accounted: 4 / 4;
- outcomes: 2 ignored, 2 duplicate;
- only 2 source-ledger rows were persisted for that run.

Therefore the two replay duplicates were accounted but were not appended again to the
workspace ledger. This breaks the prior retry/rewrite loop while preserving balanced
run accounting and cursor advancement.

Historical duplicate ledger rows created before the correction remain as audit history;
the closure does not rewrite or delete them.

## Shared Semantic Intake / product projection

Production aggregate readback confirms:

- Gmail-owned semantic receipts: 35;
- Gmail receipt affected-object references include ScheduleNode and Opportunity objects;
- the transactional workspace is schema v3 and contains the 90-day coverage marker;
- shared ScheduleNode / Opportunity / Action / TodayBrief contracts remain the product
  projection path; no Gmail-only business-state path was introduced.

This verifies that authorized Gmail facts pass through the frozen shared Semantic
Intake/domain contracts rather than a parallel mutation implementation.

## Safety boundaries retained

- Gmail remains read-only.
- No external application, withdrawal, recruiting email, Offer action, or destructive
  identity operation is authorized.
- Lease/fencing/CAS/complete-consumption cursor rules remain active.
- Push/watch code remains dormant/fail-closed under owner polling mode.
- Release publication remains DISARMED.
- UU-07 is not executed by this closure.

## Closure

UU-06 contract and OA-06 owner override are satisfied on
`main@a0dd19046cb4615af07c3d5ffe571bff314431b2`.

Round state: **COMPLETE**.

The next frozen round may be marked READY, but must not start automatically.

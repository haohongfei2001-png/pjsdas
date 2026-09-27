# R02 / #156 engineering receipt

Scope: existing PR #176, `reliability/active-unresolved-v1`. This round does not reopen Reliability Hotfix or CGR.

## Implementation and review

- Coverage separates active actionable debt from lifetime unresolved audit. Original ingestion ledger entries are retained unchanged; additive resolution records carry outcome, reason and evidence references.
- Worker writes use the repository's `requireWritableWorkspaceSource` capability narrowing and workspace-version compare-and-swap.
- Reconciliation replay is idempotent for unchanged evidence. State transitions can return to a previously observed outcome and append a new audit record. Resolution timestamps increase per source record even when the clock is unchanged, preserving transition order after IndexedDB sorts rows by primary key.
- Multiple same-company candidate processes remain unresolved without durable identity evidence, including when all candidates are terminal. Age alone does not clear debt.
- Scheduler migration provisions an inactive cron job, including on replay. Production activation remains a separate owner decision.

## Verification

Local TypeScript, 19 targeted reconciliation/Coverage/handler/migration tests and two headless Chromium browser integration tests pass. Browser integration exercises durable IndexedDB readback and the Coverage UI/API distinction. Full exact-head CI, Browser, Matrix, Brand and UI evidence is pending remote execution; this receipt does not claim production reconciliation success.

## Authorization boundary

No production Supabase migration has been applied for R02 and no real private workspace reconciliation write has been performed. Both require explicit owner authorization after engineering merge and exact-main verification. Historical unresolved audit is not a failed engineering gate and is not represented as resolved without evidence.

## Final production checkpoint

The authorization-pending text above records the engineering handoff state. It is superseded by [R02-PRODUCTION-RECEIPT.md](R02-PRODUCTION-RECEIPT.md): owner authorization was granted, migration applied, one bounded private workspace write committed, and immutable-ledger/readback/idempotency checks passed. The package is complete with active unresolved observations retained; writer released and R02 cron inactive.

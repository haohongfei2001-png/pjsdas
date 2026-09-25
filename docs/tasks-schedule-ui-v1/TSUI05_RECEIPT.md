# TSUI-05 Exact-Main Closure Receipt

Package: `PJSDAS-TASKS-SCHEDULE-UI-v1`  
Disposition: **ENGINEERING_COMPLETE / PRODUCTION_PENDING; PACKAGE STOPPED**  
Date: 2026-09-25 (UTC)

## Immutable source and merge identity

- Implementation PR [#163](https://github.com/haohongfei2001-png/pjsdas/pull/163) exact head: `3971cb2e0b56bc9ca967d312c1c4cbe111ac34f7`.
- Merge/exact main: `21f247aca2d0801c3df6ad8a99264784098179e0`; tree `906444cc560b0a9b0d416d55e096d61b8ba375df` matches the PR head tree.
- `docs/tasks-schedule-ui-v1/reference/`: zero changed files. Approved prototype, design notes, manifest and screenshots remain immutable design reference; prototype logic was not imported as production code.
- Scope: third real-component visual loop, hard states, responsive and 200% text layouts, Firefox/WebKit, macOS 15 system VoiceOver, fixed-scale performance, active legacy UI cleanup. Existing business, security, transaction, identity, MCP, receipt, Undo and account-isolation paths remain protected by the relevant tests.

## Exact-main engineering gates

| Gate | Result | Evidence |
|---|---|---|
| CI | SUCCESS | [36148717581](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36148717581) |
| Chromium Browser E2E | SUCCESS, 77 passed | [36148717708](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36148717708) |
| Firefox/WebKit and optimized-production performance | SUCCESS, 10 browser + 1 performance | [36148717688](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36148717688) |
| Read-only rollback | SUCCESS | [36148717532](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36148717532) |
| macOS 15 system VoiceOver | SUCCESS, 3 journeys | [36148717814](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36148717814) |

Fixed synthetic scale: 300 jobs, 500 actions, 130 schedule nodes, 2,000 history records. Node full schedule projection P95 38.59 ms; 30-row indexed append P95 0.02 ms. Optimized-production Chromium warm route P95 42 ms and tab P95 43 ms (1280×720, 20 samples; cold network startup excluded). Seven schedule viewport captures span 320–1920 px; actual 200% text at 320 and 390 px has no horizontal overflow. See [TSUI05_VISUAL_REVIEW.md](TSUI05_VISUAL_REVIEW.md) for screenshots, critique, fixes and measurement limits.

## Production gate and deferred evidence

[Pages exact-main run 36148717592](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36148717592) **FAILED** after 40 checks for an exact-SHA backend; its deploy job was skipped. The merge commit's [Vercel status](https://api.github.com/repos/haohongfei2001-png/pjsdas/commits/21f247aca2d0801c3df6ad8a99264784098179e0/status) was **FAILURE**, description: “Deployment rate limited — retry in 24 hours.” The prior TSUI-04 closure SHA encountered the same limit; the earlier TSUI-04 implementation SHA had deployed successfully. The Pages gate correctly prevented a mismatched release. Cloudflare standby is unconfigured; no alternate account, secret, paid upgrade or bypass was introduced.

Thus the TSUI-05 live visual workflow did not run. Same-SHA live frontend/backend, online screenshots, private production-workspace canary and production frontend rollback remain **PENDING/DEFERRED**. Human five-second comprehension, physical-device soft-keyboard checks and independent human integration review are **DEFERRED**. System VoiceOver automation is real assistive-technology evidence, not a human review. Do not claim `PRODUCTION_VERIFIED` or `PRODUCT_ACCEPTED`.

When the external deployment limit clears, publish an exact-SHA backend first, then rerun the Pages gate and live visual/canary checks against the same SHA. TSUI-05 engineering work is closed; this package stops here and does not advance to another product line.

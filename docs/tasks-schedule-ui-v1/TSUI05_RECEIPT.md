# TSUI-05 Exact-Main Closure Receipt

Package: `PJSDAS-TASKS-SCHEDULE-UI-v1`  
Disposition: **ENGINEERING_COMPLETE / LATER EXACT-LIVE TECHNICAL VERIFIED; PRIVATE CANARY DEFERRED; PACKAGE STOPPED**  
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

At the original implementation SHA, the TSUI-05 live visual workflow did not run. The rate-limited release failure above is retained as historical evidence and is superseded by the later exact-live continuation below.


## Later exact-live continuation after the reliability correction

The owner reported a production Today false-conflict banner while the readable server workspace reached `txn:442`. The full-snapshot `localChanged` path was traced to local read projections plus newer server ingestion audit; the guarded correction still rejects independent local edits. Reliability [PR #166](https://github.com/haohongfei2001-png/pjsdas/pull/166) and live fixture [PR #167](https://github.com/haohongfei2001-png/pjsdas/pull/167) were merged without touching `reference/`. The first exact-live run [36153420227](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36153420227) failed because the JobLibrary fixture opened the GitHub Pages account root rather than `/pjsdas/`; Today and Schedule passed in that run. PR #167 corrected the route and app-readiness check.

Later code main `d0e414deb25fe960be92ec44ab2e68f39df1e6a5` has SUCCESS CI [36154517485](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36154517485), Chromium [36154517475](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36154517475), Firefox/WebKit [36154517483](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36154517483), [Vercel deployment status](https://api.github.com/repos/haohongfei2001-png/pjsdas/commits/d0e414deb25fe960be92ec44ab2e68f39df1e6a5/status), Pages [36154517480](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36154517480) and production self-test [36154693353](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36154693353). The live workflow [36154693318](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36154693318) verified the exact Pages manifest SHA and passed 3/3 synthetic real-frontend Today, JobLibrary and Schedule journeys; [screenshots artifact](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36154693318/artifacts/10872494335). This supports **EXACT-LIVE TECHNICAL VERIFIED** for that later SHA, not the earlier rate-limited implementation SHA.

The owner's current browser cache was not inspected, so clearing that specific banner is not directly proven. Private production-workspace canary, human five-second comprehension, physical-device keyboard, independent human review and actual frontend production rollback remain **DEFERRED**. System VoiceOver automation is real assistive-technology evidence, not a human review. Do not claim `PRODUCT_ACCEPTED`. The package remains stopped after TSUI-05.

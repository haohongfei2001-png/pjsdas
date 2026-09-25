# PJSDAS Reliability Hotfix v1 — Status

- Package: `PJSDAS-RELIABILITY-HOTFIX-v1`
- Status: **COMPLETE — writer released; package stopped**
- Certified production commit: `058bc6de04a5b08685505870860239b24648717f`
- Writer: PR [#152](https://github.com/haohongfei2001-png/pjsdas/pull/152), squash-merged 2026-09-25

| Round | Final state | Certified result |
|---|---|---|
| RH-01 — Posting Identity Safety | COMPLETE | Exact canonical posting identity takes precedence over weak company/role/location similarity. Production canary created two independent Opportunities for two exact URLs and deduplicated the tracking variant. |
| RH-02 — Stable MCP Tool Exposure | COMPLETE | Authenticated production `tools/list` exposed `add_opportunities`, `ingest_discovery_run`, and `ingest_gmail_run`. A no-grant call to the advertised discovery tool reached the handler and returned `AUTH_FORBIDDEN`, with no workspace revision change. No grant was expanded. |
| RH-03 — Automation Completion Truth | COMPLETE | Completion states distinguish checks from durable source commits; `discoveryLastSuccessAt` advances only after a durable source completion, and ingestion receipts retain producer for Coverage. This is completion of the truth contract, not a claim that the owner's discovery automation has been activated or that all four monitors have durable server runs. |
| RH-04 — Production Validation & Reconciliation | COMPLETE | Latest PR and exact-main CI/Browser were clean; exact production deploy, self-test, MCP/posting-identity canary, and synthetic cleanup passed. Historical reconciliation identified an ambiguous real record and deferred unsafe mutation. |

## Canonical production receipt

- PR head `37441a7b9f4245f9766db51f6388f6ecd9aae57b`: [CI](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36100618233) SUCCESS; [Browser E2E](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36100618250) 71/71 passed, zero retry/flaky.
- Squash main `058bc6de04a5b08685505870860239b24648717f`: [CI](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36100919625) SUCCESS; [Browser E2E](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36100919710) 71/71 passed, zero retry/flaky. The account A sign-out/account B isolation case passed on its first attempt.
- [GitHub Pages exact-backend gate and frontend deployment](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36100919658) SUCCESS; [Production Self-Test](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36101071194) SUCCESS. Live production API health and frontend release manifest were re-read and both reported the certified commit above.
- [Reliability Hotfix Production Certification](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36101071220) ran its synthetic canary on that exact SHA and reported PASS for stable tool exposure, no-grant `AUTH_FORBIDDEN`, denied-call no-write, distinct posting identity, tracking-query deduplication, and verified zero synthetic auth identity/audience grant/workspace/ledger residuals. The canary explicitly did **not** certify delegated ChatGPT-host OAuth or owner discovery activation.
- [Release workflow](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36101107569) skipped GitHub Release creation (`publishOnProductionSuccess=false`). No new Release was published.

## Unresolved / deferred observations outside the completed hotfix

1. **Real ChatGPT-host connector:** This Codex/Work host exposes no PJSDAS or Todayaction connector, so its delegated OAuth registration, metadata snapshot, and real list-to-call behavior remain `HOST_CONNECTOR_UNAVAILABLE` here. Direct production MCP passed; delegated-host PASS is not claimed. No OAuth client or source grant was created to bypass the gap.
2. **Owner automation activation:** Production advertises discovery automation capability, but no fresh authenticated owner Settings/source-registry/scheduler-claim/durable-receipt read was available here. The handoff's `discovery_automation_enabled=false` and missing four monitor receipts are historical, not a current read. Do not call the four monitors server-owned, retire their ChatGPT Tasks, or enable recurring real-job ingestion without an explicit owner opt-in and durable `producer=server_scheduler` receipts.
3. **Historical workspace data:** No fresh owner workspace revision was available, so no real record was changed. The official [小红书 campus list](https://job.xiaohongshu.com/campus/theme) shows an RPT community-product posting, while the separately indexed official [`/campus/intern/position/22164` page](https://job.xiaohongshu.com/campus/intern/position/22164?referer_code=Z8KHV5CZLCDI) identifies AI-platform product; the community and commercial exact posting URLs were not safely resolved. The apparent missing community Opportunity and generic commercial source URL remain for a later evidence-bound review. No Process, Action, assessment, interview, or user decision was copied or modified.

CGR remains COMPLETE. This closure adds no feature, new CGR, UU-08/UU-09 work, iPhone work, OAuth expansion, real recruiting action, or release publication. The sole hotfix writer is released and this package stops here.

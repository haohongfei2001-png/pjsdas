# PJSDAS Reliability Hotfix v1 — Status

Package: PJSDAS-RELIABILITY-HOTFIX-v1
Status: ACTIVE
Baseline: main@51d3299ff5c984fc374037d0239b97d76d214f90
Writer: hotfix/pjsdas-reliability-v1

| Round | State | Goal |
|---|---|---|
| RH-01 | ENGINEERING_COMPLETE / CI_PASS | Exact posting identity now outranks weak logical similarity across explicit add, proposal/inbox, discovery screening, promotion and monitor ingestion; distinct posting IDs/URLs remain distinct and unproven reposts no longer auto-supersede |
| RH-02 | ENGINEERING_COMPLETE / CI_PASS | Authenticated release tools are registered stably; source-scoped grants authorize calls inside handlers, so no-grant calls fail as AUTH_FORBIDDEN rather than advertised Tool not found |
| RH-03 | ENGINEERING_COMPLETE / CI_PASS | Discovery automation now separates checked/not-due/not-configured/verified-not-committed/committed/committed-with-exceptions; durable ingestion runs record producer and Coverage exposes it; discoveryLastSuccessAt advances only after durable source completion |
| RH-04 | IN_PROGRESS | Full browser/build certification, exact-production MCP list→call validation, posting-identity canaries, and evidence-driven historical reconciliation |

CGR remains COMPLETE and is not reopened.

## Stop conditions

Stop only for a new cost/permission/privacy boundary, destructive ambiguous historical repair, or unavailable external production-host action. Ordinary implementation and test failures are autonomous.


## Engineering checkpoint

Fresh remote checkpoint before the current repair: PR #152 head `90d88d8c35bc9ce5ed318aaf0d2b3af837b7c70b`; main `51d3299ff5c984fc374037d0239b97d76d214f90`.

CI `36091497438`: SUCCESS. Browser `36091497481`: 70 passed, 1 flaky; the account A sign-out / account B isolation journey passed only on retry. Its first-attempt trace shows the sign-out click overlapping initial account sync and a pending-command retry. The journey now waits for A's durable sync checkpoint before exercising sign-out, while retaining the IndexedDB, draft, and cross-account replay assertions. Full clean browser certification is still pending.

The RH-04 production canary plan completed locally without network access. Its execution waits for the exact API and frontend SHA before creating a synthetic identity, and reports PASS only after verifying zero synthetic auth, audience grant, workspace, and ledger residuals. Production certification and delegated ChatGPT-host certification remain pending; current production health and frontend manifest both report main `51d3299ff5c984fc374037d0239b97d76d214f90`.

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

Latest single-writer branch checkpoint: `3a817e920613fea93c58a975ba5560290512351c`.

Draft inner-loop CI run `36041936406`: SUCCESS. RH-01, RH-02 and RH-03 are engineering-complete; production claims remain pending RH-04.

# PJSDAS Reliability Hotfix v1

Package: PJSDAS-RELIABILITY-HOTFIX-v1
Baseline: main@51d3299ff5c984fc374037d0239b97d76d214f90
Scope: bounded reliability repair after CGR closure

This package does not reopen PJSDAS-CONSUMER-GRADE-REFOUNDATION-v1 and does not authorize new product features.

## Verified defects

1. Posting identity precedence permits weak company/role/location similarity to suppress or merge a different exact posting identity before URL/posting identity is considered.
2. Authenticated MCP release surface advertises trusted-ingestion tools while runtime registration can remove them based on per-client grants, allowing an advertised tool to fail as "Tool not found".
3. Discovery/monitor execution has multiple producers and completion semantics that can report a successful check without proving a durable source run.

## Frozen repair order

- RH-01 — Posting Identity Safety
- RH-02 — Stable MCP Tool Exposure
- RH-03 — Automation Completion Truth
- RH-04 — Production Validation & Reconciliation

No historical bulk replay or data repair may run before RH-01 is complete.

## Boundaries

No new paid service, OAuth expansion, external recruiting action, release publication, new CGR phase, UU-08/UU-09, or unrelated product work.

Historical data repair must be evidence-driven, revision-bound, auditable and non-destructive to recruiting Process/Action state unless identity evidence explicitly supports a change.

# AURR v1 Repair 01 Dry-Run Receipt

Package: `TODAYACTION-ACTIVE-UNRESOLVED-REDUCTION-v1`

Repair: `legacy_gmail_capability_boundary_only`

Exact runtime main:

`d40237a3ef4029633c560267adbd7dffc1b88385`

## Exact-main verification

- CI: SUCCESS
- Browser E2E: SUCCESS
- Firefox/WebKit Matrix: SUCCESS
- GitHub Pages deploy: SUCCESS
- Production Self-Test: SUCCESS
- Reliability Production Certification: SUCCESS
- CGR Final Production Certification: SUCCESS
- TodayAction Production Brand Readback: SUCCESS
- Live Visual: SUCCESS

## Read-only production dry-run

Request id: `1033`

Workspace revision before: **642**  
Workspace revision after: **642**

The dry-run therefore performed no transactional workspace write.

Result:

- unresolved source keys evaluated: **189**
- proposed resolution records: **47**
- proposed `historical_only`: **31**
- proposed `active_unresolved` refresh/new records: **16**
- failed workspaces: **0**

Current durable resolution state before a real write:

- lifetime unresolved keys: **189**
- active unresolved with current resolution: **177**
- unresolved keys not yet carrying a resolution record: **11**
- non-active resolution keys: **1**

If the exact dry-run proposal were committed once, the expected active unresolved count is **157**:
189 lifetime keys - 32 non-active resolutions (existing 1 + new 31) = 157.

The 31 safe settlements exactly match the earlier read-only SQL projection. They are limited to legacy Gmail records whose entire unresolved reason is a link/attachment capability-boundary marker and which have no issueKinds, linked Opportunity/Event/Action, company/role identity, or stronger semantic decision.

This receipt does not authorize or perform the production write. The R02 reconciliation cron remains inactive.

# AURR v1 Repair 01 Production Receipt

Package: `TODAYACTION-ACTIVE-UNRESOLVED-REDUCTION-v1`

Repair: `legacy_gmail_capability_boundary_only`

Runtime main: `d40237a3ef4029633c560267adbd7dffc1b88385`

## Production write

Authorized bounded request: `1038`

Workspace revision:

- before: **642**
- after: **643**

Worker result:

- processed workspaces: **1**
- successful workspaces: **1**
- failed workspaces: **0**
- unresolved source keys evaluated: **189**
- appended resolution records: **47**
- appended `historical_only`: **31**
- appended/refreshed `active_unresolved`: **16**

Durable readback after the write:

- lifetime unresolved keys: **189**
- active unresolved: **157**
- non-active resolution keys: **32**
- unresolved keys without a resolution record: **0**
- `legacy_capability_boundary_only` historical resolutions: **31**
- reconciliation cron active: **false**

The original ingestion ledger remains present. No Gmail permission, cursor, OAuth identity, or scheduler activation changed.

## Idempotency

Read-only dry-run request: `1040`

Result:

- changed workspaces: **0**
- appended resolution records: **0**
- workspace revision remained **643**

Therefore Repair 01 is idempotent on the resulting production state.

Repair 01 reduced active unresolved from **177 → 157** while keeping all **189** lifetime unresolved source keys in the audit history.

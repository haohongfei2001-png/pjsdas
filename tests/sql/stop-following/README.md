# Approved single-job stop-following — private validation

PR257's approved design depicts **不再跟进** in job detail. This fills that
contextual internal action; it does not withdraw applications, close recruiting
processes, change shared capacity, remove jobs, or add a batch/global operation.

Fresh first-party domain admission uses the same shared-governance predicate as
Semantic Intake. Governed requests are refused before reduction with a known
non-retryable `SHARED_GOVERNANCE_REQUIRED` response and directed to the existing
Tell / DecisionRequest confirmation path. The existing receipt/prepared-intent
recovery remains before this fresh check; CAS retries re-read current governance.
No confirmation override, family allowlist, SQL, authority, or quota is expanded.

The connected control persists only an account/job-scoped versioned locator.
The existing outbox and scheduler own the original command and Undo. Receipt
identity/operation/job/undoOf are checked; no receipt means no invented Undo.
Native Web Locks coordinate this control across same-origin tabs. Unsupported
browsers are directed to the unchanged Tell path, not silently downgraded.
This is not a cross-device lock. Local-only mode retains the existing semantic
receipt/Undo behavior; cross-reload local Undo is not newly promised.

## Evidence boundaries

- `stopFollowingGovernance.test.ts`: actual executor with synthetic in-memory row
  store, CAS/revision races, semantic policy equivalence and immutable resume.
- `stopFollowingCommand.test.ts`: actual existing connected client with mock HTTP
  and mock LockManager; not native browser, IndexedDB or multiple real tabs.
- `stopFollowingSurface.test.ts`: SSR and source assertions, not browser clicks.
- `node tests/sql/stop-following/run.mjs /absolute/unique/outside-checkout/run`:
  **API-only** native fixture. Requires already-owned loopback PostgreSQL and the
  original environment/binaries used by native gates. Three fixed labels prove
  ordinary save/original Undo, shared-policy refusal, and no-prior-reservation
  large refusal. Full tracked Git blobs and native manifests are verified before
  and after; each isolated database/role/process is cleaned. The runner never
  owns/stops an externally provided parent PostgreSQL server.

No synthetic command reservation is inserted by this gate. Existing durable-v2
admission requires an exact prior `large_document_reservation`; no production
allocator or browser admission capability is added. Thus a >2000-effect direct
command without that authorization must fail closed, not be reported as admitted
consumer-v2 recovery. The original 16/32/264 MiB caps, 10-second attempts,
2184 kB work_mem, default-off fixture-only SQL and reclamation policy remain.

Actual browser acceptance (clicks, close/back, reload, keyboard focus, real
Web Locks/multi-tab, account-switch rendering) remains **NOT_RUN** unless a real
authorized browser executes it. API-only mode has no browser fallback or UI PASS.
It does not repeat or relabel the historical 3-small-consumer or a29 pair gates.

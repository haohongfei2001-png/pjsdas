# v1.9 Autonomous Ingestion & Reconciliation

## Goal

PJSDAS should no longer require a review click for routine factual intake from trusted, bounded sources.

The user should be able to let:

- ChatGPT / GPT job-monitor runs discover public job postings,
- Gmail ingestion observe recruiting-process messages,
- natural-language updates describe personal progress,

without creating parallel copies of the same logical job and without wondering whether some source record silently disappeared.

The product promise is deliberately narrower than “PJSDAS found every job on the internet”:

> For every source that is connected to PJSDAS, every input submitted in its latest completed ingestion run is durably accounted for as a known outcome. No submitted source record is silently dropped.

## Architecture

```text
Trusted source
  -> bounded source records
  -> Ingestion Ledger
  -> identity resolution / quality gate
  -> canonical Opportunity / Process Event / Action
  -> reconciliation run
  -> Google Drive workspace
  -> local IndexedDB sync
  -> Coverage indicator
```

The local browser remains local-first. Google Drive `appDataFolder` remains the durable private workspace copy and the bridge between unattended ingestion and the active browser.

Supabase provides stable account identity and encrypted Google refresh-token binding. PJSDAS does not introduce a separate server-side job-search database.

## Trust boundary

### Autonomous factual ingestion

The following may auto-apply through the bounded trusted-ingestion tools:

- a source-backed job observation from a completed monitoring run;
- a new Opportunity derived from an eligible public posting;
- an additional source for an existing logical job;
- deterministic duplicate suppression;
- explicit quality-filter outcomes;
- high-confidence structured Gmail recruiting facts;
- high-confidence Process Events and their deterministic Actions;
- explicit source records that cannot be resolved safely, stored as `unresolved` exceptions.

### Still review-only

`propose_changes` remains review-only for changes that represent judgment, policy, ambiguity, or destruction, including:

- Decision Rules;
- Discovery Profile / durable user preferences;
- deleting data;
- deciding not to pursue an Opportunity;
- ambiguous company / role merges;
- uncertain recruiting-process interpretation;
- other user-decision mutations.

“Autonomous” therefore means **factual intake is unattended**, not “AI may freely mutate the workspace.”

## Ingestion Ledger

Each source record produces a durable `TimelineRecord` with structured `ingestion` metadata:

- `sourceKind`
- `sourceId`
- `sourceRecordId`
- `runId`
- `recordType`
- `outcome`
- `fingerprint`
- `receivedAt`
- `accountedAt`
- optional canonical object references

Supported outcomes:

- `created`
- `merged`
- `updated`
- `duplicate`
- `filtered`
- `ignored`
- `unresolved`

A failed identity interpretation is not dropped. It becomes an explicit `unresolved` record.

## Reconciliation invariant

Every completed ingestion run must satisfy:

```text
receivedCount
  = accountedCount
  = created
  + merged
  + updated
  + duplicate
  + filtered
  + ignored
  + unresolved
```

Snapshot validation rejects a stored completed run that violates this invariant.

This is the basis of the Coverage UI. A green state is derived from durable ledger facts rather than from a transient success toast.

## Idempotency

Two identities are important:

### Run identity

A completed `(sourceKind, sourceId, runId)` is idempotent. Replaying the exact run returns the existing run summary and does not write a second workspace mutation.

### Source-record identity

A stable `(sourceKind, sourceId, sourceRecordId)` is retained across runs. If a monitor or Gmail connector sees the same durable source item again, PJSDAS accounts it as `duplicate` instead of creating another object.

For Gmail, `sourceRecordId` should be the Gmail message ID.

For job monitors, `sourceRecordId` should be a stable per-result identity supplied by the monitoring workflow, preferably derived from the canonical public posting / ATS identity rather than array position.

## Opportunity identity and deduplication

PJSDAS separates source observations from logical jobs.

A new observation does not automatically imply a new Opportunity.

Identity resolution uses existing job-source canonicalization and role similarity. Monitoring and Gmail ingestion attempt to merge into an existing logical Opportunity before creating a new one.

Natural-language updates receive a final identity guard as well:

- known company aliases such as JD / JDS / 京东 are normalized for matching;
- formatting and minor role-name differences may reuse the existing Opportunity;
- a unique high-confidence match may auto-merge;
- multiple equally plausible roles fail closed as `unresolved` rather than using the old “first substring match” behavior.

The system preference is:

> temporary uncertainty is safer than a duplicate job or an incorrect merge.

## GPT Monitor ingestion

Authenticated MCP exposes:

`ingest_discovery_run`

A monitoring workflow submits the entire bounded result set for one completed run. It does **not** pre-drop inconvenient candidates merely because it expects PJSDAS to reject them.

PJSDAS itself performs:

1. source-record idempotency;
2. explicit Discovery Profile / Decision Rules quality gates;
3. logical-job matching;
4. public-source evidence merge;
5. new Opportunity creation when appropriate;
6. ledger accounting;
7. run reconciliation;
8. optimistic Drive workspace write.

A zero-result run is valid and is still a durable completed run with `0 = 0` accounting.

## Gmail ingestion

Authenticated MCP exposes:

`ingest_gmail_run`

The connector layer is responsible for reducing mail into bounded structured facts before submission. PJSDAS does not need to persist raw email bodies.

Submitted facts include stable message ID, received time, classification, confidence and — when safely extracted — company, role, event type, timing and stage.

Rules:

- `ignored` mail is accounted but creates no job-search object;
- high-confidence recruiting facts may update/create workspace facts automatically;
- low/medium-confidence or identity-incomplete recruiting mail becomes `unresolved`;
- ambiguous mail is never forced onto a guessed Opportunity;
- one deterministic Gmail Process Event produces one deterministic Process Action.

This keeps mailbox privacy separate from durable job-search state.

## Natural-language ingestion

Natural-language updates remain user-initiated, but opportunity identity now follows the same “canonical object before new object” principle.

Process completion semantics from the v1.8 correctness audit remain unchanged: an explicit completed assessment/written test/interview completes the existing deterministic Process Action rather than creating another Process Event.

## Coverage

The global Coverage indicator has four meaningful states:

- no autonomous run yet;
- `All caught up`;
- explicit unresolved exceptions;
- unavailable / inconsistent coverage.

Its detailed view shows per-source latest-run accounting:

```text
Monitor · role-discovery-a
received 17
accounted 17
new 4 · merged 7 · duplicate 4 · filtered 2

Gmail · primary
received 6
accounted 6
updated 3 · ignored 2 · unresolved 1
```

When unresolved records exist, Coverage is not green even though the accounting equation still balances.

Important limitation:

> Coverage can prove that connected-source records submitted to PJSDAS were not silently lost. It cannot prove that a search engine, Gmail itself, or the public internet contained no unseen information.

## Concurrency and fail-closed writes

Autonomous ingestion writes to the authenticated Google Drive workspace only through the writable Drive source.

Each write carries the exact `workspaceVersion` read at the beginning of ingestion.

Before upload, PJSDAS rechecks the Drive file version. If the workspace changed, the write fails with `WORKSPACE_CONFLICT` and is retryable from the newest snapshot.

No stale autonomous writer may overwrite a browser change merely because both were valid individually.

## Account/session dependency

v1.9 incorporates the stable-account work originally developed as v1.8.1:

- Supabase Auth session persists in localStorage;
- PKCE + automatic Supabase token refresh;
- Google refresh token remains encrypted server-side;
- browser requests only short-lived Google Drive access tokens;
- refresh / browser reopen should preserve PJSDAS identity;
- sign-out does not delete local IndexedDB data;
- legacy Google subject remains compatible with existing local workspace ownership.

This is necessary because unattended server-side ingestion would otherwise update Drive while a refreshed browser had no durable way to retrieve that state.

## MCP tools

Read:

- `get_coverage_status`

Trusted autonomous mutation:

- `ingest_discovery_run`
- `ingest_gmail_run`

Review-only mutation remains:

- `propose_changes`

The authenticated gateway is the only production source intended to enable trusted ingestion. Demo/file sources remain read-only.

## Release gate

v1.9 must not publish its GitHub Pages frontend before the backend runtime is deployed and verified.

Required order:

1. deploy backend including `/api/google-access-token` and the v1.9 authenticated MCP toolset;
2. verify `/api/health` reports v1.9 trusted-ingestion capabilities;
3. verify the token endpoint exists and fails cleanly without authentication rather than returning 404;
4. verify MCP exposes `get_coverage_status`, `ingest_discovery_run`, and `ingest_gmail_run` to an authenticated account;
5. only then merge/publish the frontend;
6. perform real Google login -> refresh -> reopen -> sync validation;
7. then rewire actual GPT monitors and Gmail automation to the new tools.

Until those gates pass, the PR may be code-complete while the currently published v1.8 site remains untouched.

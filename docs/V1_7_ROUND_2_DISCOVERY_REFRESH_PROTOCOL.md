# v1.7 Round 2 — Discovery Refresh Protocol

## Goal

Close the two first-version gaps left by v1.7 Continuous Discovery without weakening PJSDAS's review-only mutation boundary:

1. a stale posting in `refreshQueue` can be re-verified and safely written back after explicit review;
2. a discovery pass with zero eligible candidates can still become an auditable durable Discovery Run.

This round does **not** add a crawler, scheduler, autonomous background refresh, automatic application, implicit Opportunity closure, or learned Discovery Profile mutation.

## 1. Review-only posting refresh

`get_discovery_context.continuousDiscovery.refreshQueue` exposes an exact refresh identity:

- `ownerKind`
- `ownerId`
- `postingId`
- `canonicalSourceUrl`
- current source URL / host
- freshness and last verification time

A capable AI client verifies that exact public source, then submits a separate `postingRefreshes` proposal through the existing `propose_changes` tool.

The normalized ChangeSet operation is `refresh_job_posting`.

### Required safety checks

The server proposal layer and local Apply layer both verify:

- the owner still exists;
- the exact posting id is still bound to that owner;
- the canonical source URL has not changed;
- the refreshed `sourceUrl` canonicalizes to the same source.

If any baseline has changed, the operation fails closed and the client must read a fresh Refresh Queue.

A different canonical source URL is **not** a refresh. It represents a newly discovered / re-posted / replacement source and must go through normal discovery identity/freshness review.

## 2. What a refresh may update

A refresh may update source-backed evidence for the same posting:

- `postingStatus`: `open | closed | unknown`
- `lastSeenAt`
- `lastVerifiedAt`
- source title / URL variant
- location when explicitly supported
- deadline when explicitly supported
- compensation text when explicitly supported

It preserves `firstSeenAt` for the same canonical posting and uses the existing posting merge/history semantics.

### Critical lifecycle boundary

`postingStatus = closed` means **the public source is closed**.

It does not automatically set:

- `Opportunity.processStage = closed`
- Process = closed
- application Action = skipped
- Discovery Inbox = dismissed

Opportunity/process lifecycle remains a separate explicit state transition. One public posting disappearing or closing is evidence, not a user decision about the whole opportunity.

## 3. Zero-eligible Discovery Runs

In v1.7 R1, a search where every result was duplicate / filtered had no reviewed ChangeSet and therefore no durable Run record.

Round 2 adds `record_discovery_run` as a review-only ChangeSet operation.

When a discovery pass has zero accepted candidates:

- quality-gate diagnostics are still generated;
- a `DiscoveryRunRecord` is attached to the signed ChangeSet;
- the ChangeSet contains only `record_discovery_run`;
- Apply records the Run and standard ChangeSet audit entry;
- no Opportunity, Action, Process or Inbox item is created.

Discard means the run is not accepted into the durable workspace audit history beyond the discarded ChangeSet state.

## 4. Explicit Discovery Run context

`propose_changes` accepts optional `discoveryRunContext` only with discovery or posting-refresh batches:

- `mode`: `ad_hoc | full | incremental | refresh`
- `startedAt`
- `queries`
- `searchedSourceHosts`

If supplied, this context is validated and signed into the proposal. The proposal-envelope fallback only synthesizes `ad_hoc` metadata for older clients that do not provide explicit context.

PJSDAS never fabricates queries or claims sources were searched when the client did not report them.

## 5. Apply architecture

Server side:

`propose_changes` → validate workspace + exact posting baseline → signed review URL

No server-side workspace mutation occurs.

Local side:

open signed review → verify signature/expiry/workspace fingerprint → explicit Apply → re-check exact posting baseline → local IndexedDB transaction → normal Drive sync path

`refresh_job_posting` writes owner source evidence + Timeline + applied ChangeSet in one local transaction.

`record_discovery_run` writes only ChangeSet/Timeline audit state.

## 6. Persistence

No new IndexedDB store and no snapshot version migration.

Round 2 data uses existing structures:

- posting evidence already lives inside Opportunity / Discovery Inbox;
- Discovery Run metadata already lives on ChangeSet;
- ChangeSets are already included in snapshot, Drive sync, backup and workspace fingerprint.

Snapshot remains v1.

## 7. Acceptance criteria

Round 2 is complete when:

- exact same-source posting refresh can be proposed and signed;
- stale posting identity fails closed;
- a different canonical URL cannot overwrite an existing posting;
- refresh Apply advances verification evidence;
- a source can become `closed` without closing the Opportunity;
- zero-eligible discovery produces a signed review-only Run record instead of an error;
- applying that Run creates no Opportunity or Action;
- old discovery clients remain compatible;
- health/smoke contracts advertise the new capabilities;
- dependency audit, unit tests, TypeScript and production build pass.

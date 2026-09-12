# PJSDAS v1.7 — Continuous Discovery

## Goal

Move job discovery from repeated stateless full searches toward an auditable continuous loop without introducing a crawler, scheduler, autonomous application agent, or hidden preference learning.

The v1.7 loop is:

`durable Discovery Profile + existing workspace + prior reviewed Discovery Runs`
→ `incremental / refresh guidance`
→ `ChatGPT public-web search outside PJSDAS`
→ `existing source-backed quality gate`
→ `signed review-only ChangeSet`
→ `Apply / Save to Discovery Inbox / Discard`
→ `durable Discovery Run history`
→ `next incremental baseline`

PJSDAS continues to own state, identity, freshness, quality gates, review semantics, and durable history. The AI client still owns public-web retrieval.

## 1. Discovery Run is audit metadata, not a second database

v1.7 does not add an IndexedDB store and does not bump the snapshot schema. A `DiscoveryRunRecord` is bounded optional metadata on an existing discovery `ChangeSetRecord`.

This is intentional:

- ChangeSets already participate in IndexedDB, snapshot export, Google Drive sync, backup/restore, workspace fingerprints, and review/audit semantics.
- A separate Run store would create another synchronization surface for facts that already belong to the proposal/review event.
- Existing snapshot v1 workspaces remain valid; older ChangeSets simply have no Discovery Run metadata.

A Run records:

- mode: `ad_hoc | full | incremental | refresh`
- started/completed time
- baseline workspace version
- optional search queries and searched source hosts
- source hosts that produced reviewable candidates
- received / review / duplicate / filtered / deferred counts

## 2. Legacy connector behavior

The current `propose_changes` discovery schema is intentionally not expanded just to require Run metadata.

When an existing connector submits source-backed `discoveredOpportunities`, PJSDAS automatically attaches a signed Run using the already signed quality-gate diagnostics and accepted candidate source URLs.

Because the connector did not explicitly declare a search strategy, that Run is recorded as `ad_hoc`. PJSDAS must not falsely label it `full` or `incremental`.

Future clients may supply richer bounded search context, but v1.7 does not make that a prerequisite for continuity.

## 3. Durable outcomes

Run outcome is derived from existing state instead of introducing another status machine:

- ChangeSet `applied` → `applied`
- ChangeSet `discarded` with Discovery Inbox items carrying its `sourceChangeSetId` → `saved_to_inbox`
- ChangeSet `discarded` without such Inbox items → `discarded`
- ChangeSet `pending` → `pending`
- ChangeSet `failed` → `failed`

`selectedCount` means jobs actually retained by the user's decision. It is non-zero only for `applied` or `saved_to_inbox` outcomes.

Opening a signed review URL alone does not create durable Run history.

## 4. Incremental discovery context

`get_discovery_context` remains the required first read before public-web job discovery. v1.7 adds a `continuousDiscovery` section containing:

- durable Run count
- last Run summary
- `incrementalSince`
- suggested next mode
- recent recorded queries when available
- bounded source coverage
- aggregate quality-gate totals
- bounded posting refresh queue

Normal discovery should prefer new or materially updated postings since `incrementalSince` rather than re-searching the entire historical space without a reason.

The baseline is guidance, not a claim that public search engines provide exhaustive timestamp filtering.

## 5. Source coverage

Source coverage is derived only from durable Runs. It is not a universal statement that a site was exhaustively searched.

For each host PJSDAS can show:

- number of recorded Runs covering that source
- number of Runs in which the source produced reviewable candidates
- last recorded Run time

Older/ad-hoc clients can initially provide only productive candidate hosts. PJSDAS must not invent broader search coverage.

## 6. Posting refresh queue

The refresh queue is derived from existing Opportunity / Discovery Inbox posting evidence and v1.4 freshness rules.

Eligible entries are active postings whose current evidence is:

- `aging`
- `stale`
- or otherwise `unknown`

The queue excludes:

- explicitly closed postings
- dismissed/promoted Inbox records
- fresh sources
- historical sources already superseded by a newer posting

A refresh item means: **verify this existing source again**. It does not mean: **create another Opportunity**.

### Important v1.7 boundary

The refresh queue is read-only guidance in this PR. v1.7 does **not** silently write a refreshed status back into an existing Opportunity. Existing discovery re-observation semantics can update Inbox evidence when a source-backed candidate is explicitly reviewed, but a generic background refresh mutation path is not introduced here.

## 7. Continuous Discovery Radar

The local UI provides a read-only Discovery Radar showing:

- recorded Run count
- cumulative screening totals
- suggested next mode
- incremental baseline
- source coverage
- posting refresh queue
- recent durable Runs and their outcomes

The Radar does not search the web and contains no automatic-apply control.

## 8. Safety and non-goals

v1.7 explicitly does not add:

- a scheduled crawler
- background web polling
- autonomous job applications
- silent Inbox → Opportunity promotion
- automatic Discovery Profile learning/rewrite
- hidden preference weights
- a new LLM/API dependency
- fuzzy duplicate identity replacing the deterministic v1.4 identity layer

All public-web discovery still happens in the AI client and all durable mutations still cross the existing explicit review boundary.

## 9. Known first-version limitations

### Zero-eligible searches

If every submitted candidate is duplicate or rejected by the quality gate, the current `propose_changes` path returns `NO_CHANGES` / `DISCOVERY_NO_ELIGIBLE_CANDIDATES` and creates no signed ChangeSet. Therefore that search is not yet a durable Discovery Run.

PJSDAS must not claim otherwise. A future round can introduce a separate reviewed/read-safe way to persist zero-result search telemetry if real usage shows it is valuable.

### Query coverage

Legacy connector schemas do not submit exact public-search query text. Those Runs still record outcome and productive source hosts, but `queries` may be empty. v1.7 does not fabricate query history.

### Refresh write-back

The queue tells the AI/user what should be verified next. A dedicated bounded write protocol for updating an existing posting after verification is deferred.

## Acceptance criteria

1. Old snapshot v1 workspaces and ChangeSets without Discovery Run metadata remain readable.
2. Source-backed discovery proposals automatically carry signed bounded Run metadata.
3. Run metadata survives Apply, Save to Discovery Inbox, Discard, snapshot, Drive sync, backup and workspace fingerprint through the existing ChangeSet path.
4. Applied vs Inbox-saved vs discarded outcomes are distinguishable without a parallel status store.
5. `get_discovery_context` exposes a deterministic incremental baseline, source coverage and refresh queue.
6. Superseded/closed/dismissed sources do not pollute the refresh queue.
7. UI remains read-only and makes the no-crawler/no-auto-application boundary explicit.
8. No scheduled search, crawler or posting refresh mutation is introduced by this round.
9. Dependency audit, test suite, TypeScript and production build pass.

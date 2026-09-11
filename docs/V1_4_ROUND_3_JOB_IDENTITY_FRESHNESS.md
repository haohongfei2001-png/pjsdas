# PJSDAS v1.4 Round 3 — Job Identity & Freshness Layer

## Goal

Round 3 separates the identity and freshness of a public **job posting** from the user's durable **Opportunity** decision object.

A public recruitment page is not a stable Opportunity. The same role can appear through multiple URLs, tracking variants or mirrors; the same URL can be refreshed; an old posting can become stale; and a role can later be re-posted through a new source. PJSDAS must model those source facts without treating every URL as a new Opportunity or silently deleting source history.

## Product boundary

Round 3 adds a source-evidence layer inside discovery records rather than creating another user-facing workflow:

- `Opportunity` remains the user's formal job-search decision object.
- `Discovery Inbox` remains the pre-Opportunity decision buffer.
- `JobPostingEvidence` represents one source-specific public posting observation.
- posting evidence can retain older source versions when a candidate is rediscovered;
- source identity/freshness influences discovery deduplication but does not rewrite Decision Rules or formal Today priority.

No crawler, automatic refresh daemon or background mutation is introduced.

## Posting identity

Each new discovered candidate receives deterministic posting metadata:

- stable source-specific posting ID;
- normalized logical job identity;
- original source URL;
- canonical source URL;
- source host;
- source title;
- posting status: `open`, `closed`, or `unknown`;
- location / deadline / compensation evidence when known;
- `firstSeenAt`;
- `lastSeenAt`;
- `lastVerifiedAt`;
- a deterministic posting fingerprint;
- optional `supersededByPostingId`.

Canonical URL normalization removes URL fragments and common tracking parameters such as `utm_*`, `ref`, `source`, `fbclid` and `gclid`, while preserving non-tracking query parameters. Tracking variants of the same recruitment page therefore do not become separate source identities.

## Logical job identity

Logical matching remains conservative:

1. normalized company must match;
2. role-title similarity must meet the existing bounded similarity threshold;
3. if both sources state a location, incompatible locations do not count as the same logical posting.

If location is unknown on either side, Round 3 does not claim the postings are different merely because one source omitted the field.

This improves source-level deduplication while preserving the existing Opportunity application semantics for v1.4.

## Freshness

Posting freshness is deterministic and separate from posting status:

- `fresh` — verified within 7 days;
- `aging` — verified more than 7 but no more than 21 days ago;
- `stale` — verified more than 21 days ago;
- `closed` — source explicitly says closed or the known deadline has passed;
- `unknown` — verification timestamp cannot be evaluated.

A recently verified active Inbox source still suppresses repeated discovery. A stale active Inbox source no longer suppresses the role forever: a current search result may enter review as a source refresh. If the fresh result uses a different source URL, PJSDAS exposes that it may be a re-post or replacement source.

## Source history

When the same Inbox candidate is rediscovered:

- the same canonical source refreshes its existing posting record and preserves `firstSeenAt`;
- a new canonical source becomes the current source observation;
- previous source observations are retained in bounded `postingHistory` rather than silently overwritten;
- an older source that is stale/closed when a new open source becomes current can be marked as superseded.

The history is bounded to avoid unlimited workspace growth.

## Discovery Quality Gate changes

Round 3 distinguishes several cases that v1.3/v1.4 previously collapsed into one company/title duplicate:

- **formal Opportunity already exists** → duplicate, do not rediscover;
- **active Inbox + recent source evidence** → duplicate, do not reprocess;
- **recently dismissed Inbox** → keep the existing 120-day suppression;
- **active Inbox + stale source evidence** → allow a source refresh into review;
- **active Inbox + stale source + new URL** → allow review and flag possible re-post/replacement;
- **same canonical source with tracking-only URL differences** → same posting identity;
- **expired / explicitly closed candidate** → still hard rejected.

Facts that remain unknown continue to remain unknown.

## Backward compatibility

The snapshot schema version remains `1`.

`posting` and `postingHistory` are optional additions to existing Discovery Inbox and Opportunity discovery evidence. Older v1.0–v1.4 snapshots therefore remain readable. When older discovery data lacks posting metadata, PJSDAS deterministically derives a posting view from its existing source URL, title and discovery timestamp.

Snapshot validation now validates posting evidence whenever the new fields are present. Because the posting metadata lives inside the existing workspace objects, it automatically participates in Google Drive synchronization, backup/restore and workspace fingerprinting without adding another IndexedDB store.

## Decision Workspace visibility

Round 2 decision signals now also surface posting freshness:

- recently verified open source as a positive signal;
- unknown open status;
- aging source;
- stale source;
- closed source;
- superseded source;
- retained source-version count.

These are review signals only; they do not alter the formal PJSDAS priority engine.

## Non-goals

- No scheduled source polling.
- No crawler.
- No automatic status mutation when a public page disappears.
- No general multi-source JD merge engine.
- No change to the Opportunity scoring model.
- No change to application-group semantics.
- No automatic promotion or application submission.

## Acceptance criteria

1. Tracking variants of one source URL resolve to one canonical posting identity.
2. Posting evidence records first-seen, last-seen and last-verified timestamps plus explicit open/closed/unknown status.
3. Fresh and aging active Inbox sources continue suppressing redundant discovery.
4. Stale active Inbox sources can be refreshed through a new discovery proposal.
5. A new source for a stale logical role is surfaced as a possible re-post/replacement instead of silently discarded.
6. Rediscovery through a new source retains the previous source record in bounded history.
7. Explicitly closed or expired candidates remain hard rejected.
8. Existing snapshots without posting metadata remain valid and can derive a backward-compatible posting view.
9. Posting evidence inside Inbox/Opportunity data participates in the existing snapshot/fingerprint path.
10. No background write or direct AI mutation is introduced.

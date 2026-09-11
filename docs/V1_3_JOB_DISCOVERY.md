# PJSDAS v1.3 — AI Job Discovery

## Goal

v1.3 lets a user ask ChatGPT a simple request such as:

> 找一下现在适合我投递的岗位，加到 PJSDAS 里。

ChatGPT may use its normal web-search capability to discover public job postings. PJSDAS does **not** run its own crawler or pay for a separate LLM/API in v1.3. PJSDAS provides the user's explicit discovery preferences, current job-search state, deterministic validation/deduplication context, and the existing ChangeSet review boundary.

The product boundary is:

1. PJSDAS stores a user-visible **Discovery Profile**.
2. ChatGPT reads that profile plus current PJSDAS opportunities and Decision Rules.
3. ChatGPT searches public job postings using its own browsing/search capability.
4. ChatGPT submits structured, source-backed candidate postings to PJSDAS.
5. PJSDAS validates machine-checkable fields, rejects exact duplicates, and surfaces profile mismatches or unverifiable constraints as review warnings rather than pretending free text was deterministically proven.
6. Accepted candidates become a **pending ChangeSet**, never an immediate write.
7. The user reviews source links, role/company/location/deadline, rationale, warnings and initial scores.
8. Only explicit **Apply ChangeSet** adds the opportunities to PJSDAS.

This preserves the v1.2 principle: AI may propose; the user owns state changes.

## Why not build a crawler first

A crawler would add scraping maintenance, anti-bot failures, source-specific parsers, scheduling infrastructure and legal/terms-of-service variance before the core product loop is proven. ChatGPT already has a search/browsing layer. v1.3 should first prove the workflow:

**PJSDAS context → ChatGPT search → structured discovery candidates → PJSDAS review → Apply.**

A dedicated ingestion service can be considered later only if usage shows that search coverage, freshness or cost requires it.

## Phase A — Discovery Profile and read context

Add a user-controlled Discovery Profile stored inside the normal PJSDAS workspace and synchronized by the existing Google Drive snapshot.

Initial fields:

- `targetRoleQueries`: role families / search phrases the user wants to prioritize.
- `preferredLocations`: locations the user actively accepts.
- `locationNotes`: free-form exceptions or geographic rules.
- `minimumAnnualCompensationWan`: optional compensation floor.
- `mustHave`: explicit requirements the model should respect when searching and explain in review.
- `mustNotHave`: explicit exclusion rules the model should respect; obvious literal hits are surfaced as warnings.
- `strengths`: user-visible strengths ChatGPT may use when assessing fit.
- `notes`: additional discovery instructions.
- `updatedAt` and schema `version`.

The profile is deliberately explicit. PJSDAS must not silently infer durable preferences from chat history.

Expose a new MCP read tool:

`get_discovery_context`

It returns:

- Discovery Profile;
- active Decision Rules weights;
- existing active opportunity identities for deduplication;
- recently closed identities to reduce rediscovery;
- workspace metadata.

It does not search the web and does not mutate state.

## Phase B — Structured discovered-opportunity proposals

Extend `propose_changes` with a bounded `discoveredOpportunities` input. Discovery candidates must be reviewed in their own ChangeSet rather than mixed with unrelated rule/progress changes.

Each candidate contains:

- company;
- role;
- required public source URL;
- source title/provider;
- location if known;
- deadline if known;
- compensation text if known;
- short evidence-backed rationale;
- proposed PJSDAS `roleType`;
- proposed `opportunityValue` and `fitScore` with confidence;
- discovery timestamp.

The server deterministically validates structure, URL scheme, dates, score ranges and exact company+role duplicates. Free-form Discovery Profile statements cannot always be proven mechanically from a small structured payload, so the server does **not** claim semantic certainty: location/salary gaps and obvious exclusion-keyword hits remain visible warnings for user review. ChatGPT is instructed to apply the full explicit profile while searching and to keep unsupported fields unknown.

Candidates are normalized into `add_discovered_opportunity` ChangeSet operations and bound to the same signed workspace baseline used by v1.2. The MCP server still performs no direct Drive write.

## Phase C — Review and Apply

The ChangeSet review dialog renders discovery candidates as source-backed cards. For each candidate the user sees:

- company and role;
- role type;
- location;
- deadline;
- compensation evidence if present;
- source link and source title;
- rationale;
- proposed opportunity value / fit score and confidence;
- profile warnings when verification is incomplete or a visible mismatch exists.

Opening the signed review link is non-mutating. Apply performs an atomic IndexedDB batch for all discovery operations: each accepted candidate creates the local Opportunity, a normal Apply action and a Timeline record retaining the source URL. The existing baseline/fingerprint and Google Drive conflict protections still apply. Discard changes no job-search state.

The first alpha uses batch-level Apply/Discard. Per-candidate selection can be added later if real usage shows that batch review is too coarse.

## Safety and integrity rules

- No silent auto-application.
- No arbitrary JSON patch tool.
- Public source links are required for discovered jobs.
- ChatGPT must distinguish facts from estimates; missing salary/deadline/location remains unknown rather than fabricated.
- The user-controlled Discovery Profile is the durable preference source. Chat context may help in the current conversation but must not silently rewrite the profile.
- Discovery proposals are signed, expiring and workspace-baseline checked.
- Exact existing company+role duplicates are rejected before proposal; duplicates are checked again before Apply.
- Existing Google Drive conflict handling remains fail-closed.
- v1.3 does not claim that free-form preference matching is a deterministic theorem; uncertainty must remain visible.

## v1.3 alpha acceptance flow

1. User configures a Discovery Profile in PJSDAS.
2. In ChatGPT: `使用 PJSDAS，读取我的岗位发现偏好，然后搜索现在值得我投递的岗位。`
3. ChatGPT calls `get_discovery_context`, then searches current public job sources.
4. ChatGPT calls `propose_changes` with a small batch of structured `discoveredOpportunities` and their source URLs.
5. PJSDAS returns `applied: false` plus a signed review URL.
6. User opens the review URL and sees source-backed candidate cards and any warnings.
7. User applies the ChangeSet.
8. PJSDAS syncs to Google Drive.
9. ChatGPT re-reads the opportunity list and sees the newly accepted candidates.

## Non-goals for the first v1.3 alpha

- No autonomous scheduled crawler.
- No job-board-specific scraping adapters.
- No automatic application submission.
- No background application without user review.
- No hidden model-generated profile.
- No automatic semantic proof of arbitrary free-form profile constraints.
- No promise that a posting is still open unless the public source supports that at search time.

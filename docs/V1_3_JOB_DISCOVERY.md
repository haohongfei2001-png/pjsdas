# PJSDAS v1.3 — AI Job Discovery

## Goal

v1.3 lets a user ask ChatGPT a simple request such as:

> 找一下现在适合我投递的岗位，加到 PJSDAS 里。

ChatGPT may use its normal web-search capability to discover public job postings. PJSDAS does **not** run its own crawler or pay for a separate LLM/API in v1.3. PJSDAS provides the user's explicit discovery preferences, current job-search state, deterministic guardrails, deduplication context, and a ChangeSet proposal boundary.

The product boundary is:

1. PJSDAS stores a user-visible **Discovery Profile**.
2. ChatGPT reads that profile plus current PJSDAS opportunities/process state.
3. ChatGPT searches public job postings using its own browsing/search capability.
4. ChatGPT submits structured candidate postings to PJSDAS.
5. PJSDAS validates hard constraints and detects obvious duplicates.
6. Accepted candidates become a **pending ChangeSet**, never an immediate write.
7. The user reviews source links, role/company/location/deadline, rationale and initial scores.
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
- `preferredRoleTypes`: optional PJSDAS role types (`core`, `backup`, `reach`, `lottery`, `practice`).
- `mustHave`: explicit hard requirements.
- `mustNotHave`: explicit exclusion rules.
- `strengths`: user-visible strengths ChatGPT may use when assessing fit.
- `notes`: additional discovery instructions.
- `updatedAt` and schema `version`.

The profile is deliberately explicit. It must not silently infer durable preferences from chat history.

Expose a new MCP read tool:

`get_discovery_context`

It returns:

- Discovery Profile;
- active Decision Rules summary;
- existing opportunity identities for deduplication;
- recently closed/rejected identities when useful to avoid rediscovery;
- workspace version/fingerprint metadata.

It does not search the web and does not mutate state.

## Phase B — Structured discovered-opportunity proposals

Extend `propose_changes` with a bounded `discoveredOpportunities` input.

Each candidate should contain at minimum:

- company;
- role;
- source URL;
- source title/provider;
- location if known;
- deadline if known;
- compensation text if known;
- short evidence-backed rationale;
- proposed PJSDAS `roleType`;
- proposed `opportunityValue` and `fitScore` with confidence;
- discovery timestamp.

The server validates structure and applies hard Discovery Profile constraints. It must reject malformed source URLs, impossible scores, invalid dates and obvious duplicates. Ambiguous duplicates should be flagged for review rather than silently merged.

Candidates are normalized into ChangeSet operations. The MCP server still performs no direct Drive write.

## Phase C — Review experience

The v1.2 review dialog is extended for discovery proposals. For each candidate the user should see:

- company and role;
- location;
- deadline;
- compensation evidence if present;
- source link;
- why ChatGPT thinks it matches the explicit Discovery Profile;
- proposed opportunity value / fit score;
- duplicate warning if applicable.

The user may Apply or Discard the batch. Per-candidate selection can be added if batch review proves too coarse.

## Safety and integrity rules

- No silent auto-application.
- No arbitrary JSON patch tool.
- Public source links are required for discovered jobs.
- ChatGPT must distinguish facts from estimates; missing salary/deadline must remain unknown rather than fabricated.
- The user-controlled Discovery Profile is the durable preference source. Chat context may help in the current conversation but must not silently rewrite the profile.
- Discovery proposals are bound to the same signed, expiring, workspace-baseline-checked ChangeSet review flow introduced in v1.2.
- Existing Google Drive conflict handling remains fail-closed.

## v1.3 alpha acceptance flow

1. User configures a Discovery Profile in PJSDAS.
2. In ChatGPT: `使用 PJSDAS，读取我的岗位发现偏好，然后搜索现在值得我投递的岗位。`
3. ChatGPT calls `get_discovery_context`, searches the web, and gathers a small set of live postings.
4. ChatGPT calls `propose_changes` with structured `discoveredOpportunities`.
5. PJSDAS returns `applied: false` plus a signed review URL.
6. User opens the review URL and sees source-backed candidate cards.
7. User applies the ChangeSet.
8. PJSDAS syncs to Google Drive.
9. ChatGPT re-reads the opportunity list and sees the newly accepted candidates.

## Non-goals for the first v1.3 alpha

- No autonomous scheduled crawler.
- No job-board-specific scraping adapters.
- No automatic application submission.
- No background application without user review.
- No hidden model-generated profile.
- No promise that a posting is still open unless the cited source supports that at search time.

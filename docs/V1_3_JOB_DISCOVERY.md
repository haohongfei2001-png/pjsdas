# PJSDAS v1.3 — AI Job Discovery

## Goal

v1.3 lets a user ask ChatGPT a simple request such as:

> 找一下现在适合我投递的岗位，加到 PJSDAS 里。

ChatGPT may use its normal web-search capability to discover public job postings. PJSDAS does **not** run its own crawler or pay for a separate LLM/API in v1.3. PJSDAS provides the user's explicit discovery preferences, current job-search state, deterministic quality gates/deduplication context, and the existing ChangeSet review boundary.

The product boundary is:

1. PJSDAS stores a user-visible **Discovery Profile**.
2. ChatGPT reads that profile plus current PJSDAS opportunities and Decision Rules.
3. ChatGPT searches public job postings using its own browsing/search capability.
4. ChatGPT submits structured, source-backed candidate postings to PJSDAS.
5. PJSDAS rejects machine-checkable bad candidates, detects exact or highly similar duplicates, ranks the remaining candidates, and keeps unverifiable facts visible as review warnings.
6. Only a small bounded set of the strongest candidates becomes a **pending ChangeSet**, never an immediate write.
7. The user reviews source links, role/company/location/deadline, rationale, warnings and initial scores.
8. Only explicit **Apply ChangeSet** adds the opportunities to PJSDAS.

This preserves the v1.2 principle: AI may propose; the user owns state changes.

## Why not build a crawler first

A crawler would add scraping maintenance, anti-bot failures, source-specific parsers, scheduling infrastructure and legal/terms-of-service variance before the core product loop is proven. ChatGPT already has a search/browsing layer. v1.3 should first prove the workflow:

**PJSDAS context → ChatGPT search → structured discovery candidates → quality gate → PJSDAS review → Apply.**

A dedicated ingestion service can be considered later only if usage shows that search coverage, freshness or cost requires it.

## Phase A — Discovery Profile and read context

The user-controlled Discovery Profile is stored inside the normal PJSDAS workspace and synchronized by the existing Google Drive snapshot.

Fields:

- `targetRoleQueries`: role families / search phrases the user wants to prioritize.
- `preferredLocations`: locations the user actively accepts.
- `locationPolicy`: `prefer` keeps location mismatches as warnings; `strict` rejects mismatches or unknown locations.
- `locationNotes`: free-form exceptions or geographic rules for ChatGPT and human review.
- `minimumAnnualCompensationWan`: optional compensation floor; it is enforced only when the public source provides a structureable lower-bound salary.
- `preferredRoleTypes`: optional allowed PJSDAS role types (`core`, `backup`, `reach`, `lottery`, `practice`).
- `minimumFitScore`: optional hard floor for the proposed fit score.
- `minimumOpportunityValue`: optional hard floor for the proposed opportunity-value score.
- `maxReviewCandidates`: maximum candidates allowed into one discovery ChangeSet; default is 6 and the allowed range is 1–12.
- `mustHave`: explicit requirements ChatGPT should search for; if submitted source evidence does not verify one, PJSDAS keeps an explicit warning rather than fabricating certainty.
- `mustNotHave`: explicit exclusions; an obvious literal match in submitted source evidence is rejected before ChangeSet creation.
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

`propose_changes` accepts a bounded `discoveredOpportunities` input. Discovery candidates must be reviewed in their own ChangeSet rather than mixed with unrelated rule/progress changes. ChatGPT may submit up to 20 search hits to the quality gate; the gate then limits the actual review batch using `maxReviewCandidates`.

Each candidate contains:

- company;
- role;
- required public source URL;
- source title/provider;
- optional source-evidence text used only for deterministic checks;
- posting status (`open`, `closed`, or `unknown`) if verified;
- location if known;
- deadline if known;
- compensation text if known;
- optional source-backed annual compensation lower bound in ten-thousand CNY;
- short evidence-backed rationale;
- proposed PJSDAS `roleType`;
- proposed `opportunityValue` and `fitScore` with confidence;
- discovery timestamp.

The server validates structure, URL scheme, dates and score ranges before creating a proposal. It then runs the Round 1 quality gate below. Candidates that survive are normalized into `add_discovered_opportunity` ChangeSet operations and bound to the same signed workspace baseline used by v1.2. The MCP server still performs no direct Drive write.

## Round 1 — Discovery Quality Gate

The first quality pass is deterministic and intentionally conservative. It separates **hard rejection** from **unknown / needs-review** instead of pretending every natural-language preference can be proven mechanically.

Hard rejection currently covers:

- public source explicitly reports the posting as closed;
- a known deadline has already passed;
- the proposed role type is outside an explicit `preferredRoleTypes` allow-list;
- `fitScore` is below an explicit `minimumFitScore`;
- `opportunityValue` is below an explicit `minimumOpportunityValue`;
- submitted source evidence literally matches an explicit `mustNotHave` rule;
- strict location mode is enabled and location is missing or outside the explicit accepted-location list;
- a source-backed numeric compensation lower bound is below `minimumAnnualCompensationWan`;
- the same company already has an exact or highly similar role in PJSDAS.

Unknown or soft cases remain visible as warnings:

- the public source does not explicitly verify that the posting is still open;
- a `mustHave` item cannot be verified from the submitted evidence;
- location is missing or outside the preferred list while location mode is `prefer`;
- a compensation floor exists but the source does not provide a reliable structureable lower bound.

For deduplication, the gate normalizes company names and compares same-company role titles with a bounded title-similarity heuristic. This catches variants such as `产品经理（AI方向）` versus `AI 产品经理` without treating every product-related role as identical.

Eligible candidates are ranked by a discovery quality score derived from PJSDAS's active `fit` and `opportunity` Decision Rules weights, with a penalty for low-confidence estimates. Only the highest-ranked `maxReviewCandidates` enter the ChangeSet. Remaining eligible hits are returned as deferred rather than silently lost.

The `propose_changes` result reports screening counts plus duplicate, rejected and deferred candidates so ChatGPT can explain why a broad search produced a smaller review batch.

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
- Same-company exact/highly-similar roles are rejected before proposal and duplicates are checked again before Apply.
- Existing Google Drive conflict handling remains fail-closed.
- v1.3 does not claim that free-form preference matching is a deterministic theorem; uncertainty must remain visible.

## v1.3 alpha acceptance flow

1. User configures a Discovery Profile in PJSDAS.
2. In ChatGPT: `使用 PJSDAS，读取我的岗位发现偏好，然后搜索现在值得我投递的岗位。`
3. ChatGPT calls `get_discovery_context`, then searches current public job sources.
4. ChatGPT calls `propose_changes` with structured `discoveredOpportunities` and their source evidence.
5. PJSDAS removes expired/closed/excluded/duplicate/below-threshold hits, ranks eligible results and bounds the review batch.
6. PJSDAS returns `applied: false`, screening diagnostics and a signed review URL.
7. User opens the review URL and sees source-backed candidate cards and any warnings.
8. User applies the ChangeSet.
9. PJSDAS syncs to Google Drive.
10. ChatGPT re-reads the opportunity list and sees the newly accepted candidates.

## Round 1 automated acceptance cases

The test suite covers:

- exact and same-company similar-role deduplication;
- expired and explicitly closed postings;
- explicit exclusion hits;
- explicit fit/opportunity score floors;
- source-backed compensation below the user's floor;
- unknown compensation / posting status / must-have evidence remaining as warnings;
- strict versus preferred location semantics;
- quality ranking and bounded review batches;
- source-backed discovery ChangeSet signing and non-mutating proposal behavior.

## Non-goals for the first v1.3 alpha

- No autonomous scheduled crawler.
- No job-board-specific scraping adapters.
- No automatic application submission.
- No background application without user review.
- No hidden model-generated profile.
- No automatic semantic proof of arbitrary free-form profile constraints.
- No per-candidate Apply/Discard in Round 1.
- No promise that a posting is still open unless the public source supports that at search time.

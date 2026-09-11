# PJSDAS v1.3 Round 3 — Discovery Review & Feedback Loop

Round 3 turns job discovery from a batch-only import into a user-controlled feedback loop.

## Product boundary

- Opening a signed ChatGPT review link is still non-mutating.
- Each discovered job is selected individually in the review page.
- Only selected jobs enter Opportunities when the user explicitly applies the ChangeSet.
- Unselected jobs are not silently forgotten: after explicit Apply or Discard, PJSDAS records a compact Timeline-backed discovery decision.
- Rejection reasons are explicit user choices, never inferred from chat history.
- Quality-gate diagnostics (duplicate / filtered / deferred) are signed inside the proposal envelope and shown in the review UI.

## Durable feedback

Round 3 stores discovery feedback as Timeline records rather than introducing another database store. This means the feedback automatically participates in the existing local backup, Google Drive snapshot, conflict detection and workspace fingerprint model.

User decisions:

- `discovery_accepted`
- `discovery_rejected`

Quality-gate outcomes:

- `discovery_filtered`
- `discovery_duplicate`
- `discovery_deferred`

A rejection can carry one explicit reason code: location, compensation, role direction, company/opportunity value, requirements mismatch, a better similar role already exists, not interested, or other.

## Rediscovery suppression

`get_discovery_context` now returns a discovery-history summary plus recently rejected identities. The deterministic quality gate also rejects highly similar same-company roles when the latest explicit user decision for that identity is a rejection within the previous 120 days. A later explicit acceptance supersedes an older rejection.

## Partial Apply

The signed proposal still contains the complete accepted review batch. The browser may derive only a strict subset of those already-signed discovery operations after the user checks/unchecks cards. It cannot add arbitrary operations. The derived subset keeps the original workspace baseline and is validated before Apply.

## Screening visibility

The signed proposal carries bounded screening diagnostics:

- number received from ChatGPT search;
- number admitted to review;
- duplicate count and reasons;
- hard-filter count and reasons;
- deferred count, quality scores and reasons.

This allows the review page to explain why a broad web search produced a smaller review set without trusting unsigned browser state.

## Acceptance criteria

1. A two-job discovery ChangeSet can apply only one selected job.
2. The unselected job remains out of Opportunities and records the explicit rejection reason.
3. Discarding an entire discovery batch adds no Opportunities but records explicit rejection feedback.
4. Duplicate / filtered / deferred diagnostics are visible in the review page and persisted after explicit review action.
5. A recently rejected highly similar role is blocked by the quality gate for 120 days unless a later explicit acceptance supersedes it.
6. Existing v1.2 and v1.3 safety properties remain: signed link, 24-hour expiry, exact workspace baseline, no server-side direct Drive write, and no mutation on link open.

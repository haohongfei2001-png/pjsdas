# PJSDAS v1.5 Round 1 — Rich Opportunity

## Goal

v1.4 made job discovery safe, durable, reviewable, and freshness-aware. v1.5 Round 1 upgrades the object that eventually enters the real Opportunities pool.

An Opportunity should no longer mean only:

> company + role + fitScore + opportunityValue + a few source fields

For web-discovered jobs, PJSDAS can now retain a bounded set of **source-backed job facts** that are useful for later comparison, scoring, preparation, and application decisions.

The central boundary is:

> **Recruiting facts come from public source evidence. Fit, opportunity value, confidence, and rationale remain assessments. Unknown facts remain explicitly unknown.**

Round 1 does not redesign Fit / Opportunity Value. That is intentionally deferred to v1.5 Round 2.

---

## Rich Opportunity fact model

`Opportunity.detail.facts` contains a versioned `OpportunityFacts` object.

### Identity facts

- department;
- business unit;
- locations;
- recruitment batch.

### Role facts

- responsibilities;
- requirements;
- education requirement;
- major requirements;
- experience requirement;
- skills;
- language requirements.

### Application facts

- application URL;
- application method;
- deadline;
- recruitment batch.

### Compensation facts

- source text;
- source-backed annual lower bound when available;
- source-backed annual upper bound when available;
- compensation basis / explanation.

### Evidence

- public source URL;
- source title;
- verification time;
- optional bounded evidence summary.

PJSDAS does **not** retain an unlimited raw JD page merely to support this model.

---

## Explicit unknowns

The facts object carries `unknownFields` rather than treating every missing property as semantically equivalent.

Current tracked fact groups include:

- department;
- business unit;
- locations;
- recruitment batch;
- responsibilities;
- requirements;
- education;
- majors;
- experience;
- skills;
- languages;
- application method;
- deadline;
- compensation.

This allows PJSDAS to distinguish:

> “the source did not establish this fact”

from a future explicit value such as:

> “no experience required.”

Unknown fields are generated deterministically from the stored facts and are validated for consistency during ChangeSet / Inbox / snapshot validation.

---

## Discovery proposal contract

`propose_changes(discoveredOpportunities)` now accepts an optional bounded `facts` object for each source-backed candidate.

ChatGPT should submit a fact only when the public source actually supports it. It must not convert its own fit analysis, career judgment, or assumptions into a recruiting fact.

Examples:

- a source says “硕士及以上” → may populate `educationRequirement`;
- a source lists SQL and Python → may populate `skills`;
- a source does not mention major restrictions → `majorRequirements` stays unknown;
- ChatGPT thinks a physics master is a strong analytical fit → this belongs in fit/rationale, **not** in source facts.

Arrays and text fields have bounded sizes. Public application URLs are validated. Contradictory compensation bounds fail closed before a signed ChangeSet is created.

---

## Persistence path

Rich facts survive the complete existing safety path:

```text
ChatGPT public search
  -> propose_changes
  -> deterministic validation
  -> signed review-only ChangeSet
  -> review page
     -> Apply directly
     OR Save to Discovery Inbox
  -> Inbox rediscovery / enrichment
  -> Promote
  -> Opportunity.detail.facts
  -> IndexedDB snapshot
  -> Google Drive appDataFolder sync / backup / fingerprint
```

Saving to Discovery Inbox does not flatten or discard facts.

If the same Inbox role is found again with additional verified source facts, PJSDAS merges the new facts without erasing previously known ones. Bounded list fields are deduplicated.

---

## Review UX

The signed ChatGPT review and Discovery Inbox use the same Rich Opportunity fact summary.

The UI shows:

- fact completeness;
- explicit unknowns as “source not stated” rather than fabricated values;
- department / business unit / locations / recruitment batch;
- education / majors / experience / skills / languages;
- application method;
- compensation;
- responsibilities and requirements when known;
- source-evidence summary and verification time.

The fact panel explicitly states that Fit, Opportunity Value, and rationale are a separate assessment layer.

Promotion preview shows the Rich facts again before the candidate becomes a normal Opportunity.

---

## AI read boundary

The existing `list_opportunities` tool is extended rather than adding another MCP tool.

Every returned opportunity now receives bounded fact metadata:

- `factsAvailable`;
- `factCompleteness`.

When ChatGPT explicitly sets `includeFacts: true`, the response also includes the structured fact object. Rich-fact reads are capped at 20 opportunities per call to avoid turning ordinary opportunity queries into large workspace dumps.

This keeps the original AI Bridge rule intact: semantic bounded views, not raw database access.

---

## Validation and compatibility

- Existing snapshot schema remains version 1.
- Old Opportunities without `detail.facts` remain valid.
- Old Discovery Inbox items remain valid.
- Rich facts are validated inside Inbox items, Opportunities, and discovery ChangeSets.
- Source URL / verification time / list bounds / salary ranges / explicit unknown bookkeeping fail closed when invalid.
- Workspace fingerprinting already covers nested snapshot data, so Rich facts automatically participate in Google Drive conflict detection.

No new IndexedDB store is introduced in Round 1.

---

## Non-goals

- No Fit component redesign.
- No Opportunity Value component redesign.
- No model-generated “facts” without source support.
- No unlimited raw JD persistence.
- No automatic requirement inference.
- No CV / resume tailoring engine.
- No capability-gap graph yet.
- No automatic application.
- No crawler or background source refresh.

Those are separate product decisions rather than incidental extensions of the data model.

---

## Acceptance criteria

1. A discovery candidate with source-backed structured facts creates a valid signed review-only ChangeSet.
2. Missing requirements / education / experience / skills remain explicitly unknown instead of being synthesized.
3. Contradictory fact structures such as annual salary minimum above maximum fail closed.
4. The signed review page visibly separates recruiting facts from fit/opportunity assessment.
5. Saving to Discovery Inbox retains Rich facts.
6. Rediscovering the same Inbox role can add verified facts without erasing existing known facts.
7. Promotion into Opportunities retains Rich facts and source evidence.
8. Rich facts are validated by the normal snapshot and ChangeSet safety boundaries.
9. `list_opportunities` exposes fact completeness and can return structured facts only when explicitly requested, with a 20-opportunity bound.
10. Existing workspaces without Rich facts remain valid and usable.
11. Existing v1.4 source identity/freshness, Inbox feedback, signed review, Drive conflict, and no-direct-AI-write guarantees remain intact.

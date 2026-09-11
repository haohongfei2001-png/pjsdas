# PJSDAS v1.5 Round 2 — Fit / Opportunity Value Component Model

## Goal

v1.5 Round 1 separated public recruiting facts from AI assessment. Round 2 removes the next major black box: a newly discovered job should no longer enter PJSDAS with an opaque model-owned `fitScore = 86` or `opportunityValue = 89` as the primary assessment primitive.

The new boundary is:

> **AI interprets evidence into bounded assessment components. PJSDAS owns component definitions, weights, aggregate-score derivation, validation, review, and persistence.**

The existing `Opportunity.fitScore` and `Opportunity.opportunityValue` fields remain as compatibility aggregates because Today ranking and other downstream systems already consume them. In component mode, however, those totals are derived by PJSDAS rather than trusted from the client.

---

## Assessment model

`Opportunity.detail.assessment` and `DiscoveryInboxItem.assessment` may contain a versioned `OpportunityAssessment`:

```text
OpportunityAssessment
  version = 1
  mode = component
  fit
    roleDirection
    skills
    education
    experience
    industry
    language
    location
  opportunityValue
    companyQuality
    roleGrowth
    compensation
    careerOptionality
    brandValue
    industryGrowth
    locationValue
  assessedAt
```

Every supplied component is:

```text
score: 0..100
confidence: high | medium | low
rationale: bounded explanatory text
```

A component is an assessment judgment, not a recruiting fact. Rich Opportunity facts remain in `Opportunity.detail.facts` and retain their independent source-evidence semantics.

---

## Aggregation semantics

Component weights live in persisted **Decision Rules**, not inside individual Opportunities.

### Fit default weights

- role direction: 24
- skills: 18
- education: 10
- experience: 14
- industry: 8
- language: 8
- location: 18

### Opportunity Value default weights

- company quality: 18
- role growth: 18
- compensation: 14
- career optionality: 16
- brand value: 10
- industry growth: 12
- location value: 12

Weights are normalized automatically and do not need to sum to 100.

For an assessment axis, the aggregate score is the weighted average of **known supplied components only**.

PJSDAS deliberately does not insert a hidden neutral score for missing components. A missing component therefore does not silently mean “50/100” and does not directly lower the merit estimate.

Instead, missing evidence is represented through:

- component coverage;
- component confidence;
- an aggregate confidence classification;
- review warnings when coverage is sparse.

This separates two questions that were previously conflated:

1. **How good does the known evidence make this role look?**
2. **How certain are we that this aggregate represents the whole role?**

---

## Confidence semantics

Component confidence is mapped internally for uncertainty aggregation:

- high = 1.0
- medium = 0.7
- low = 0.4

Coverage is the configured component weight represented by supplied components divided by total configured weight.

Aggregate certainty is:

```text
coverage × weighted mean component confidence
```

The aggregate confidence label is:

- high: certainty >= 0.72
- medium: certainty >= 0.40
- low: certainty < 0.40

Confidence does **not** directly subtract points from the merit score. It is a separate uncertainty signal.

---

## Discovery proposal contract

`propose_changes(discoveredOpportunities)` now accepts a bounded `assessment` object.

When `assessment` is supplied:

1. PJSDAS validates component names, score ranges, confidence and rationale bounds.
2. PJSDAS reads the active Decision Rules component weights.
3. PJSDAS derives aggregate Fit and Opportunity Value.
4. The existing Discovery Profile thresholds and discovery quality gate operate on those PJSDAS-derived totals.
5. Derived aggregate confidence and sparse-coverage warnings are attached to review evidence.
6. The signed ChangeSet stores both the component assessment and derived compatibility totals.

Client-supplied aggregate score fields cannot override component-derived totals.

### Legacy compatibility

For existing ChatGPT connector schemas and older clients, PJSDAS still accepts the old complete set:

- `fitScore`
- `opportunityValue`
- `fitConfidence`
- `opportunityValueConfidence`

This is a compatibility path, not the preferred v1.5 Round 2 representation.

A discovery candidate must provide either:

- a valid component assessment; or
- the complete legacy aggregate score/confidence set.

---

## Persistence and lifecycle

Component assessments survive the existing governed lifecycle:

```text
public search
  → propose_changes
  → signed ChangeSet review
  → Apply directly
or
  → Save to Discovery Inbox
  → rediscovery / fact enrichment
  → Promote
  → Opportunity
  → snapshot / backup / Google Drive
```

If a later discovery result supplies a new component assessment, that newer assessment replaces the previous assessment for the Inbox candidate.

If a stale/legacy client refreshes public-source facts without a component assessment, PJSDAS preserves an existing component assessment instead of silently downgrading it to opaque legacy scores.

Old snapshots and old Opportunities without `assessment` remain valid.

---

## Historical score audit semantics

Changing component weights does **not** silently bulk-rewrite historical Opportunities.

The persisted top-level aggregate scores remain the totals that were accepted with that assessment at review time.

PJSDAS exposes a bounded read-only `get_opportunity_assessment` tool that returns:

- stored aggregate Fit / Opportunity Value;
- the saved component assessment;
- current component weights;
- a current-rules projection of the same saved components;
- component coverage and aggregate confidence;
- whether current projection differs from stored history.

This allows a user to ask:

> “Why was this job scored this way?”

or:

> “Under my current rules, how would this old assessment score now?”

without silently changing state.

---

## Decision Rules

Decision Rules now contain two additional explicit weight maps:

- `fitComponentWeights`
- `opportunityValueComponentWeights`

Old rule snapshots that do not contain these fields normalize to the recommended defaults and do not create a phantom rule change.

The Rules UI exposes these maps as advanced assessment policy. ChatGPT may also propose explicit component-weight changes through the existing review-only `decisionRulesPatch` path.

---

## MCP read surface

Round 2 adds one intentionally narrow read tool:

`get_opportunity_assessment({ opportunityId })`

The new tool is preferred over bloating `list_opportunities` with every component rationale.

It is read-only and bounded to one Opportunity.

`get_decision_rules` also exposes both component-weight maps.

This is the only new MCP read surface in the round.

---

## Safety boundaries

Round 2 does not change the core PJSDAS governance model:

- no direct AI mutation;
- no automatic Apply;
- no automatic application submission;
- no hidden learned component weights;
- no inference of durable user preferences from chat history;
- no component score fabrication by PJSDAS;
- no silent historical re-scoring;
- no crawler or background agent introduced by this round.

---

## Non-goals

Round 2 intentionally does not implement:

- application success-probability modelling;
- portfolio / company-quota optimisation;
- automatic re-assessment of every historical Opportunity;
- learned user-specific weights;
- capability-gap / Prep graph;
- resume tailoring;
- application automation;
- a new crawler.

Those belong to later product layers.

---

## Acceptance criteria

1. New discovery candidates can submit bounded Fit and Opportunity Value components with score, confidence and rationale.
2. In component mode, PJSDAS derives aggregate totals and ignores conflicting client aggregate values.
3. Missing components are not imputed and are reflected through coverage/confidence instead.
4. Discovery Profile thresholds and quality ranking use PJSDAS-derived totals.
5. Component assessments survive ChangeSet, Inbox, Promote, snapshot, Drive and backup paths.
6. Old aggregate-only candidates and old snapshots remain valid.
7. Component weights are explicit Decision Rules, visible in Rules UI and readable through MCP.
8. Weight changes do not silently rewrite stored historical Opportunity scores.
9. `get_opportunity_assessment` exposes stored totals, component evidence and explicit current-rules projection.
10. Component assessment remains separate from source-backed Rich Opportunity facts.
11. CI, dependency audit, TypeScript build and production build pass before integration.

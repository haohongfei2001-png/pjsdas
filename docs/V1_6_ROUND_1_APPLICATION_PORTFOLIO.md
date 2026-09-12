# PJSDAS v1.6 Round 1 — Application Portfolio Decision

## Goal

v1.5 made a single Opportunity richer and more explainable. v1.6 Round 1 answers a different question:

> When several roles compete for the same application quota, which subset is worth using the limited slots on?

This is a portfolio problem, not an independent ranking problem.

The central product rule is:

> **Application capacity is a ceiling, not a target. PJSDAS must never recommend a weak role merely to fill an available slot.**

The second safety rule is:

> **PJSDAS only performs portfolio optimization inside an explicit `ApplicationGroup`. It never infers shared quota merely because several roles belong to the same company.**

Round 1 is read-only decision support. It does not rewrite preferences, reserve quota, submit applications, or automatically mark opportunities as applied.

---

## Existing Application Group remains the constraint entity

The workbook/local model already contains:

- `applicationGroupId` on Opportunity;
- `ApplicationGroup.total`;
- `ApplicationGroup.used`;
- `ApplicationGroup.remaining`;
- free-text quota rule;
- recorded current order / preference;
- lock state.

Round 1 does not introduce a parallel quota model.

Remaining capacity is resolved in this order:

1. explicit `remaining`;
2. otherwise `total - used` when both are known;
3. otherwise unknown.

If remaining capacity is unknown, PJSDAS returns ranking-only output with status `needs_rule_confirmation`. It does not guess a number from free text.

If `total - used` conflicts with explicit `remaining`, the decision emits a warning and uses explicit `remaining` as the operational value.

If the group is locked, no replacement portfolio is proposed.

---

## Candidate eligibility

Only Opportunities explicitly bound to the Application Group are considered.

A role can enter the recommendation set only when:

- `processStage === not_applied`;
- current stage is `待投`;
- known deadline has not passed;
- its deterministic base utility meets `portfolioMinimumCandidateScore`.

Already-submitted/in-process roles stay visible in explanation but cannot re-enter the recommendation set.

Expired roles stay visible as excluded evidence.

---

## Candidate base utility

Round 1 uses explicit Decision Rules:

- Opportunity Value;
- Fit;
- role priority;
- deadline pressure;
- application efficiency;
- evidence confidence.

Default weights:

| Dimension | Weight |
| --- | ---: |
| Opportunity Value | 28 |
| Fit | 28 |
| Role priority | 14 |
| Deadline pressure | 8 |
| Application efficiency | 10 |
| Evidence confidence | 12 |

Default minimum candidate utility: `62 / 100`.

The weights are normalized over **known** dimensions only. Unknown application cost, deadline, or evidence confidence is omitted from the denominator rather than assigned a fabricated neutral score.

### Opportunity Value / Fit

If the Opportunity has v1.5 component assessment, the portfolio engine uses the explicit **current-rules projection** of that saved assessment. This is a read-only projection and does not rewrite historical stored aggregates.

Legacy opportunities without component assessment use their stored aggregate values.

### Role priority

The deterministic mapping is:

- core: 100;
- reach: 90;
- backup: 72;
- lottery: 56;
- practice: 38.

This is only one weighted input. Role type does not override Fit or Opportunity Value.

### Deadline pressure

Known future deadlines receive a bounded urgency score. Missing deadlines are omitted rather than treated as safe or urgent.

### Application efficiency

Known `prepEstimateMinutes` is converted to a bounded efficiency score. Lower application/preparation cost increases efficiency. Missing cost is omitted.

### Evidence confidence

When component assessment or discovery confidence is available, PJSDAS converts the existing high/medium/low confidence semantics into a bounded confidence input. No confidence is invented for old imported Opportunities that lack assessment evidence.

---

## Portfolio objective

Candidates below the minimum utility never enter the optimization set.

For each candidate above the threshold, marginal standalone utility is:

`baseScore - minimumCandidateScore`

PJSDAS enumerates non-empty subsets up to the known capacity (bounded to six recommended slots and the top twelve optimizable candidates).

The objective is:

`sum(candidate marginal utility) - pairwise overlap penalties`

The best positive-net combination is selected.

This makes quota a maximum automatically:

- adding a useful distinct candidate increases objective;
- adding a weak candidate contributes no positive utility because it is filtered by the minimum;
- adding a highly redundant candidate can reduce objective through overlap penalty;
- therefore a 3-slot group may validly recommend only 1 or 2 roles.

---

## Overlap penalty

Role-title similarity uses PJSDAS's existing deterministic job-role similarity function.

Similarity below `0.55` receives no penalty.

Above that threshold the penalty rises continuously, reaching the configured `overlapPenalty` at similarity 1.0.

Default maximum pairwise overlap penalty: `18` points of portfolio objective.

Overlap is a combination effect, not a mutation of either Opportunity's Fit or Opportunity Value.

---

## Output states

- `ready`: a recommendation exists;
- `needs_rule_confirmation`: quota cannot be determined safely;
- `capacity_exhausted`: no remaining slots;
- `locked`: Application Group is locked;
- `no_candidates`: no Opportunities are explicitly bound to the group;
- `no_recommendation`: there is capacity, but no subset adds enough net portfolio value.

Every excluded candidate carries a disposition such as:

- below minimum;
- overlap;
- capacity;
- expired;
- not pending;
- insufficient marginal portfolio value.

---

## User interface

Round 1 adds a read-only Application Portfolio dock.

It shows:

- group/quota status;
- recorded quota rule and historical preference text;
- recommended subset;
- per-role base utility and component inputs;
- excluded roles and explicit reasons;
- quota/freshness warnings.

The dock has no Apply button. Recalculation is safe and read-only.

---

## MCP read contract

New bounded read-only tool:

`get_application_portfolio`

Optional filters:

- `groupId`;
- `company`;
- `limit` (1–20).

It returns deterministic decisions plus the active portfolio policy.

The AI client should use this tool when the user asks questions such as:

- which three roles should I choose at this company?;
- is the third slot worth using?;
- why was role B excluded?;
- what changed after I changed portfolio weights?;

The tool never mutates the workspace.

---

## Backward compatibility

Snapshot schema remains v1.

Older Decision Rules without portfolio fields normalize to recommended defaults.

No ApplicationGroup or Opportunity migration is required.

Existing Today `group_decision` Actions continue to work. Round 1 adds a richer deterministic explanation layer without changing historical Action semantics.

---

## Non-goals

Round 1 deliberately does **not** add:

- automatic application submission;
- automatic reservation/consumption of application quota;
- implicit same-company grouping;
- learned hidden portfolio weights;
- portfolio decisions across unrelated companies;
- resume tailoring;
- application-form automation;
- automatic mutation of `currentOrder`;
- silent rewriting of historical Fit / Opportunity Value.

---

## Acceptance criteria

1. A 3-slot group can recommend fewer than 3 roles.
2. Weak candidates below the explicit minimum are never selected just to fill slots.
3. Highly redundant roles can be excluded because of negative marginal portfolio value.
4. Unknown quota produces `needs_rule_confirmation`, not a guessed portfolio.
5. Locked and exhausted groups produce no replacement recommendations.
6. Already-submitted and expired roles do not enter the selected subset.
7. Portfolio rules are explicit, persisted, validated, and backward-compatible.
8. Local UI exposes the decision and reasons without mutation controls.
9. MCP can read the same deterministic decision through a bounded tool.
10. Snapshot/Drive semantics remain unchanged because no new persistent store is introduced.
11. No application is submitted automatically.

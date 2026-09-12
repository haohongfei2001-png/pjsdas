# PJSDAS v1.6 Round 2 — Prep Graph

## Goal

v1.6 Round 1 answers a portfolio question:

> Given limited application capacity, which opportunities are worth using the slots on?

Round 2 answers the next operational question:

> Given limited preparation time, which Prep work improves the most important active opportunities right now?

The objective is not to create a generic knowledge graph. It is to make the existing `Prep` layer useful to the Today decision engine while preserving PJSDAS's audit and mutation boundaries.

The core chain becomes:

> source-backed opportunity requirements / explicit gaps / active process stage → deterministic Prep links → reusable preparation leverage → Today runtime projection

---

## Product boundary

Prep Graph is **not** an autonomous task generator.

It may:

- read existing `Prep` records;
- read active Opportunities and effective recruiting-process state;
- derive explicit or deterministic exact links;
- calculate reusable coverage, urgency and leverage;
- highlight active gaps/process needs without Prep coverage;
- suggest that a `等待触发` Prep item should be reviewed for activation;
- raise the runtime leverage/urgency of an **existing** Prep Action.

It may not:

- create a Prep record silently;
- create or activate an Action silently;
- rewrite historical Action leverage/delayCost values;
- infer fuzzy semantic edges from model intuition;
- claim that a requirement is a user capability gap without evidence;
- mutate Opportunities or application state.

---

## Requirement versus gap

A critical semantic distinction:

### Requirement

A source-backed job requirement such as `SQL`, `Python`, or an English-language requirement means only:

> the role requires this capability.

It does **not** mean the user lacks that capability.

Requirements may create a reusable Prep coverage edge when the Prep title/output explicitly matches the requirement, but they do not increase `matchedNeedCount` by themselves.

### Gap

A capability becomes an active gap only when PJSDAS has explicit evidence such as:

- a low Fit component assessment for skills/language/experience/industry;
- an explicit legacy `Opportunity.detail.gap` field.

Gap severity is bounded and explainable from the source assessment.

### Process-prep need

Assessment, written-test and interview stages create a temporary preparation need. These are not capability deficits; they are execution needs caused by the recruiting process.

---

## Link sources

Prep Graph links are version-1 runtime projections. No new persistent graph store is introduced.

Allowed link sources:

1. `explicit_trigger`
   - `Prep.triggeredBy` exactly references an Opportunity ID, Application Group ID, unique role name, or company+role identity.
   - high confidence.

2. `process_pack`
   - `ProcessRecord.prepPack` explicitly matches the Prep title.
   - high confidence.

3. `structured_requirement`
   - Prep title/minimum output/trigger rule exactly matches a bounded Rich Opportunity skill/language requirement.
   - medium confidence.

4. `structured_gap`
   - exact match against a gap supported by component assessment.
   - high confidence.

5. `legacy_gap`
   - exact match against an explicit legacy `Opportunity.detail.gap` value.
   - high confidence.

6. `process_stage`
   - exact bounded match against interview/written-test/assessment preparation keywords.
   - high confidence.

The graph deliberately does not use embeddings, LLM similarity, or generic fuzzy role-name matching in Round 2.

Generic terms such as `产品`, `分析`, `准备`, `岗位`, and `能力` cannot create an edge by themselves.

---

## Active opportunity scope

Only active preparation-relevant stages participate:

- `not_applied`
- `screening`
- `assessment`
- `written_test`
- `interview`

Closed, offer, and waiting-release opportunities do not inflate Prep leverage.

---

## Prep leverage

Each Prep node exposes four bounded structural signals:

- `coverageScore` — how many active Opportunities are deterministically linked;
- `valueScore` — top linked Opportunity Value signal;
- `urgencyScore` — nearest deadline/effective process timing plus process stage urgency;
- `needScore` — severity of matched active gap/process-prep needs.

Round 2 uses a fixed structural projection:

- coverage: 35%
- linked opportunity value: 30%
- urgency: 20%
- matched need severity: 15%

Medium-confidence-only requirement links receive a small confidence discount.

This raw Prep leverage formula is not a replacement for Decision Rules. The influence of leverage on Today remains governed by the existing `DecisionRules.weights.leverage` factor.

---

## Today projection

Stored Action records remain unchanged.

At runtime, `rankActions` constructs a limited graph from the existing Prep Action title and current structured Opportunity facts. If a deterministic match exists:

- `leverage = max(stored leverage, graph leverage)`;
- `delayCost = max(stored delayCost, graph-derived urgency/need cost)`;
- a missing soft Prep due time may project to the nearest linked opportunity/process date;
- reasons show factual graph coverage such as `覆盖3岗 · 2个需求`.

If no deterministic link exists, Today says only `准备任务`.

It no longer claims every Prep Action is `可复用于多个岗位`.

The richer full graph (including `Prep.triggeredBy` and `Process.prepPack`) is available in the Prep Graph workspace and MCP read tool. Today intentionally uses only information already present in Action + Opportunity runtime inputs, so no persistent state or hidden global dependency is introduced.

---

## Waiting Prep

If a Prep record remains `等待触发` but the full graph now has deterministic active coverage and sufficient leverage, the node exposes:

`triggerSuggested = true`

This is advisory only.

Round 2 does **not** create a new Prep Action. The user or a future explicit review workflow must activate it.

---

## Uncovered needs

The graph exposes active gaps/process-prep needs with no deterministic Prep match.

This supports questions such as:

- Which current interview needs have no preparation task?
- Which skill gaps affect multiple opportunities but lack a Prep node?
- What should become a reusable Prep item next?

Requirements alone are not listed as uncovered gaps unless backed by a gap/process need.

---

## UI

A read-only `Prep Graph` workspace shows:

- Prep node leverage;
- active opportunity coverage;
- matched active needs;
- linked opportunity value and urgency;
- nearest relevant date;
- exact link source/confidence/explanation;
- waiting-task trigger suggestions;
- uncovered gaps/process-prep needs;
- unlinked Prep records.

The UI has no automatic-create or automatic-activate action.

---

## MCP

New bounded read-only tool:

`get_prep_graph`

Optional filters:

- `prepId`
- `opportunityId`
- `limit` (1–50)

The result returns:

- summary counts;
- Prep nodes and leverage signals;
- covered Opportunities;
- deterministic edge evidence;
- uncovered needs;
- explicit policy flags stating that fuzzy links, automatic task creation, and automatic mutation are disabled.

---

## Persistence and compatibility

Round 2 introduces no new IndexedDB store and no snapshot schema migration.

The graph is derived from data already present in snapshot v1:

- `prep`
- `opportunities`
- `processes`
- `processEvents`
- `actions`

Therefore:

- existing backups remain readable;
- Google Drive snapshot/fingerprint semantics remain unchanged;
- no graph state can become stale independently of its source records.

---

## Acceptance criteria

Round 2 is complete when:

1. explicit Prep triggers and process prep packs create high-confidence edges;
2. exact structured requirement/gap/process matches create bounded explainable edges;
3. generic fuzzy terms do not create edges;
4. requirements are not mislabeled as user gaps;
5. closed opportunities cannot inflate Prep leverage;
6. uncovered active gaps/process needs are visible;
7. waiting Prep may be suggested for activation but is never activated automatically;
8. existing Prep Actions receive runtime graph projection without stored mutation;
9. unlinked Prep Actions no longer claim cross-role reuse;
10. local Prep Graph UI and MCP read output share the same engine;
11. snapshot v1 remains compatible;
12. all repository tests, dependency audit, TypeScript and production build pass.

---

## Non-goals

Round 2 does not add:

- LLM/embedding semantic graph matching;
- automatic Prep generation;
- automatic Action activation;
- automatic skill-learning plans;
- interview-answer generation;
- calendar scheduling;
- autonomous mutation of Prep or Opportunity data.

Those require separate product decisions after real Prep Graph usage is observed.

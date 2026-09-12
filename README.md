# PJSDAS

**Personal Job Search Decision & Action System**

PJSDAS is a local-first personal job-search decision workspace. It is not primarily an application tracker. Its job is to turn opportunities, recruiting-process changes, shared application quotas, preparation work, deadlines, discovery history and available time into a small set of explainable next decisions and actions.

## Product principle

> **The system should help answer one question within 30 seconds: _What should I do next for my job search?_**

The spreadsheet is an initialization / recovery source, not the daily source of truth. The browser workspace is authoritative for day-to-day use, with optional Google Drive synchronization.

PJSDAS follows one architectural rule throughout the product:

> **AI may read, explain and propose. PJSDAS owns state, policy, validation, ChangeSets and final mutation semantics.**

No AI-facing tool directly applies arbitrary workspace mutations. AI write intent is normalized into a bounded ChangeSet, signed when it comes from the remote MCP gateway, and requires explicit local review before Apply.

## v1.8 product surfaces

v1.8 consolidates the UI around user goals instead of exposing every engine or data table as a first-level destination.

- **Today** — execute the next moves under time and deadline constraints, then capture real progress or recruiting notifications in the same workspace.
- **Decide** — one decision journey with three contexts: Discover & Review, Opportunities, and Pipeline. Continuous Discovery Radar and Application Portfolio live here as contextual tools.
- **Prepare** — reusable Prep inventory and Prep Graph leverage in one workspace.
- **History** — Timeline facts and ChangeSet audit history.
- **Settings** — Google Drive, Discovery Profile, Decision Rules, Excel initialization/recovery, local backup and language.

Specialist capabilities still exist, but no longer compete for first-level navigation. Discovery Inbox, Opportunities, Pipeline, Continuous Discovery Radar, Application Portfolio, Prep Graph, Natural Language Update, Process Event capture, Decision Rules and Backup are surfaced only where the user needs them.

`FixedEventGuard` remains global because it is a safety/recovery guard, not a selectable workspace.

See `docs/V1_8_PRODUCT_SURFACE_CONSOLIDATION.md` for the IA contract.

## Core model

PJSDAS separates durable state, source evidence, assessments and derived decision views:

1. **Opportunity** — a job the user has decided belongs in the active workspace.
2. **Job Posting** — one public source record supporting an Opportunity or Discovery Inbox item.
3. **Rich Opportunity Facts** — bounded source-backed facts such as responsibilities, requirements, education, skills, location, application method and compensation evidence.
4. **Opportunity Assessment** — AI-proposed component judgments kept separate from source facts.
5. **Process / Process Event** — effective recruiting state plus dated real-world facts.
6. **Action** — a concrete next move.
7. **Prep / Prep Graph** — reusable preparation assets plus deterministic coverage/leverage links.
8. **Application Group** — explicit shared-quota or shared-preference constraints.
9. **Discovery Profile / Discovery Inbox / Discovery Run** — durable search preferences, pre-Opportunity candidates and auditable discovery history.
10. **Decision Rules** — explicit user-controlled policy and weights.
11. **Timeline / ChangeSet** — factual audit history and normalized review/apply mutation protocol.
12. **Today** — the constrained plan produced from current state and available time.

## Decision architecture

PJSDAS is deterministic after interpretation. AI may propose assessments, but PJSDAS owns aggregation and policy.

### Today

Today combines Opportunity Value, Fit, urgency, recruiting stage, leverage, delay cost and time efficiency, then applies operational guardrails. Real deadlines and fixed events use different timing semantics; overdue process-event work leaves the executable queue and enters recovery/confirmation instead of remaining falsely actionable.

### Component assessment

Fit and Opportunity Value are decomposed into bounded components with score, confidence and rationale. Missing components are not silently filled with neutral values. PJSDAS aggregates known components using explicit Decision Rules while keeping coverage/confidence separate from merit.

Historical stored aggregate scores are not silently rewritten when weights later change. The read layer can explicitly show a current-rules projection alongside the stored historical aggregate.

### Application Portfolio

Inside an explicit Application Group, PJSDAS can recommend a role portfolio using Fit, Opportunity Value, role priority, deadline pressure, application efficiency, evidence confidence and pairwise overlap penalties.

A remaining quota is a **maximum**, not a target. PJSDAS may recommend fewer roles than the available slots when marginal value is too low.

### Prep Graph

Prep Graph is derived state, not another persistent database. Deterministic links can come from explicit triggers, process prep packs, structured requirements, explicit/assessment-backed gaps and active assessment/written-test/interview preparation needs.

Generic words or fuzzy semantic similarity do not silently create leverage edges. Existing Prep Actions can receive runtime-only leverage/urgency projection without rewriting stored history.

## Discovery architecture

PJSDAS itself does not run a public-web crawler. The AI client performs public web search; PJSDAS supplies durable preferences, current state, deterministic quality gates, posting identity/freshness and review-only mutation semantics.

```text
Discovery Profile
→ get_discovery_context
→ AI public-web search
→ source-backed candidates
→ Rich Opportunity facts + component assessment
→ quality gate / dedup / suppression
→ signed review
→ Discovery Inbox or Opportunity
→ Timeline / ChangeSet / Drive sync
```

### Continuous Discovery and refresh

Durable Discovery Runs provide incremental baselines, source coverage and a bounded posting refresh queue. Stale/aging/unknown posting sources can be re-verified through a signed review-only refresh protocol bound to exact owner + posting + canonical URL identity.

A public posting becoming closed does **not** automatically close the Opportunity or Process. Source state and user/recruiting lifecycle state remain separate.

A discovery pass with zero eligible candidates can create a review-only `record_discovery_run` ChangeSet so “searched and found nothing new” remains distinguishable from “never searched”.

## ChangeSet and audit boundary

ChangeSet is the normalized mutation protocol across PJSDAS. It covers natural-language progress updates, Decision Rules changes, Process Events, Action status changes, discovered Opportunities, posting refreshes and zero-result Discovery Runs.

Remote MCP proposals are bound to the workspace fingerprint / Drive checkpoint used when the proposal was created. The browser verifies signature, expiry and the local baseline before Apply.

Opening a review link never mutates PJSDAS.

## Local-first storage and sync

- React + TypeScript + Vite
- IndexedDB is the immediate local workspace
- Google Drive `appDataFolder` is the optional private cloud copy / synchronization target
- workspace snapshots are validated before restore or remote replacement
- SHA-256 workspace fingerprints participate in conflict and proposal-baseline checks
- Drive synchronization fails closed on concurrent changes instead of using silent last-write-wins
- Supabase is authentication/OAuth plumbing for remote AI access, not the primary job-search database

Current snapshot schema remains **v1**. Derived layers such as Prep Graph and Continuous Discovery reuse existing persisted structures instead of multiplying stores unnecessarily.

## AI / MCP gateway

The authenticated MCP gateway exposes bounded semantic reads rather than raw database access. Current capabilities include Today plan, Opportunities/Rich facts, assessment explanation, Application Portfolio, Prep Graph, Pipeline, Decision Rules, Discovery Context / Continuous Discovery state, deterministic priority explanation, recent Timeline and review-only ChangeSet proposals.

The remote gateway never directly applies workspace changes.

## Natural Language Update

Free-form progress updates remain a deterministic local maintenance path. PJSDAS can split dated clauses, match or create opportunities when safe, record applications and process events, resolve relative windows, distinguish deadline work from fixed events, and leave ambiguity unresolved instead of guessing.

The original pasted text is not stored by default; only the normalized reviewed mutation is persisted.

## Backup and recovery

The local snapshot contains Opportunities and source evidence, Processes / Process Events, Actions, Prep, Application Groups, Decision Rules, Discovery Profile / Inbox, Timeline, ChangeSets / Discovery Run metadata and import metadata. Restore validates schema, IDs, references and dates before destructive replacement.

## Current status

**Current product baseline: v1.8 Product Surface Consolidation on top of the v1.7 Continuous Discovery / Refresh architecture.**

The decision loop remains:

```text
public discovery
→ posting identity / freshness
→ Discovery Inbox
→ Rich Opportunity facts
→ component assessment
→ application-portfolio decision
→ Prep Graph
→ Today
→ Continuous Discovery / source refresh
```

v1.8 changes how the user reaches these capabilities, not their underlying decision semantics.

## Development

```bash
npm ci
npm test
npm run build
npm run dev
```

CI runs dependency auditing, the Vitest regression suite and the TypeScript/Vite production build.

Recent design / architecture notes under `docs/` include:

- `V1_6_ROUND_1_APPLICATION_PORTFOLIO.md`
- `V1_6_ROUND_2_PREP_GRAPH.md`
- `V1_7_CONTINUOUS_DISCOVERY.md`
- `V1_7_ROUND_2_DISCOVERY_REFRESH_PROTOCOL.md`
- `V1_8_PRODUCT_SURFACE_CONSOLIDATION.md`

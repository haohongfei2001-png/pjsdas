# PJSDAS

**Personal Job Search Decision & Action System**

PJSDAS is a local-first personal job-search decision workspace. It is not primarily an application tracker. Its job is to turn opportunities, recruiting-process changes, shared application quotas, preparation work, deadlines, discovery history and available time into a small set of explainable next decisions and actions.

## Product principle

> **The system should help answer one question within 30 seconds: _What should I do next for my job search?_**

The spreadsheet is an initialization / recovery source, not the daily source of truth. The browser workspace is authoritative for day-to-day use, with optional Google Drive synchronization.

PJSDAS follows one architectural rule throughout the product:

> **AI may read, explain and propose. PJSDAS owns state, policy, validation, ChangeSets and final mutation semantics.**

No AI-facing tool directly applies arbitrary workspace mutations. AI write intent is normalized into a bounded ChangeSet, signed when it comes from the remote MCP gateway, and requires explicit local review before Apply.

## Current product surfaces

- **Today** — time-boxed next actions under available time, deadlines and fixed events.
- **Opportunities** — the active role pool, Rich Opportunity facts and current assessment state.
- **Pipeline** — effective recruiting stages, process events, waiting states and review checkpoints.
- **Prep** — reusable preparation nodes whose leverage can span multiple opportunities.
- **Discovery Inbox** — persistent intermediate state between “AI found this” and “this belongs in Opportunities”.
- **Discovery Decision Workspace** — sorting, comparison, evidence completeness, risks, batch Later / Dismiss and explicit Promote preview.
- **Discovery Radar** — Continuous Discovery history, incremental baseline, source coverage and posting refresh queue.
- **Application Portfolio** — deterministic recommendations inside explicit shared-quota Application Groups; capacity is a ceiling, not a fill target.
- **Prep Graph** — deterministic links from job requirements / explicit gaps / process needs to reusable Prep nodes and Today leverage.
- **Timeline** — durable factual history and audit trail.
- **Decision Rules** — explicit user-controlled policy for Today ranking, component assessment and portfolio decisions.
- **Natural Language Update** — deterministic free-form progress parsing → structured review → ChangeSet → Apply.
- **Import & Settings** — recovery-oriented spreadsheet import, Google Drive synchronization, AI access and local backup.

## Core model

PJSDAS currently separates the workspace into these main concepts:

1. **Opportunity** — a job opportunity the user has decided belongs in the active workspace.
2. **Job Posting** — one public source record supporting an Opportunity or Discovery Inbox item. Opportunity and Posting are deliberately different concepts.
3. **Rich Opportunity Facts** — bounded, source-backed structured facts such as responsibilities, requirements, education, skills, location, application method and compensation evidence.
4. **Opportunity Assessment** — AI-proposed component judgments kept separate from source facts.
5. **Process** — the effective recruiting stage for an Opportunity.
6. **Process Event** — a dated recruiting fact such as assessment, written test, interview, offer, rejection or status update.
7. **Action** — a concrete next move.
8. **Prep** — reusable preparation work.
9. **Prep Graph** — derived links from Prep to current opportunities, gaps and process-preparation needs.
10. **Application Group** — an explicit shared-quota / shared-preference constraint across roles.
11. **Discovery Profile** — durable user-controlled job-discovery preferences. PJSDAS does not silently infer or rewrite this profile from chat history.
12. **Discovery Inbox** — candidate jobs held before explicit promotion into Opportunities.
13. **Discovery Run** — an auditable public-search / refresh pass used by Continuous Discovery.
14. **Decision Rules** — explicit policy and weights.
15. **Timeline** — factual workspace history.
16. **ChangeSet** — the normalized review/apply mutation protocol.
17. **Today** — the constrained plan produced from the current workspace and available time.

## Decision engine

PJSDAS is deterministic after interpretation. AI may propose assessments, but PJSDAS owns aggregation and policy.

### Today ranking

Today combines:

- Opportunity Value
- Fit
- urgency
- recruiting stage
- leverage
- delay cost
- time efficiency

and then applies operational guardrails. Real deadlines and fixed events use different timing semantics; overdue process-event work leaves the executable queue and enters recovery/confirmation instead of remaining falsely actionable.

### Component assessment

Fit is decomposed into bounded components such as:

- role direction
- skills
- education
- experience
- industry
- language
- location

Opportunity Value is decomposed into components such as:

- company quality
- role growth
- compensation value
- career optionality
- brand value
- industry growth
- location value

Each component carries a score, confidence and rationale. Missing components are not silently filled with neutral values. PJSDAS aggregates known components using explicit Decision Rules while keeping coverage / confidence separate from merit.

Historical stored aggregate scores are not silently rewritten when weights later change. The read layer can explicitly show the current-rules projection alongside the stored historical aggregate.

### Application Portfolio

Inside an explicit Application Group, PJSDAS can recommend a portfolio of roles using Fit, Opportunity Value, role priority, deadline pressure, application efficiency, evidence confidence and pairwise overlap penalties.

A remaining quota is a **maximum**, not a target. PJSDAS may recommend fewer roles than the available slots when the marginal portfolio value is not high enough.

## Discovery architecture

PJSDAS itself does not run a public-web crawler. The AI client performs public web search; PJSDAS supplies durable preferences, current state, deterministic quality gates and review-only mutation semantics.

### Discovery flow

```text
Discovery Profile
→ get_discovery_context
→ AI public-web search
→ source-backed candidates
→ component assessment + Rich Opportunity facts
→ deterministic quality gate / dedup / suppression
→ signed review
→ Discovery Inbox or Opportunity
→ Timeline / ChangeSet / Drive sync
```

### Discovery Inbox

A discovered job does not have to become an Opportunity immediately. It can be explicitly saved to the Discovery Inbox with states:

- `new`
- `seen`
- `later`
- `dismissed`
- `promoted`

Dismissal feedback suppresses highly similar same-company jobs for a bounded period; promotion remains explicit.

### Job identity and freshness

Public postings have canonicalized source URLs, stable posting identities and freshness states:

- `fresh`
- `aging`
- `stale`
- `closed`
- `unknown`

Tracking parameters do not create duplicate posting identities. A new source URL can represent a replacement / re-post instead of overwriting source history.

### Continuous Discovery — v1.7

Discovery is no longer treated as a stateless full search every time. Durable Discovery Runs provide:

- last-run baseline
- `incrementalSince`
- aggregate screening counts
- source coverage
- recent recorded queries when the client supplied them
- a bounded posting refresh queue

Normal discovery can therefore prefer new or materially updated postings after the last durable baseline instead of repeatedly searching the entire historical space.

### Discovery Refresh Protocol — v1.7 Round 2

Stale / aging / unknown sources can be re-verified through a review-only posting refresh protocol.

The refresh target is bound to an exact:

- owner kind
- owner ID
- posting ID
- canonical source URL

The server validates this baseline before signing a proposal, and the local Apply path validates it again before writing.

A refresh may update same-source evidence such as posting status, verification time, source title, location, deadline or compensation evidence. A different canonical source is not allowed to overwrite the old posting; it must go through normal discovery / re-post semantics.

**A public posting becoming closed does not automatically close the Opportunity or Process.** Source state and user/recruiting lifecycle state remain separate.

A discovery pass with zero eligible candidates can also produce a review-only `record_discovery_run` ChangeSet. Applying it records the search as an auditable Run but creates no Opportunity or Action.

## Prep Graph

Prep Graph is derived state; it is not another persistent database.

Deterministic links can come from:

- explicit `Prep.triggeredBy`
- explicit Process prep-pack relationships
- structured requirements
- explicit / assessment-backed gaps
- active assessment / written-test / interview preparation needs

Generic words or fuzzy semantic similarity do not silently create leverage edges.

Existing Prep Actions can receive runtime-only leverage / urgency projection from the graph. Their stored historical Action records are not rewritten.

## ChangeSet and audit boundary

ChangeSet is the normalized mutation protocol across PJSDAS.

Examples include:

- normalized natural-language progress updates
- Decision Rules changes
- Process Event creation/deletion
- Action status changes
- discovered Opportunity additions
- review-only posting refreshes
- zero-result Discovery Run records

Remote MCP proposals are bound to the exact workspace fingerprint / Drive checkpoint used when the proposal was created. The browser verifies the signed capability, expiry and local baseline before Apply.

Opening a review link never mutates PJSDAS.

## Local-first storage and sync

- **React + TypeScript + Vite**
- **IndexedDB** is the immediate local workspace.
- **Google Drive `appDataFolder`** is the optional private cloud copy / synchronization target.
- Workspace snapshots are validated before restore or remote replacement.
- SHA-256 workspace fingerprints participate in conflict and proposal-baseline checks.
- Drive synchronization is fail-closed on concurrent changes rather than silent last-write-wins.
- Supabase is used for authenticated remote AI-access plumbing, not as the primary job-search database.

Current snapshot schema remains **v1**. Newer derived layers such as Prep Graph and Continuous Discovery reuse existing persisted structures rather than multiplying stores unnecessarily.

## AI / MCP gateway

The authenticated MCP gateway exposes bounded semantic reads rather than raw database access. Current capabilities include:

- Today plan
- Opportunities and optional Rich facts
- component-assessment explanation
- application-portfolio decision
- Prep Graph
- Pipeline
- Decision Rules
- Discovery Context / Continuous Discovery state
- deterministic priority explanation
- recent Timeline
- review-only ChangeSet proposals

The remote gateway never directly applies workspace changes.

## Natural Language Update

Free-form progress updates remain a deterministic local maintenance path. PJSDAS can split dated clauses, match or create opportunities when safe, record applications and process events, resolve relative windows, distinguish deadline work from fixed events, and leave ambiguity unresolved instead of guessing.

The original pasted text is not stored by default; only the normalized reviewed mutation is persisted.

## Backup and recovery

The local snapshot includes the authoritative persistent workspace, including:

- Opportunities and source evidence
- Processes / Process Events
- Actions
- Prep
- Application Groups
- Decision Rules
- Discovery Profile / Discovery Inbox
- Timeline
- ChangeSets, including durable Discovery Run metadata
- import metadata

Restore validates schema, IDs, references and dates before destructive replacement.

## Current status

**Current architecture baseline: v1.7 + Discovery Refresh Protocol (Round 2).**

The main decision loop is now connected end to end:

```text
public discovery
→ posting identity / freshness
→ Discovery Inbox
→ Rich Opportunity facts
→ component assessment
→ application-portfolio decision
→ Prep Graph
→ Today
→ Continuous Discovery
→ review-only source refresh
```

The next product phase should prioritize **surface consolidation and day-to-day product experience**, not another large expansion of backend decision concepts. PJSDAS already has enough decision primitives; the next risk is allowing the UI to become a collection of expert dashboards rather than a fast personal workflow.

## Development

```bash
npm ci
npm test
npm run build
npm run dev
```

CI runs dependency auditing, the Vitest regression suite and the TypeScript/Vite production build.

Design / architecture notes for recent rounds live under `docs/`, including:

- `V1_6_ROUND_1_APPLICATION_PORTFOLIO.md`
- `V1_6_ROUND_2_PREP_GRAPH.md`
- `V1_7_CONTINUOUS_DISCOVERY.md`
- `V1_7_ROUND_2_DISCOVERY_REFRESH_PROTOCOL.md`

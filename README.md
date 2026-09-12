# PJSDAS

**Personal Job Search Decision & Action System**

PJSDAS is a local-first personal job-search decision workspace. It is not primarily an application tracker. Its job is to turn opportunities, recruiting-process changes, shared application quotas, preparation work, deadlines, source-backed job discovery and available time into a small set of explainable next decisions and actions.

## Product principle

> **The system should help answer one question within 30 seconds: _What should I do next for my job search?_**

The spreadsheet is an initialization / recovery source, not the daily source of truth. The browser workspace is authoritative for day-to-day use, with an optional private Google Drive copy for synchronization and remote trusted ingestion.

PJSDAS follows one architectural rule throughout the product:

> **AI may read, explain and propose. PJSDAS owns durable state, policy, identity, validation, reconciliation and mutation semantics.**

Generic AI write intent is normalized into bounded ChangeSets and remains review-only. Dedicated trusted-ingestion tools may write narrowly scoped, source-backed factual observations from approved sources such as job monitors and recruiting Gmail; they cannot silently change Decision Rules, discovery preferences, destructive state or ambiguous identity.

## v1.9 product surfaces

v1.9 keeps the UI organized around user goals rather than exposing every engine or maintenance queue as a first-level destination.

- **Today** — execute concrete next moves under time and deadline constraints, then capture real progress or recruiting notifications.
- **Decide** — choose among **Opportunities** and inspect the real recruiting **Pipeline**. Passive review/maintenance is not a primary tab or counter.
- **Prepare** — reusable Prep inventory and Prep Graph leverage in one workspace.
- **History** — Timeline facts and ChangeSet audit history.
- **Settings** — account/sync, Discovery Profile, Decision Rules, initialization/recovery, backup and language.

Background freshness, source health, reconciliation, unresolved records and integrity checks remain available to system/Coverage/audit tooling, but they do not become user work merely because PJSDAS has something to verify.

`FixedEventGuard` remains global because it is a safety/recovery guard, not a selectable workspace.

See `docs/V1_9_AUTONOMOUS_INGESTION_RECONCILIATION.md`, `docs/V1_9_PRE_RELEASE_HARDENING.md` and `docs/V1_9_INPUT_SEMANTICS_HARDENING.md` for the current contracts.

## Core model

PJSDAS separates durable state, source evidence, assessments and derived decision views:

1. **Opportunity** — a canonical job identity in the workspace.
2. **Job Posting** — source evidence supporting an Opportunity or discovery candidate.
3. **Rich Opportunity Facts** — bounded source-backed facts such as responsibilities, requirements, education, skills, location, application method and compensation evidence.
4. **Opportunity Assessment** — AI-proposed component judgments kept separate from source facts.
5. **Process / Process Event** — effective recruiting state plus dated real-world facts.
6. **Action** — a concrete next move; passive follow-up does not occupy Today.
7. **Prep / Prep Graph** — reusable preparation assets plus deterministic coverage/leverage links.
8. **Application Group** — explicit shared-quota or shared-preference constraints.
9. **Discovery Profile / Discovery Inbox / Discovery Run** — durable search preferences, source-backed discovery state and auditable discovery history.
10. **Decision Rules** — explicit user-controlled policy and weights.
11. **Timeline / ChangeSet** — factual audit history and normalized proposal/apply protocol.
12. **Ingestion Ledger / Source Registry / Coverage** — durable accounting of trusted autonomous inputs and their reconciliation outcomes.
13. **Today** — the constrained plan produced from current state and available time.

## Decision architecture

PJSDAS is deterministic after interpretation. AI may propose assessments, but PJSDAS owns aggregation and policy.

### Today

Today combines Opportunity Value, Fit, urgency, recruiting stage, leverage, delay cost and time efficiency, then applies operational guardrails. Real deadlines and fixed events use different timing semantics. Passive `follow_up` / review reminders are excluded from Today ranking and time planning.

### Component assessment

Fit and Opportunity Value are decomposed into bounded components with score, confidence and rationale. Missing components are not silently filled with neutral values. PJSDAS aggregates known components using explicit Decision Rules while keeping coverage/confidence separate from merit.

Historical stored aggregate scores are not silently rewritten when weights later change. The read layer can explicitly show a current-rules projection alongside the stored historical aggregate.

### Application Portfolio

Inside an explicit Application Group, PJSDAS can recommend a role portfolio using Fit, Opportunity Value, role priority, deadline pressure, application efficiency, evidence confidence and pairwise overlap penalties.

A remaining quota is a **maximum**, not a target. PJSDAS may recommend fewer roles than the available slots when marginal value is too low.

### Prep Graph

Prep Graph is derived state, not another persistent database. Deterministic links can come from explicit triggers, process prep packs, structured requirements, explicit/assessment-backed gaps and active assessment/written-test/interview preparation needs.

Generic words or fuzzy semantic similarity do not silently create leverage edges. Existing Prep Actions can receive runtime-only leverage/urgency projection without rewriting stored history.

## Discovery and trusted ingestion

PJSDAS itself does not run a public-web crawler. The AI client performs public web search; PJSDAS supplies durable preferences, current state, deterministic quality gates, canonical posting identity and reconciliation rules.

```text
Discovery Profile
→ AI public-web search / bounded monitor
→ source-backed candidates
→ identity + quality gate
→ canonical Opportunity / source update / filtered / duplicate / unresolved
→ Ingestion Ledger + Coverage
→ Google Drive workspace
→ local IndexedDB sync
```

Trusted GPT monitors and recruiting Gmail can submit complete bounded runs through dedicated ingestion tools. Every submitted source record in a completed run must be durably accounted for as `created`, `merged`, `updated`, `duplicate`, `filtered`, `ignored` or `unresolved`; records cannot silently disappear.

Ambiguous company/role identity fails closed. Tracking-only URL variants merge. Repeated runs are idempotent. Drive writes use exact `workspaceVersion` optimistic conflict protection.

A public posting becoming closed does **not** automatically close the user's recruiting Process. Public-source lifecycle and recruiting lifecycle remain separate.

### Canonical job identity

User-entered role text is an alias, not title authority. A canonical role title must be source-backed and bound to the corresponding Job Posting identity.

Typos, omitted characters, brand aliases and shorthand may resolve to a unique canonical job. Unsourced or source-drifted legacy Opportunities cannot define a canonical title merely because the user's wording matches them. When a trusted source later identifies the same logical job, PJSDAS preserves the existing Opportunity ID and history while normalizing the incoming company/role title instead of creating a duplicate.

Role-transfer / rename operations follow the same rule: a manually typed target title cannot become canonical without a unique source-backed target.

## Attention model

PJSDAS distinguishes **system state** from **user work**.

```text
source / monitor state
→ system reconciliation
→ canonical workspace fact
→ real user action, only when needed
```

not:

```text
source / monitor state
→ review queue
→ user maintains the database
```

Freshness, silence risk, source health, unresolved exceptions and reconciliation state may remain available in Coverage or audit tooling. They do not occupy Today, primary Decide tabs, primary counters or Pipeline cards unless they resolve into a concrete real-world action for the user.

## ChangeSet and audit boundary

ChangeSet remains the normalized mutation protocol for user-initiated or generic AI-proposed changes such as natural-language progress updates, Decision Rules changes, Process Events, Action status changes and other review-required mutations.

Remote proposals are bound to the workspace fingerprint / Drive checkpoint used when the proposal was created. The browser verifies signature, expiry and local baseline before Apply.

Trusted autonomous ingestion is a separate bounded path for approved factual sources; it does not grant general mutation authority.

## Local-first storage and sync

- React + TypeScript + Vite
- IndexedDB is the immediate local workspace
- Google Drive `appDataFolder` is the durable private workspace bridge for synchronization and unattended trusted ingestion
- workspace snapshots are validated before restore or remote replacement
- SHA-256 workspace fingerprints participate in conflict and proposal-baseline checks
- Drive synchronization fails closed on concurrent changes instead of silent last-write-wins
- Supabase provides stable account/session and encrypted Google refresh-token binding; it is not the primary job-search database

Current snapshot schema remains **v1**. Reliability layers such as Ingestion Ledger, Source Registry, Coverage and Workspace Integrity reuse the validated workspace contract rather than turning PJSDAS into a generic backend database.

## AI / MCP gateway

The authenticated MCP gateway exposes bounded semantic reads and narrowly scoped tools. Current capabilities include Today, Opportunities/Rich facts, assessment explanation, Application Portfolio, Prep Graph, Pipeline, Decision Rules, discovery context, Coverage, Workspace Integrity and trusted Monitor/Gmail ingestion.

Generic `propose_changes` remains review-only. Trusted ingestion tools are capability-specific and source-bounded.

## Natural Language Update

Free-form updates use a deterministic parser plus a safety/identity policy layer. PJSDAS can record applications and process events, understand compact forms such as `公司 + 测试`, capture non-job manual tasks, and leave ambiguous recruiting text unresolved rather than guessing.

Manual job names never define canonical identity on their own. Later same-batch operations are relinked to the resolved canonical Opportunity ID when safe.

The original pasted text is not stored by default; only normalized workspace mutations are persisted.

## Reliability and operations

v1.9 adds:

- Dynamic Source Registry and freshness/SLA-aware Coverage;
- Workspace Integrity Audit;
- ingestion dry-run / replay;
- source health and run history;
- production self-test;
- backend-first GitHub Pages release gate;
- stable Supabase account session + Google access-token broker;
- optimistic-version guarded Google Drive writes.

The production release gate requires the backend to advertise the full v1.9 capability contract before the matching frontend is published.

## Backup and recovery

The local snapshot contains Opportunities and source evidence, Processes / Process Events, Actions, Prep, Application Groups, Decision Rules, Discovery Profile / Inbox, Timeline, ChangeSets / Discovery Run metadata, ingestion accounting and import metadata. Restore validates schema, IDs, references and dates before destructive replacement.

## Current status

**Current code baseline: v1.9 Autonomous Ingestion & Reconciliation with pre-release reliability, canonical-identity and attention hardening.**

The current decision loop is:

```text
trusted discovery + recruiting signals
→ source-backed identity / reconciliation
→ Opportunities + Pipeline
→ component assessment / portfolio / Prep Graph
→ Today
→ only concrete user actions enter the foreground
```

The v1.9 release candidate is validated on the pre-release branch and is intended to merge only when the Vercel production deployment window is available; the backend-first gate keeps the previously deployed frontend live if production backend readiness is not satisfied.

## Development

```bash
npm ci
npm test
npm run build
npm run dev
```

CI runs dependency auditing, the Vitest regression suite and the TypeScript/Vite production build.

Recent design / architecture notes under `docs/` include:

- `V1_8_PRODUCT_SURFACE_CONSOLIDATION.md`
- `V1_8_PROCESS_LIFECYCLE_CORRECTNESS_AUDIT.md`
- `V1_8_RELEASE_HARDENING.md`
- `V1_9_AUTONOMOUS_INGESTION_RECONCILIATION.md`
- `V1_9_PRE_RELEASE_HARDENING.md`
- `V1_9_INPUT_SEMANTICS_HARDENING.md`

# PJSDAS

**Personal Job Search Decision & Action System**

PJSDAS is a local-first, AI-native job-search decision and action workspace. It is not primarily an application tracker. Its purpose is to turn opportunities, recruiting-process changes, deadlines, preparation work, application constraints, trusted source updates, and available time into a small set of explainable next decisions and actions.

> **The system should help answer one question within 30 seconds: _What should I do next for my job search?_**

## Release status

**Current formal release: `v1.0.1`**  
**Current engineering milestone: `v1.10`**

The public product release uses Semantic Versioning. Historical `v1.9` / `v1.10` labels in design and hardening documents are engineering milestones, not earlier public releases. The authenticated MCP gateway runtime is versioned independently and currently remains `1.9.0-alpha.1`.

The `v1.0.1` Git tag identifies its production-verified release commit. Earlier release tags, including `v1.0.0`, remain pinned to their original verified commits as `main` continues to advance.

See [`docs/RELEASE_POLICY.md`](docs/RELEASE_POLICY.md) for the permanent mapping between product version, package version, Git tag, gateway runtime, exact deployed commit identity, and GitHub platform release immutability.

## Product surface

PJSDAS is organized around user goals rather than maintenance queues:

- **Today** — execute concrete next moves and see the next hard node.
- **Opportunities** — evaluate opportunities, inspect Pipeline, and open contextual Prep/Prep Graph.
- **Attention** — only conflicts, governed changes, and source exceptions that genuinely require the user.
- **Activity** — read-only audit of facts, commands, automation, and provenance.
- **Settings** — account/automation, Discovery Profile, Decision Rules, connected migration, backup/recovery, and language.

Manual progress/process capture remains available as a fallback, but routine fact capture is expected to move through AI or trusted automation.

## Product architecture

PJSDAS follows one boundary throughout the system:

> **AI may read, explain, interpret, and execute bounded explicit commands. PJSDAS owns authorization, durable state, policy, identity, validation, reconciliation, and mutation semantics.**

Core durable concepts include:

- **Opportunity / Job Posting** — canonical job identity plus source evidence;
- **Process / Process Event** — effective recruiting state and dated real-world facts;
- **Action** — concrete next moves;
- **Prep / Prep Graph** — reusable preparation plus deterministic leverage links;
- **Application Group** — explicit shared-quota or shared-preference constraints;
- **Discovery Profile / Discovery Run** — durable search preferences and auditable discovery history;
- **Decision Rules** — explicit user-controlled policy and weights;
- **Timeline / ChangeSet** — factual history and normalized review/apply protocol;
- **Ingestion Ledger / Source Registry / Coverage** — trusted-source accounting and health.

PJSDAS is deterministic after interpretation. AI may provide bounded assessments, but scoring aggregation, identity, policy, reconciliation, and durable writes remain product-owned.

## Job discovery and trusted ingestion

Interactive MCP tools do not perform arbitrary job-web discovery. Background Discovery may find candidates, but PJSDAS independently fetches and verifies each submitted public source URL before source facts can create or refresh an Opportunity.

```text
Discovery Profile
→ AI public-web search / trusted monitor
→ candidate evidence
→ independent source fetch / verification
→ identity + quality gate
→ canonical Opportunity / source update / filtered / duplicate / unresolved
→ Ingestion Ledger + Coverage
→ current connected authority
→ local IndexedDB cache / working copy
```

Trusted Monitor and recruiting Gmail ingestion are intentionally narrow:

- every submitted source record must be accounted for;
- ambiguous company/role identity fails closed;
- tracking-only URL variants merge;
- repeated runs are idempotent;
- Drive writes require exact workspace-version conflict protection;
- trusted ingestion cannot silently change Decision Rules, durable preferences, destructive state, or ambiguous identity.

Explicit, exact-target, low-risk P1 commands are represented as bounded Domain Commands. Ambiguous P2 intent is clarified in the AI conversation. Governed P3 changes remain review/approval operations, and P4 automation requires explicit source/client capability grants.

## Storage and sync

PJSDAS supports two explicit authority modes:

- **Local mode** — IndexedDB is authoritative and remote AI/background writers are not the durable state owner.
- **Connected mode** — a transactional Supabase/PostgreSQL workspace is authoritative; IndexedDB is the local working copy/offline cache and Google Drive is backup/export/portability storage.

The current owner-controlled production deployment is already on the transactional Supabase/PostgreSQL workspace authority with owner-only allowlist access. `https://todayaction.com` is the canonical Web/API origin. Google Drive is backup/export/portability storage, and the legacy GitHub Pages origin remains a bounded migration/recovery origin.

Workspace snapshots are validated before restore or migration. SHA-256 fingerprints participate in conflict detection and migration verification. Divergent non-empty Local/Drive states fail closed rather than using last-write-wins.

Older spreadsheets are initialization/recovery material, not the live source of truth.

## AI / MCP gateway

The authenticated MCP gateway exposes bounded semantic reads and narrowly scoped tools for:

- Today planning;
- Opportunities and rich source-backed facts;
- Pipeline;
- Decision Rules;
- component assessment explanation;
- Application Portfolio;
- Prep Graph;
- Discovery Context;
- Coverage / source health;
- Workspace Integrity;
- bounded trusted Monitor and Gmail ingestion;
- bounded explicit user Domain Commands after transactional authority activation.

The production auth boundary rejects anonymous MCP access. The release health contract also exposes a versioned release-tool surface so production can verify that required MCP capabilities are present without requiring a QA account or test secrets.

## Reliability and autonomous QA

The v1.10 engineering milestone adds an autonomous reliability harness intended to move routine QA out of the user's workflow:

- golden/synthetic workspace scenarios;
- reproducible seeded state-machine stress tests;
- adversarial ingestion matrices;
- Drive/sync/replay/concurrency fault injection;
- Chromium end-to-end critical journeys;
- workspace integrity and source-health audits;
- production self-test;
- exact frontend/backend Git commit binding;
- accountless production MCP release-tool-surface proof;
- backend-first GitHub Pages release gating.

The target development loop is:

```text
product change
→ automated regression / invariant / fault-injection checks
→ Chromium E2E
→ PR
→ exact production backend gate
→ Pages deploy
→ post-deploy Production Self-Test
```

A bug class that has appeared once should become a permanent regression case rather than repeatedly requiring manual discovery.

## Release process

A formal public release is created only after the exact same commit has passed:

1. dependency audit, unit/regression/reliability tests, and production build;
2. Browser E2E;
3. production backend deployment;
4. exact backend/frontend commit and capability/tool-surface verification;
5. anonymous authentication-boundary checks;
6. GitHub Pages deployment;
7. post-deploy Production Self-Test.

When `.github/release-plan.json` is explicitly armed, a successful Production Self-Test triggers the release publisher. The publisher creates a version-pinned Git tag and GitHub Release for the verified commit and refuses to move or reuse an existing tag. After a release is published, the plan is disarmed until the next intentional public release.

GitHub's platform-level **Immutable Releases** feature is a separate repository setting. It was not enabled before `v1.0.0`, so the v1.0.0 release is verified and version-pinned by PJSDAS policy but is not GitHub-platform-immutable. Future release immutability is tracked as optional supply-chain hardening rather than a product-development blocker.

## Development

```bash
npm ci
npm test
npm run build
npm run dev
```

Main implementation and architecture references include:

- [`docs/V1_10_AUTONOMOUS_RELIABILITY_HARNESS.md`](docs/V1_10_AUTONOMOUS_RELIABILITY_HARNESS.md)
- [`docs/V1_9_AUTONOMOUS_INGESTION_RECONCILIATION.md`](docs/V1_9_AUTONOMOUS_INGESTION_RECONCILIATION.md)
- [`docs/V1_9_PRE_RELEASE_HARDENING.md`](docs/V1_9_PRE_RELEASE_HARDENING.md)
- [`docs/V1_9_INPUT_SEMANTICS_HARDENING.md`](docs/V1_9_INPUT_SEMANTICS_HARDENING.md)
- [`docs/AI_BRIDGE_DESIGN.md`](docs/AI_BRIDGE_DESIGN.md)
- [`docs/RELEASE_POLICY.md`](docs/RELEASE_POLICY.md)
- [`docs/AI_OPERATED_PRODUCTION_V1.md`](docs/AI_OPERATED_PRODUCTION_V1.md)
- [`docs/PRODUCTION_TOPOLOGY_V1.md`](docs/PRODUCTION_TOPOLOGY_V1.md)


## Ultimate Usability development line

The next major product/usability package is registered under
[`docs/ultimate-usability-v1/README.md`](docs/ultimate-usability-v1/README.md).

Its frozen design refines the product toward a Today-first, automation-heavy, Mac/iPhone-coherent
experience while preserving the transactional authority, audit, idempotency, CAS, provenance, and
external-action safety boundaries defined by the AI-operated production architecture.

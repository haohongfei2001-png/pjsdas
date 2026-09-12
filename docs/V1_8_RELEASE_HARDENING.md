# v1.8 Release Hardening & Performance

## Purpose

This pass turns the stabilized v1.8 product surface into a cleaner release baseline without changing product decisions, persistence semantics, or AI mutation boundaries.

The goal is not to split code for its own sake. A module is deferred only when the user does not need it for ordinary Today startup.

## Release boundary

Unchanged:

- Today ranking and time planning
- Decision Rules
- Opportunity / Process / Action / Prep models
- Discovery quality and suppression semantics
- Application Portfolio
- Prep Graph
- ChangeSet / Timeline semantics
- MCP read and proposal semantics
- IndexedDB / snapshot schema (still snapshot v1)

No new user preference, scoring rule, or persistence store is introduced.

## Performance baseline

### Before hardening — v1.8 Round 4

- initial JS: **1,161.40 kB**
- initial JS gzip: **358.68 kB**
- initial CSS: **117.71 kB**
- initial CSS gzip: **21.90 kB**
- Vite emitted a `>500 kB` chunk warning

### Final hardening build

- initial JS: **486.12 kB**
- initial JS gzip: **149.20 kB**
- initial CSS: **89.66 kB**
- initial CSS gzip: **17.57 kB**
- no emitted chunk exceeds Vite's 500 kB warning threshold

Initial JS reduction from the Round 4 baseline:

- raw: about **58%**
- gzip: about **58%**

## Deferred heavy modules

### Excel initialization / recovery

`xlsx` used to enter the ordinary startup dependency graph even though Excel is only an initialization/recovery feature.

`parsePJSDASWorkbook()` now preserves its existing public API while dynamically loading the unchanged heavy parser implementation.

Deferred Excel chunk:

- `importExcelHeavy`: **374.94 kB**
- gzip: **127.86 kB**

`parseMinutes()` remains synchronous and eager because it is small and is also used by tests/helpers.

### AI access / Supabase

Supabase is authorization plumbing, not part of normal Today execution.

The ordinary `AiAccessProvider` no longer statically imports or initializes Supabase. The client is loaded only when:

1. an AI-access Google OAuth round-trip is pending; or
2. the user explicitly starts AI-access linking.

The dedicated OAuth consent page is also lazily loaded.

Deferred Supabase chunk:

- `supabaseClient`: **224.02 kB**
- gzip: **58.64 kB**

### Specialist workspaces

The following existing implementations remain semantically unchanged but are loaded only when their contextual surface is mounted:

- Discovery Inbox
- Continuous Discovery Radar
- Application Portfolio
- Prep Graph
- Google Drive / AI-access settings
- Discovery Profile settings

Their individual JS chunks are approximately 8–18 kB each, with their feature CSS emitted separately.

## What remains eager

PJSDAS deliberately keeps the core daily path eager:

- App shell and five-surface navigation
- Today ranking and time-boxed planning
- local IndexedDB workspace access
- primary Action completion / undo flow
- Progress Inbox and Process Event quick capture
- core Opportunity / Process state needed to answer “what should I do next?”

This avoids replacing one large initial download with a fragmented Today experience that requires several network round-trips before becoming useful.

## CI hardening

The repository workflows now use the current Node-runtime generations:

- `actions/checkout@v7`
- `actions/setup-node@v7`

This removes the previous GitHub Actions Node 20 runtime deprecation warning.

GitHub Pages now uses `npm ci` with npm cache rather than `npm install`, so deployment is reproduced from `package-lock.json`.

Affected workflows:

- `.github/workflows/ci.yml`
- `.github/workflows/deploy-pages.yml`
- `.github/workflows/v13-production-smoke.yml`

## Validation

Final candidate validation:

- dependency audit: **0 vulnerabilities**
- **68 test files** passed
- **280 tests** passed
- release-hardening contract: **4/4** tests passed
- TypeScript build: passed
- Vite production build: passed
- main initial chunk: **486.12 kB / 149.20 kB gzip**
- Vite `>500 kB` chunk warning: **eliminated**
- Node 20 GitHub Action runtime warning: **eliminated**

## Versioning note

The npm package is private and its package metadata is not currently the PJSDAS product-release mechanism. Product milestones have historically been tracked through architecture/version contracts and repository history, while the authenticated gateway has its own independently versioned production contract.

Accordingly, this hardening pass does not rewrite package-lock metadata merely to mirror the product label. The release baseline is the merged v1.8 repository state and this documented build contract.

## Future performance work

No further code splitting is justified solely to make the initial bundle smaller. Additional deferral should require observed startup/runtime evidence that a currently eager module does not belong in the 30-second daily decision path.

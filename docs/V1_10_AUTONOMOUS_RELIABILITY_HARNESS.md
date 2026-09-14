# PJSDAS v1.10 — Autonomous Reliability Harness

## Goal

PJSDAS should not require the user to act as the primary QA engineer. Product changes should be checked against durable business invariants and realistic job-search scenarios before they reach `main`.

The reliability harness therefore tests **final workspace semantics**, not only individual helper functions.

## First scenario layer

The first v1.10 slice adds a stable golden-state projection over:

- canonical Opportunities and source identity;
- Process Events;
- Actions and completion state;
- ingestion-run conservation (`received = accounted = sum(outcomes)`);
- Workspace Integrity results.

The projection intentionally excludes volatile entity IDs and implementation-only fields. Refactors should not churn golden expectations unless durable/user-visible behavior changes.

Initial scenarios cover:

1. cross-source convergence: Monitor discovery + tracking-only URL variant + Gmail invitation/completion must converge to one logical job and one logical recruiting event;
2. same company / same role / different explicit locations remain distinct logical jobs;
3. ambiguous same-company role matching fails closed without mutating the workspace;
4. closed Opportunities with an Action still in `doing` state are reported by Workspace Integrity.

The fourth scenario exposed and fixes a real pre-v1.10 defect: the integrity scanner checked for the nonexistent status `in_progress` instead of the actual PJSDAS `ActionStatus` value `doing`.

## Release identity binding

High-speed automated development also requires the frontend release gate to distinguish an old healthy backend from the backend built from the commit being released.

The v1.10 release identity slice therefore adds:

- backend commit identity in `/api/health`;
- runtime provider identity when available;
- provider-neutral `PJSDAS_RELEASE_COMMIT_SHA` for standby providers;
- build-time embedding of the checked-out Git commit before TypeScript/Vite compilation;
- exact `health.release.commitSha === GITHUB_SHA` enforcement before GitHub Pages publication;
- Production Self-Test binding to the exact commit that triggered the successful Pages workflow;
- Cloudflare adapter propagation of the same release-identity contract.

The first production attempt intentionally failed closed: Vercel deployed the correct code and advertised `releaseIdentityBinding=true`, but the project did not expose `VERCEL_GIT_COMMIT_SHA` to the runtime, so `/api/health` returned `release.commitSha=null` and Pages refused to publish. The follow-up hardening embeds the checkout SHA at build time so release correctness no longer depends on a provider-dashboard environment toggle.

A backend with the right version string and capabilities but the wrong or missing commit must fail closed and cannot unlock a newer frontend.

## Adversarial ingestion matrix

The next reliability slice exercises ordering and retry behavior rather than only one happy path. It covers:

- tracking-only URL variants arriving in opposite source order;
- exact ingestion-run retry idempotency;
- repeated Gmail source records across different runs;
- invitation -> reschedule -> completion lifecycle convergence.

The invariant is that transport/order/retry noise may change audit evidence, but must not duplicate or corrupt canonical Opportunities, Process Events, or Actions.

## Seeded state-machine stress

The harness also runs deterministic pseudo-random scenario sequences. Each seed varies discovery order and transport noise while preserving the causal semantics of a recruiting lifecycle.

The current seeded layer checks 64 reproducible seeds and combines:

- same logical posting arriving through tracking-only URL variants;
- same role at an explicitly different location;
- a distinct same-company role;
- exact completed-run retry after unrelated mutations;
- Monitor noise interleaved with recruiting events;
- repeated Gmail durable source records in later runs;
- invitation -> reschedule -> completion convergence;
- ingestion-run conservation and Workspace Integrity after every complete scenario.

A failure message includes the seed and run identity so an Agent can replay the exact sequence without asking the user to reproduce the defect manually. Seeded stress is deliberately dependency-free and deterministic in CI; it is not probabilistic production telemetry.

## Drive boundary fault injection

The reliability suite now also tests failure semantics at the durable Drive workspace boundary using an optimistic-version fault-injection source rather than requiring a human to reproduce sync races.

The fault layer covers:

- a browser/cloud race after the autonomous writer has read its baseline: the stale writer must receive `WORKSPACE_CONFLICT`, must not overwrite the concurrent user change, and may succeed only after rereading the latest workspace;
- a network failure before commit: retry must create durable state exactly once, with no partial run or Opportunity left behind by the failed attempt;
- acknowledgement loss after a successful commit: retry of the same durable `runId` must detect the already-applied run and perform no second write;
- two autonomous writers that read the same Drive version concurrently: exactly one write may win, the other must fail closed, and a retry from the new baseline must preserve both logical changes instead of producing last-write-wins loss;
- replay after later workspace changes: replay remains dry-run-only and cannot mutate the current snapshot, workspace version, or durable-write count.

These tests exercise the protocol contract shared by trusted ingestion and Drive optimistic concurrency. Transport uncertainty may cause a retryable error, but it must never create silent overwrite, duplicate durable ingestion, or destructive replay.

## Development rule

A bug discovered in production or product use should become a regression scenario whenever it can be reproduced deterministically. The same defect class should not require the user to discover it twice.

Future slices should extend this layer with:

- larger fixture-based workspace histories;
- broader browser-level E2E for authenticated sync, backup/restore, Process Event and recovery journeys;
- production anomaly checks that stay silent when healthy and surface only actionable failures.

This is reliability infrastructure, not a new user-facing review queue. System maintenance must remain background work unless a concrete user decision is required.

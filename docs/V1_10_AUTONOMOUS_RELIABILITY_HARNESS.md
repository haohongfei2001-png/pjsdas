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

## Development rule

A bug discovered in production or product use should become a regression scenario whenever it can be reproduced deterministically. The same defect class should not require the user to discover it twice.

Future slices should extend this layer with:

- larger fixture-based workspace histories;
- broader adversarial ingestion matrices;
- replay / concurrent-write scenarios;
- browser-level E2E for critical user journeys;
- production anomaly checks that stay silent when healthy and surface only actionable failures.

This is reliability infrastructure, not a new user-facing review queue. System maintenance must remain background work unless a concrete user decision is required.

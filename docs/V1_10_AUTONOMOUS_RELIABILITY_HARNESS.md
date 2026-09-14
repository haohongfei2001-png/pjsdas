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
- automatic Vercel identity from `VERCEL_GIT_COMMIT_SHA`;
- provider-neutral `PJSDAS_RELEASE_COMMIT_SHA` for standby providers;
- exact `health.release.commitSha === GITHUB_SHA` enforcement before GitHub Pages publication;
- Production Self-Test binding to the exact commit that triggered the successful Pages workflow;
- Cloudflare adapter propagation of the same release-identity contract.

A backend with the right version string and capabilities but the wrong commit must fail closed and cannot unlock a newer frontend.

## Development rule

A bug discovered in production or product use should become a regression scenario whenever it can be reproduced deterministically. The same defect class should not require the user to discover it twice.

Future slices should extend this layer with:

- larger fixture-based workspace histories;
- adversarial ingestion matrices;
- replay / concurrent-write scenarios;
- browser-level E2E for critical user journeys;
- production anomaly checks that stay silent when healthy and surface only actionable failures.

This is reliability infrastructure, not a new user-facing review queue. System maintenance must remain background work unless a concrete user decision is required.

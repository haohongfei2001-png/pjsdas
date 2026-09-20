# Ultimate Usability v1 — Execution Protocol

## Source of truth

Each execution must begin by reading:

1. GitHub remote `main`;
2. this package `STATUS.md`;
3. `FROZEN_BLUEPRINT.md`;
4. `OWNER_AMENDMENTS.md`;
5. the current `rounds/UU-XX.md`;
6. existing AI-operated production/security architecture;
7. required CI and release gates.

Chat history and ordinary local clones are not canonical.

## One-round execution

One execution handles only the current canonical READY / IN_PROGRESS round.

A round is not complete until:

- its contract is satisfied;
- required tests/checks pass;
- evidence is recorded without sensitive data;
- remote `main` is updated;
- `STATUS.md` is accurate after re-read.

Do not automatically start the next round.

## Safety boundaries

This package does not grant authority to:

- submit job applications;
- withdraw applications externally;
- send recruiting email;
- accept/reject an Offer;
- change long-term preferences without policy-compliant intent;
- enable new source permissions without explicit authorization;
- bypass transaction/CAS/idempotency/provenance controls.

## Data discipline

No public evidence may contain:

- raw recruiting email bodies;
- tokens/secrets;
- private workspace exports;
- personal screenshots with unnecessary PII;
- full source documents.

Use synthetic fixtures, hashes, counts, bounded excerpts, or redacted evidence.

## Release discipline

- Release plan remains disarmed unless the owner explicitly authorizes publication.
- Product/package docs are not release authorization.
- Exact-SHA backend/frontend/CI/browser/self-test gates remain mandatory where applicable.
- A docs-only design round must not use publication or deployment as proof of feature
  implementation.

## Blockers

If a required baseline gate is already red:

- record it precisely;
- do not silently redefine the test away inside an unauthorized design-only round;
- do not start dependent domain implementation;
- create/execute a bounded closure task under explicit authorization.

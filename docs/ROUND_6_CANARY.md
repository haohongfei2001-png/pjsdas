# PJSDAS Round 6 — Owner Canary

Status: **IN PROGRESS — CANONICAL DOMAIN CUTOVER**

Baseline release: `v1.1.0-rc.1` (immutable prerelease)

Canonical production origin: `https://todayaction.com`

## Verified owner-canary state

- Local and Google Drive migration inputs reconciled with identical fingerprint `47995dbb6b02…`;
- the migration recovery bundle was downloaded and validated;
- the owner transactional workspace was created and fingerprint-verified;
- the owner access grant is active;
- transactional authority passed exact-SHA Production Self-Test;
- a same-snapshot real owner commit advanced the transactional revision once;
- retrying the same command returned `ALREADY_APPLIED` and did not duplicate the ledger row;
- owner-only allowlist mode passed exact-SHA CI, Browser E2E, Pages deployment, and Production Self-Test;
- the owner Web session remained authorized under allowlist mode;
- the legacy GitHub Pages origin remains available during controlled migration/recovery.

## Canonical-domain configuration

- Vercel Production is attached to `todayaction.com`;
- `www.todayaction.com` is configured as a permanent redirect to the apex domain;
- DNSPod authoritative records point the apex to Vercel and `www` to the Vercel DNS target;
- Supabase Auth Site URL is `https://todayaction.com`;
- Supabase Auth redirect allowlist contains both the legacy GitHub Pages callback and
  `https://todayaction.com/**`;
- Vercel and GitHub deployment variables declare canonical Web/API origin as
  `https://todayaction.com`;
- canonical URL deployment values were revalidated as strict ASCII after correcting an
  initial full-width punctuation entry before the final redeploy;
- connected authority remains `transactional`;
- audience mode remains `allowlist`;
- public signup and beta grants remain closed.

## Current cutover

1. deploy one new exact SHA with the canonical Web/API origin bound in backend and frontend;
2. require backend health and the frontend release manifest to report the same canonical origin;
3. require CI, Browser E2E, Pages deployment, and Production Self-Test to pass;
4. verify `https://todayaction.com` serves the PJSDAS Web app and owner connected access;
5. keep the old GitHub Pages origin as a bounded legacy/recovery origin until post-cutover confidence is established.

Round 6 is not complete until the canonical-domain exact-SHA chain and owner verification pass.

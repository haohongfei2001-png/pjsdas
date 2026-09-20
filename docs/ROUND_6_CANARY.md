# PJSDAS Round 6 — Owner Canary

Status: **IN PROGRESS — OWNER-ONLY ALLOWLIST CUTOVER**

Baseline release: `v1.1.0-rc.1`

Current state:
- legacy Web origin remains the migration/canary entry point;
- Local and Google Drive snapshots reconciled with identical fingerprint `47995dbb6b02…`;
- migration recovery bundle was downloaded and validated;
- owner transactional workspace was created and fingerprint-verified;
- owner access grant is active;
- legacy browser auto-sync remains frozen;
- transactional authority passed exact-SHA production self-test and owner write/idempotency canary;
- Vercel Production and GitHub Pages build configuration are both set to `transactional`;
- controlled audience is now configured as `allowlist` with the owner grant already present.

Current cutover:
1. deploy one exact commit to backend and Web with `transactional + allowlist`;
2. require backend health and Pages production gate to agree on that exact SHA;
3. require Production Self-Test to pass;
4. verify the owner account retains connected Web access under allowlist mode;
5. keep public signup and beta access closed until later controlled-launch decisions.

Canonical-domain activation is still separate and is not performed by this document.

# PJSDAS Round 6 — Owner Canary

Status: **COMPLETE — OWNER CANARY + OWNER-ONLY CONTROLLED LAUNCH**

Baseline release: `v1.1.0-rc.1` (immutable prerelease)

Canonical production origin: `https://todayaction.com`

## Final owner-canary evidence

- Local and Google Drive migration inputs reconciled with identical fingerprint `47995dbb6b02…`;
- a migration recovery bundle was downloaded and validated before bootstrap;
- the owner transactional workspace was created and fingerprint-verified;
- owner allowlist access is active;
- transactional authority is active for Web/API;
- audience mode is `allowlist`;
- the real owner write canary advanced the workspace from revision 0 to revision 1 once;
- exact retry returned `ALREADY_APPLIED`;
- the command ledger contains exactly one owner-canary command row;
- canonical-domain owner sync pulled the connected workspace into the new origin cache without
  adding a new server revision or ledger row;
- the server workspace remains revision 1 with fingerprint prefix `47995dbb6b02`;
- the connected snapshot is non-empty, including 223 opportunities, 30 processes,
  16 process events, 221 actions, 10 prep records, and 34 application groups.

## Canonical-domain configuration

- canonical Web origin: `https://todayaction.com`;
- canonical API origin: `https://todayaction.com`;
- Vercel Production serves Web and API from the same apex origin;
- `www.todayaction.com` permanently redirects to the apex domain;
- DNSPod authoritative records route the apex to Vercel and `www` to the Vercel DNS target;
- Supabase Auth Site URL is `https://todayaction.com`;
- Supabase Auth redirect allowlist contains both the legacy GitHub Pages callback and
  `https://todayaction.com/**`;
- the legacy GitHub Pages origin remains available as a bounded migration/recovery origin;
- public signup remains closed and no beta grants were added.

## Canonical Web remediations

The controlled launch exposed two production-only browser differences and both are closed:

1. Vercel canonical-origin deployment values were re-opened and character-code verified as
   strict ASCII after an initial full-width punctuation entry.
2. Vercel serves the canonical app from Vite base `/`, while the legacy GitHub Pages build
   keeps `/pjsdas/`.
3. Sensitive first-party reads preserve the strict approved-Origin contract by using POST
   `action=read` requests for workspace, audience status, and automation status. This avoids
   weakening origin checks for scripts/curl while supporting canonical same-origin browsers.

## Production-chain evidence

Functional candidate `main@065d26fe30fe609c10f9b0faf38b2422ac284fc2` passed:

- CI — success;
- Browser E2E — success;
- Deploy PJSDAS to GitHub Pages — success;
- PJSDAS Production Self-Test — success;
- Publish verified PJSDAS release — success with publication disarmed.

The production health contract reported the exact candidate SHA, `transactional` authority,
`allowlist` audience mode, canonical Web/API origin `https://todayaction.com`, authenticated
MCP tool surface v3, and the required transactional tool set.

The closure commit that marks this document COMPLETE must pass the same exact-SHA chain before
Round 6 is considered canonically closed.

## Deferred / intentionally inactive

- unrestricted public signup;
- beta-user grants;
- automatic job applications or withdrawals;
- automatic recruiting email sending;
- automatic Offer acceptance/rejection;
- optional Cloudflare standby infrastructure that has not been fully configured;
- user opt-in background discovery / Gmail automation where authorization is not enabled.

These are not owner-canary blockers.

## Release boundary

Round 6 completes the owner canary and owner-only controlled launch. The immutable
`v1.1.0-rc.1` remains the published release candidate and the publication switch is disarmed.

Creating the final public `v1.1.0` release is a separate explicit owner publication decision.

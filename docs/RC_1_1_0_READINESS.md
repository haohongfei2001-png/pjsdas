# PJSDAS v1.1.0-rc.1 — Round 5 Readiness

Status: **RC PUBLISHED / PLATFORM GATES CONFIGURED / PUBLICATION DISARMED**

Package: **PJSDAS-AI-OPERATED-PRODUCTION-v1 / Round 5**

This document is the go/no-go contract for the first v1.1 release candidate. It distinguishes
code/data readiness from repository/platform publication controls.

## Candidate identity

- product version: `1.1.0-rc.1`
- published Git tag: `v1.1.0-rc.1`
- release channel: `prerelease`
- publication switch: **OFF (post-publication)**
- authenticated MCP runtime: independent compatibility version
- exact deployment identity: Git commit SHA

Production builds additionally bind:

- MCP contract SHA-256;
- source migration-set SHA-256 and ordered migration list;
- snapshot schema/version compatibility;
- frontend artifact SHA-256 digest;
- canonical topology / connected-authority declaration.

The backend health contract and deployed frontend `release-manifest.json` must agree before a
candidate is accepted.

## PASS — code and browser hardening

- dependency/security dependency gate passes;
- full unit/regression/reliability suite passes;
- TypeScript + Vite production build passes;
- Cloudflare standby bundle gate passes;
- ordinary Chromium critical journeys pass;
- RC Chromium matrix passes;
- RC Firefox matrix passes;
- RC WebKit matrix passes;
- RC mobile Chromium responsive/keyboard baseline passes.

The ordinary development workflow remains Chromium-only. Cross-browser expansion is an explicit
RC hardening gate, not a permanent cost added to every normal CI run.

## PASS — transactional database rehearsal

A synthetic auth user/workspace was created inside one production-database transaction and the
entire transaction was rolled back.

Verified in the real production schema:

1. first bootstrap creates/matches revision 0;
2. second bootstrap with different data returns `EXISTS` and does not overwrite;
3. revision-0 command commits as revision 1;
4. exact lost-response retry returns `ALREADY_APPLIED`;
5. stale expected revision returns `CONFLICT` and preserves the committed snapshot;
6. reusing a command id with a different payload hash is rejected;
7. synthetic owner allowlist grant is valid;
8. rollback leaves no synthetic user/workspace/command/grant rows.

Post-rehearsal production counts were verified as zero for connected workspaces, command ledger,
access grants, and the synthetic auth user.

## PASS — origin migration / recovery contract

The browser migration path provides:

- Local/Drive fingerprint comparison;
- fail-closed divergence;
- fail-closed mismatch with an existing transactional workspace;
- recovery bundle download before bootstrap;
- parseable recovery bundle schema;
- selected snapshot validation;
- fingerprint tamper detection;
- server bootstrap followed by fresh read + fingerprint verification;
- no automatic authority switch.

This makes old-origin IndexedDB a migration input while it is still readable, rather than assuming
a new origin can read another origin's IndexedDB.

## PASS — production scheduler

Production scheduler prerequisites exist in Vault:

- HTTPS automation backend origin;
- independent Gmail worker bearer token;
- independent Discovery worker bearer token.

Active cron jobs:

- `pjsdas-gmail-automation-hourly` — hourly at minute 5;
- `pjsdas-discovery-automation-hourly` — hourly at minute 15.

Gmail produced a real successful pg_cron run and pg_net HTTP 200 response with zero enabled users,
confirming the scheduler is not merely present in `cron.job`.

At activation time, Gmail and Discovery opt-in counts were both zero, so scheduler activation did
not authorize or create user job-search data.

## PASS WITH ACCEPTED WARNINGS — Supabase security audit

Round 5 retired obsolete Gmail v1 scheduler RPC grants and removed authenticated-user EXECUTE from
current Gmail v2 worker RPCs.

Remaining SECURITY DEFINER warnings are the currently required anonymous PostgREST worker RPCs.
They are protected by independent high-entropy Vault bearer tokens inside the functions. They are
documented residual warnings, not anonymous business-data access.

Tables `pjsdas_workspaces`, `pjsdas_command_ledger`, and `pjsdas_access_grants` intentionally
have RLS enabled with no end-user policies because they are server-owned.

Supabase also reports leaked-password protection disabled. Current PJSDAS application code exposes
no password sign-in path and the current auth population uses Google OAuth only, so this is not an
RC blocker while password authentication remains unused.

## NOT ACTIVATED DURING ROUND 5 — owner/data cutover

Round 5 does not silently perform owner-canary actions:

- no real connected workspace exists;
- no real command-ledger rows exist;
- no owner/beta access grants exist;
- production workspace authority remains Google Drive;
- audience mode remains legacy;
- the P1 `apply_user_command` tool therefore remains hidden in production;
- exact canonical personal-domain values remain unset.

These were Round 6 canary/cutover actions, not Round 5 hardening shortcuts. Round 6 subsequently migrated and fingerprint-verified the owner workspace, activated transactional authority, created the owner grant, and enabled owner-only allowlist mode.

## PASS — default branch protection

GitHub now reports:

`main.protected = true`

A classic protection rule applies to `main`. Force pushes and branch deletion remain disabled.
The release workflow keeps its authenticated preflight and will still refuse publication if this
platform state regresses.

## PASS — GitHub Immutable Releases

Repository-level **Release immutability** is enabled in GitHub Settings and remained enabled after
page reload.

The repository Actions secret `PJSDAS_RELEASE_ADMIN_TOKEN` is configured. Its backing fine-grained
token is scoped only to the `pjsdas` repository with repository **Administration: Read-only**
plus GitHub-required Metadata read access.

Existing `v1.0.0` / `v1.0.1` releases still report `immutable=false` because they predate this
repository setting. They are historical evidence only.

The final authenticated API preflight intentionally remains inside the armed publication workflow.
Before creating any tag or Release, that workflow must verify the repository immutable-releases
setting is enabled; after creation it must verify both:

- `prerelease=true`;
- `immutable=true`.

## PASS — exact-SHA production-chain evidence

The armed publication commit was:

`main@59d32530b7b649debd70e1a640ea2b69bb1de492`

For that exact SHA, CI, Browser E2E, GitHub Pages deployment, Production Self-Test,
default-branch protection preflight, and Immutable Releases preflight all passed.

GitHub then created `v1.1.0-rc.1` as an immutable prerelease with
`prerelease=true` and `immutable=true`, targeting that exact commit.

Later Round 6 commits advance `main` for canary and controlled-launch work. They do not move or
rewrite the immutable RC tag.

## RESOLVED IN ROUND 6 — canonical domain

Round 6 resolved the production origin to `https://todayaction.com`.

- Vercel Production serves the Web app and API on the same canonical origin;
- `www.todayaction.com` permanently redirects to the apex domain;
- the legacy GitHub Pages origin remains allowed during migration/recovery;
- Supabase Auth Site URL is `https://todayaction.com` and the redirect allowlist retains both
  the legacy GitHub Pages callback and `https://todayaction.com/**`.

## Publication decision

**v1.1.0-rc.1 is PUBLISHED and publication is now DISARMED for subsequent main pushes.**

The immutable prerelease already exists and is bound to
`59d32530b7b649debd70e1a640ea2b69bb1de492`.
`.github/release-plan.json` is returned to `publishOnProductionSuccess=false` so Round 6
canary/domain commits cannot accidentally publish or move another release.

Any future release publication must explicitly re-arm the plan and pass the same fail-closed
branch-protection, immutable-release, exact-SHA, version, tag, and channel checks.

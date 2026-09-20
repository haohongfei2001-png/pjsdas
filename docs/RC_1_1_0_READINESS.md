# PJSDAS v1.1.0-rc.1 — Round 5 Readiness

Status: **IMPLEMENTATION READY / PLATFORM GATES CONFIGURED / PUBLICATION DISARMED**

Package: **PJSDAS-AI-OPERATED-PRODUCTION-v1 / Round 5**

This document is the go/no-go contract for the first v1.1 release candidate. It distinguishes
code/data readiness from repository/platform publication controls.

## Candidate identity

- product version: `1.1.0-rc.1`
- Git tag when armed: `v1.1.0-rc.1`
- release channel: `prerelease`
- publication switch: **OFF**
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

## NOT ACTIVATED — owner/data cutover

Round 5 does not silently perform owner-canary actions:

- no real connected workspace exists;
- no real command-ledger rows exist;
- no owner/beta access grants exist;
- production workspace authority remains Google Drive;
- audience mode remains legacy;
- the P1 `apply_user_command` tool therefore remains hidden in production;
- exact canonical personal-domain values remain unset.

These are Round 6 canary/cutover actions, not Round 5 hardening shortcuts.

## PASS — default branch protection

GitHub now reports:

`main.protected = true`

A classic protection rule applies to `main`. Force pushes and branch deletion remain disabled.
The release workflow keeps its authenticated preflight and will still refuse publication if this
platform state regresses.

## PASS / FINAL WORKFLOW PREFLIGHT PENDING — GitHub Immutable Releases

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

Reference pre-closure candidate:

`main@73943120cc4d32b547f00824b1ed112216dc3e05`

For that exact SHA, GitHub Actions reported:

- CI — success;
- Browser E2E — success;
- Deploy PJSDAS to GitHub Pages — success;
- PJSDAS Production Self-Test — success.

The downstream Publish workflow also completed successfully, but because
`publishOnProductionSuccess=false`, every publication-only step remained safely skipped.
No `v1.1.0-rc.1` tag or GitHub Release exists yet.

This SHA is evidence for the release architecture, not a permanently hard-coded publication target.
Any later closure commit advances `main`; an armed publication must therefore use the final
`main` SHA and pass the same exact-SHA production chain again.

## DEFERRED TO CANARY / CONTROLLED LAUNCH — canonical domain

No trustworthy canonical personal-domain value is present in current repository/deployment metadata.
Round 5 therefore does not invent one.

The release candidate may be built and verified on the current legacy Web/fallback backend topology.
Canonical domain attachment, external OAuth-origin/redirect updates, owner migration, authority
cutover, and allowlist activation are controlled canary/launch operations using the actual chosen
domain values.

## Publication decision

**v1.1.0-rc.1 publication remains DISARMED, but the candidate is now eligible for an explicit arm decision.**

`.github/release-plan.json` remains `publishOnProductionSuccess=false` by design. The previous
repository-level supply-chain blockers have been configured, and the current exact-SHA production
chain is green. Keeping the switch off now represents owner publication intent, not an unresolved
technical blocker.

When the owner explicitly arms publication, the release workflow must still fail closed unless all
of the following remain true:

1. successful exact-SHA production chain;
2. protected default branch;
3. authenticated Immutable Releases preflight returns enabled;
4. matching package/release-plan/tag/channel;
5. created GitHub prerelease reports `prerelease=true` and `immutable=true`.

Round 6 owner-canary migration / authority cutover must not start before that explicit publication
decision and release preflight have completed.

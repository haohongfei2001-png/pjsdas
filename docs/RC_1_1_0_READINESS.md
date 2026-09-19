# PJSDAS v1.1.0-rc.1 — Round 5 Readiness

Status: **IMPLEMENTATION READY / PUBLICATION NO-GO**

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

## BLOCKER — default branch protection

GitHub currently reports:

`main.protected = false`

Repository Rulesets are empty.

RC publication is **NO-GO** until the default branch is protected. The release workflow now performs
an authenticated preflight and refuses publication if the default branch is not protected.

## BLOCKER / UNKNOWN — GitHub Immutable Releases

Existing `v1.0.1` reports `immutable=false`, but that release predates the intended future
immutability policy and does not prove the current repository setting.

The connected GitHub App does not have repository Administration scope, and the public REST endpoint
requires authentication, so the current repository immutable-releases setting cannot be truthfully
verified from this execution context.

RC publication is **NO-GO** until the authenticated release workflow confirms the immutable-releases
setting is enabled. The workflow checks this before creating any tag or Release and verifies the
created Release returns both:

- `prerelease=true`;
- `immutable=true`.

## DEFERRED TO CANARY / CONTROLLED LAUNCH — canonical domain

No trustworthy canonical personal-domain value is present in current repository/deployment metadata.
Round 5 therefore does not invent one.

The release candidate may be built and verified on the current legacy Web/fallback backend topology.
Canonical domain attachment, external OAuth-origin/redirect updates, owner migration, authority
cutover, and allowlist activation are controlled canary/launch operations using the actual chosen
domain values.

## Publication decision

**v1.1.0-rc.1 publication remains DISARMED.**

`.github/release-plan.json` must keep `publishOnProductionSuccess=false` until the two supply-chain
blockers above are independently PASS.

Once those blockers are resolved, publication may be armed without weakening any code/data gate.
The release workflow then requires:

1. successful exact-SHA production chain;
2. protected default branch;
3. Immutable Releases enabled;
4. matching package/release-plan/tag/channel;
5. immutable GitHub prerelease creation.

Round 6 starts only from that verified candidate or from the exact same verified commit after the
platform blockers are resolved.

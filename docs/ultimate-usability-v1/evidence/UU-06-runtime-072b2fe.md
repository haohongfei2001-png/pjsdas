# PJSDAS UU06 deployed increment — runtime 072b2fe

Verified 2026-09-21 around 05:58–06:00 UTC. Runtime main:
`072b2feffdac8b72bc93b1e9701bdc8577b6eea0` (merged PR #102).
This is deployment evidence for the current UU06 increment, **not UU06 closure**.
UU06 remains IN_PROGRESS; live Gmail p95/compensation requirements remain UNMET/UNVERIFIED.

## Exact-main checks

| Check | Run | Result |
|---|---|---|
| CI | [35566395645](https://github.com/haohongfei2001-png/pjsdas/actions/runs/35566395645) | SUCCESS; job 106228955881: 717/717 tests and build |
| Browser E2E | [35566395623](https://github.com/haohongfei2001-png/pjsdas/actions/runs/35566395623) | SUCCESS; job 106228955842: 35/35 |
| Deploy / Pages | [35566395668](https://github.com/haohongfei2001-png/pjsdas/actions/runs/35566395668) | SUCCESS; standby, pages-build and deploy jobs successful |
| Production Self-Test | [35566493535](https://github.com/haohongfei2001-png/pjsdas/actions/runs/35566493535) | SUCCESS; job 106229251461, canonical todayaction.com, ok=true |
| Release workflow | [35566509739](https://github.com/haohongfei2001-png/pjsdas/actions/runs/35566509739) | SUCCESS with version-pinned release creation SKIPPED; publication remains disarmed |

The production self-test checks unauthorized restore/settings/worker/MCP rejection,
release identity, contract/migration digests and frontend manifest. Its optional live
authenticated tool-list check was SKIPPED, explicitly; this is not authenticated
private-workspace or real-mail latency evidence. No private workspace/mail was read.

## Public runtime identity

Fresh direct read of `https://todayaction.com/api/health`: status=ok;
release SHA exactly `072b2feffdac8b72bc93b1e9701bdc8577b6eea0`;
transactional workspace authority; allowlist audience; canonical Web/API both
`https://todayaction.com`; product `1.1.0-rc.1`, prerelease.

`https://todayaction.com/release-manifest.json` reports the same SHA and:

- MCP contract: `sha256:da18e6ce6716e6dc7bc341ae9d08e9777de7c4402fb3d1e2876dbf3159eec2b3`
- Migration set: `sha256:f0c77702f3d8aa3c620496ea1c8c2f0ea79aae6bacf8e9618b620af4accb93c7`
- Canonical frontend artifact: `sha256:96a822fda5ded3ecde7dcaa780f690f61bec1de0b3a2823f9925557332faac90`
- Snapshot compatibility: `pjsdas-local-snapshot`, version 3.

Contract/migration digests independently match the candidate source calculation and
exact-main Production Self-Test expected values. Frontend artifact digest is the
published manifest value, also observed by that self-test; no claim of independently
rehashing every deployed asset is made.

The separate legacy Pages manifest at
`https://haohongfei2001-png.github.io/pjsdas/release-manifest.json` also reports
072b with the same contract/migration identity. Its artifact digest is
`sha256:af01628999f91a73c3e5cb32eba6e5ce7c03ac532d0be2a48ce4abb5610bf4a1`, matching
pages-build job 106228977656. Separate deployment artifacts are kept distinct.

One local read of the fallback `pjsdas-remote-alpha.vercel.app` health endpoint timed
out after 20 seconds. Canonical health and its exact-main deployment/self-test passed;
that isolated connection timeout is recorded, not labeled a confirmed product outage.

## Schema-first facts and boundaries

Manager performed and reported live production migration/readback (executor did not
apply either migration):

1. Consent: production version `20260921053337`, name `gmail_uu06_explicit_consent`;
   default NULL, enabled bindings 0, expanded grants 0, RLS true, consent trigger present;
   `claim v3(NULL)` rejected with SQLSTATE 42501.
2. Execution controls: production version `20260921055432`; execution rows 0,
   enabled bindings 0, expanded grants 0, RLS true; anon/authenticated table SELECT
   false; v1 EXECUTE retained postgres/service_role only, v2 existing ACL unchanged;
   `begin(NULL)` rejected with SQLSTATE 42501.

These production version numbers differ from source migration filenames. The release
migration-set digest identifies source files; it is not a substitute for the manager's
actual schema/ACL readback. The pre-deployment v1 ACL mismatch was fixed and independently
verified in isolated PostgreSQL before the controls migration was applied.

The execution-control flag remains default-off/unactivated; cron cadence was not
changed and no binding or expanded consent was enabled. Public health does not expose
the private environment flag, so this is the manager's controlled-change record rather
than a claim to have read production environment values. Hourly Gmail polling remains
insufficient to certify normal p95 <2 minutes / compensation <=15 minutes. There is no
authorized live Gmail workload for latency certification; the manager separately verified the linked Supabase organization plan as **free**
without retaining billing details. Actual Supabase usage/quota headroom and other
backend usage/cost headroom remain UNKNOWN; the plan label alone does not authorize
or demonstrate capacity for a higher cadence. UU07 and final release publication were not started.

## Next legitimate action

This publication checkpoint records the exact runtime SHA receipts without completing
the UU06 execution. Continue the same execution only within its existing authority:
resolve actual quota/cost headroom and safe activation prerequisites before any cadence
change; gather real timing only from legitimately enabled workload. Keep missing SLO
and any source-capability gates visible. Do not convert deployment success into round
COMPLETE or reuse old observations as fresh evaluation evidence.

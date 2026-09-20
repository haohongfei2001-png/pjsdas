# PJSDAS AI-Operated Production v1

Status: **canonical architecture contract for the v1.1.0 development line**  
Package: **PJSDAS-AI-OPERATED-PRODUCTION-v1**

This document supersedes earlier unconditional AI-write and connected-storage rules in
`docs/AI_BRIDGE_DESIGN.md`. Historical documents remain useful for context, but when
they conflict with this contract, this contract wins.

## Product contract

PJSDAS is an **AI-operated, user-controlled, auditable job-search decision and action
system**.

- AI clients interpret language, search external information when appropriate, execute
  explicitly authorized low-risk commands, ask only necessary clarification, and explain.
- PJSDAS owns identity, authorization, domain invariants, state transitions, conflicts,
  idempotency, audit, and mutation receipts.
- The Web app is the control console and complete manual fallback, not the mandatory
  data-entry path.
- High-impact, destructive, policy, identity-merge, migration, authorization-expansion,
  and external-consequence operations remain governed.

## Mutation levels

- **P1 Explicit Command** — unique target, explicit current user intent, low risk and
  compensatable: commit directly with audit/receipt.
- **P2 Ambiguous Command** — confirm only the missing identity/parameter in the current
  AI interaction, then commit.
- **P3 Governed Mutation** — destructive, bulk, policy, merge, restore, conflict override,
  authorization expansion, or external consequence: explicit approval / ChangeSet.
- **P4 Authorized Automation** — a registered user × client × source × capability grant;
  routine success is autonomous and exceptions escalate.

An OAuth `client_id` identifies a client. It is never, by itself, a trusted-ingestion
authorization.

## Connected state authority

### Local mode

IndexedDB remains the authority. Remote AI durable writes and server automation are not
the durable state owner.

### Connected mode

The authoritative commit state is a server-side transactional workspace:

- versioned validated PJSDAS snapshot;
- monotonic revision;
- command ledger;
- mutation receipt;
- explicit authorization grants.

IndexedDB becomes a local cache/offline working copy. Google Drive becomes user-owned
backup/export/portability storage rather than the concurrent business database.

The first implementation deliberately keeps the validated PJSDAS snapshot as JSONB instead
of prematurely normalizing every domain object into relational tables.

## Activation invariant

Connected authority is **default-off**.

Activation requires all durable writers to switch together:

- Web sync: `VITE_PJSDAS_CONNECTED_AUTHORITY=transactional`
- backend/MCP/automation: `PJSDAS_CONNECTED_AUTHORITY=transactional`

The production database migration and server-only service credential must exist first.

Never activate only one writer. A partial Web/MCP/Gmail/Discovery switch creates dual
authority and is invalid.

## Migration invariant

Normal sync must never create the connected authority implicitly.

Migration requires:

1. validate local and Drive snapshots;
2. compare fingerprints and effective emptiness;
3. if both are non-empty and divergent, stop for explicit reconciliation;
4. create/retain a recovery point;
5. explicitly confirm bootstrap;
6. create server workspace without overwriting any existing connected workspace;
7. verify the resulting fingerprint before enabling connected authority.

## Mutation kernel invariant

Every server commit is revision-checked and command-ledgered.

Required command identity fields include the user/principal, command id, operation,
payload hash, expected revision, provenance, and effective time where applicable.

A retry with the same command id and payload is idempotent. Reusing the command id with a
different payload is rejected.

Automatic undo is a compensating operation, never history deletion. It is allowed only
when the target command supplies compensation metadata and no later revision depends on
that state; otherwise it escalates for confirmation.

## Credential boundary

- Delegated MCP/OAuth sessions cannot receive Google provider access tokens or manage
  first-party Google credentials.
- CORS is not an authorization mechanism.
- Provider refresh tokens remain server-side encrypted bindings.
- Server-owned transactional tables and commit RPCs are not directly writable by normal
  authenticated clients.
- Trusted ingestion is source-scoped and capability-scoped.

## v1.1.0 scope

Target: **PJSDAS v1.1.0 — AI-operated Controlled Production**.

Release path:

`v1.1.0-rc.N → owner canary → public product page + allowlist app → v1.1.0`

Not in scope:

- fully public signup;
- automatic job application submission or withdrawal;
- automatic recruiting email sending;
- automatic Offer acceptance/rejection;
- active-active durable writers;
- a general-purpose in-product chat replacement.

## Development sequence

1. Round 0 — Product / AI / State Contract Freeze — **complete**
2. Round 1 — Secure Mutation Foundation — **complete** — authorization isolation,
   transactional workspace/CAS, command idempotency, receipts, safe undo, migration foundation
3. Round 2 — AI Operations & Autonomous Sources — **complete**
   - bounded P1 Domain Commands with exact target ids and P2 clarification behavior;
   - P1 command tool remains activation-gated to transactional authority;
   - user abandonment is separate from recruiting-process closure;
   - unassessed/provisional/assessed states replace fake neutral-score semantics;
   - Gmail complete-consumption continuation prevents watermark advancement past
     unconsumed pages/ids and records expired-history coverage gaps;
   - Discovery candidates require independent server-side source verification before
     source facts can create/refresh Opportunities; unverified candidates remain unresolved.
4. Round 3 — Web Console Product Redesign — **complete**
   - primary IA is Today / Opportunities / Attention / Activity / Settings;
   - Pipeline and Prepare are contextual views inside Opportunities;
   - Today is action/status-first, with manual capture retained only as fallback;
   - Attention centralizes governed ChangeSets and unresolved source exceptions;
   - Activity is audit-only and contains no Apply/Discard workflow;
   - Settings is a layered low-frequency control surface;
   - unassessed opportunities render as unknown rather than fake neutral scores.
5. Round 4 — Production / Domain / Audience Integration — **complete**
   - canonical Web/API origins and legacy browser origins are centralized deployment inputs;
   - first-party browser APIs share one strict approved-origin policy;
   - controlled-production owner/beta audience grants exist and are server-owned;
   - allowlist mode is default-off, while legacy mode preserves current production behavior;
   - canonical API metadata can remain stable while Vercel / Cloudflare serve as fallback backends;
   - old-origin Local/Drive state can be explicitly inspected, recovery-exported, bootstrapped into
     the transactional workspace, and fingerprint-verified before any domain cutover;
   - Local/Drive divergence or an existing non-matching connected workspace fails closed;
   - deployment gates and post-deploy self-test verify workspace authority, audience mode,
     canonical topology, exact commit identity, and Round 4 capability markers;
   - exact personal-domain values, DNS records, hosting custom-domain attachment, and external
     OAuth redirect/origin configuration remain deployment inputs and were not guessed in source.
6. Round 5 — Release Candidate Hardening & Verification — **complete**
   - product/package/release-plan identity is staged as `v1.1.0-rc.1`, prerelease channel,
     with publication explicitly disarmed;
   - backend health binds product version, commit SHA, MCP contract hash, migration-set hash,
     and snapshot compatibility;
   - frontend builds emit a SHA-256 artifact manifest and post-deploy self-test reconciles
     frontend/backend candidate identity;
   - GitHub release workflow understands prerelease publication and refuses to publish unless
     the default branch is protected and GitHub Immutable Releases can be verified enabled;
   - RC browser hardening passes Chromium, Firefox, WebKit, and mobile Chromium;
   - real production Supabase rehearsal passes bootstrap/non-overwrite/CAS/idempotency/conflict/
     command-id mismatch/allowlist checks inside a rolled-back synthetic transaction;
   - origin migration recovery bundles round-trip and reject fingerprint tampering;
   - production Gmail/Discovery pg_cron jobs are active and Vault-backed; Gmail has produced a
     real HTTP 200 empty run while no users are opted in;
   - repository supply-chain prerequisites are now configured: `main.protected=true`,
     Release immutability is enabled, and the read-only release-admin Actions secret exists;
   - current exact-SHA production candidate `main@73943120cc4d32b547f00824b1ed112216dc3e05`
     passed CI, Browser E2E, GitHub Pages deployment, and Production Self-Test;
   - publication remains intentionally **DISARMED** until the owner explicitly arms
     `v1.1.0-rc.1`; the armed workflow must still re-verify branch protection and Immutable
     Releases before creating the prerelease.
7. Round 6 — Personal Canary → Controlled Launch

Do not activate the new P1 direct-write surface until connected authority is transactional.
Round 3 is complete. Future Web work must preserve the same Domain Command/state contracts
instead of creating a second mutation model. Round 4 is complete at the source/schema/topology layer. Exact domain attachment remains an
external deployment input because no trustworthy canonical personal-domain value was discoverable
from the repository or current deployment metadata. Round 5 is complete as a hardening/verification round. Its current result is
**IMPLEMENTATION READY / PLATFORM GATES CONFIGURED / PUBLICATION DISARMED**.
Round 6 must not start owner-canary migration/authority cutover before the explicit RC publication
decision and its authenticated release preflight complete. The current gate/evidence matrix is in
`docs/RC_1_1_0_READINESS.md`.

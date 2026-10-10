# B2 complete-scope execution checkpoint

This implementation follows the approved consumer convergence plan. It does not enable a search provider, approve a budget, configure a real profile, deploy a migration, or change the canonical product scope.

## Query coverage and limits

- Build the complete confirmed role/location query set. Every target has unrestricted public-web, employer-site, university-publisher, and recruiting-platform supplement queries. Platform domains supplement the unrestricted search; they do not delimit the whole web.
- The existing profile contract permits up to 30 role terms and 30 locations. Prefer-location mode includes an unrestricted location target, giving at most 3,720 queries. No term, location or target is silently truncated.
- Partition this set over the existing enabled source identities. Execute at most 48 queries per scheduler tick, at most one bounded batch per source. Source cadence and the separate approved monetary budget remain in force. Unsupported batch metadata fails closed before external retrieval.
- `remainingQueryCount` counts planned queries without successful provider evidence. Omitted hits, unresolved source facts, failed interpretation and failed queries keep coverage partial even after later batches finish. `scopeComplete` cannot become true merely because this tick's last batch succeeded.
- This is bounded search-engine coverage. It does not claim access to every indexed job, authenticated platform content, blocked pages or unindexed sources.

## Durable progress and uncertain outcomes

Progress lives in the existing account-scoped command ledger, not editable timeline timestamps. The plan fingerprint binds the confirmed scope, complete query set, enabled source identities/cadences, provider ID, maximum price/result bounds, model/token/attempt limits, budget policy version and per-tick query limit.

Before any reservation or provider call, the worker commits a `checkpoint_discovery_search` claim through the existing workspace CAS and authority guard. Its stable command ID identifies the cycle/batch; a fresh attempt nonce is part of its exact payload hash. Only a confirmed first commit with the matching original receipt admits execution. A concurrent loser cannot borrow the winner's receipt or write a new nonce into it.

A crash after claim but before an outbound request is also uncertain. No timeout reclaims the batch, no restart repeats it, and no automatic budget release is inferred. The same holds for a lost response after a request or a facts commit whose acknowledgement cannot be reconciled. The result exposes an explicit uncertain-batch error and the uncovered scope. The budget adapter must retain any original reservation until separately reconciled.

Generic provider exceptions, HTTP 5xx/gateway timeouts, invalid response bodies and lost reservation/model responses are uncertain. Only a server-owned adapter's definite rejection can become a known search failure. The raw search adapter currently recognizes authentication and rate-limit rejection; a 5xx never establishes that the upstream provider did no work. Model authorization, confirmed scope and reservation expiry are checked again after awaiting its reservation and immediately before generation. A revocation after an already-sent external request cannot retroactively cancel that request; the later authoritative commit still rechecks and locks authority.

Verified facts settle the batch in the same authoritative domain/CAS transaction. A failed batch with known execution accounting can instead record a metadata-only settlement. Query failure never becomes an empty-success receipt. A budget-exhausted settlement stops further work and remains blocked under that budget-policy fingerprint. Changing an approved budget policy is an explicit server configuration change, not an automatic increase.

The worker inspects every source's authoritative progress before admitting any new claim or reservation. A later source's exhausted policy therefore also blocks restarting an earlier completed source across cadence boundaries. Previously completed coverage remains visible during this pause.

An unfinished cycle resumes across cadence boundaries at its next unclaimed batch. Completed immutable batches are not repeated. Scope/source/provider/pricing-policy changes create a different plan and cannot borrow old coverage. Revocation or scope changes stop subsequent reservations and writes; original progress and receipts remain historical.

## Authority and SQL delta

The candidate B2 migration still adds no role, capability, table ACL, RLS policy, persistent credential or public RPC grant. The existing service-only `pjsdas_commit_discovery_workspace_v1` signature remains unchanged. Its operation validation additionally accepts internal `checkpoint_discovery_search` requests only for the existing automation consent generation, with no delegated client and no compensation.

Checkpoint writes must preserve the exact current authoritative snapshot and schema. They acquire the existing consent-row and workspace locks, then use the existing v2 CAS/ledger commit. Settlements must join the original source/scope/plan/cycle/batch claim and attempt nonce. A different claim ID, skipped predecessor, forged settlement, second settlement or revoked authority is rejected. Delegated MCP ingestion cannot write search progress metadata. No fallback to a legacy unguarded write route is permitted.

Metadata checkpoints use a validated raw authoritative preimage. They must not run snapshot normalization, including removal of an old Action due date or timing mode. The SQL equality guard remains intact; the gateway-plus-PGlite regression preserves a nonempty legacy v4 snapshot, all historical values and its stored schema.

The metadata operation advances a workspace revision and adds an audit receipt. It creates no Opportunity, Action, Schedule node or personal recruiting fact. Actual discoveries continue through the existing verified Domain Command boundary.

## Verification boundary

All new provider and scheduler tests use intercepted synthetic HTTP, synthetic credentials, in-memory command stores and synthetic data. PGlite validates SQL state, ACL/RLS invariance, nonce ownership, replay, cursor and authorization failures. It does not establish real transaction-lock behavior.

The original PostgreSQL 17 four-session gate additionally covers claim-write before revoke, revoke before claim-write, and competing claim nonces with exact workspace-lock witnesses. Those hosted cases and the original browser gates must actually pass on the final head before release. No local test or historical checkpoint replaces them. Production activation still requires the real provider/budget/configuration and deployment-cost boundaries to be resolved.

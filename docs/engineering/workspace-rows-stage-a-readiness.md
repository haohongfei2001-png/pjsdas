# Row storage: local readiness and production stop gates

**Status: NOT DEPLOYABLE.** This is a default-off code/SQL candidate, not a
production migration. No model/search/provider call or real business write is
required by the synthetic fixtures.

## Local contract matrix

| Path | Current synthetic evidence |
| --- | --- |
| Workspace/source/identity/profile, existing bootstrap, readiness | Actual central constructors and public-only PostgREST; same snapshot wire shape, no stale-blob fallback |
| First-party domain / Undo, nonempty Gmail | Actual existing domain core, full cross-entity output, compensation and audit preserved |
| Management v2/v3/v4/v5/v6/v7 | Original grant readers, dedicated guards, exact Undo, replay/regrant/revoke races |
| AI capture | Original admission/confirmation/consumption; no provider call |
| Discovery | Real verifier/domain, claim/cap/race/settlement and retained-history coverage; no external search |
| Gmail orchestration | Real claim/lease/assert/commit/finish; lost commit response and failed finish preserve cursor and recover without duplicate commit |
| Legacy v1–v4 / bootstrap / capture / guarded / 305 / raw writes | Active-generation refusal, including races with cutover; ordinary-user ACL/RLS and old function owner/ACL preserved |
| Reads and audit | Lossless ordered keyset/byte pages with epoch + revision fences; explicit overflow, no silent truncation |
| Migration | Local persistent transaction, exact readback before activation, six real connection-loss boundaries, lost-COMMIT-ack recovery, stale revision and ineligible audit refusal |
| Two code versions | Frozen serial A and bounded-concurrency B use identical SQL/data/writer contracts; real B write → A read/write → B read, original receipt replay and stale CAS refusal |

The two-checkout test imports the **actual frozen A source**, rather than a
second instance of B. Its explicit local checkout input is verified against the
frozen commit and a clean tracked tree. This is not evidence that either version
has a production deployment or that a hosted rollback has been rehearsed.

B permits one to four in-flight bounded page requests; the default remains one.
`PJSDAS_WORKSPACE_ROWS_READ_CONCURRENCY` only affects reads when the existing row
read capability is enabled. Segment order and complete entity counts are checked,
all requests retain the caller deadline, and a failure cancels/drains in-flight
work before returning no snapshot. A safely ignores this optional setting.
No writer permission, epoch, schema or receipt interpretation changes between A
and B. Both require row reads to remain enabled for activated owners.

## Exact limits that are not approved product quotas

The candidate uses a 2 MiB delta request, at most 2,000 changed rows, a 1 MiB
header/entity page, 65,024 entities and a 32 MiB reconstructed row budget. History
uses 2 MiB pages and a 32 MiB per-read budget. Unsupported writes fail **before
any persistent change**; SQL independently rolls back unreadable new state or
audit. Unsupported migration input remains on the old layout.

These constraints do not prove parity for every previously valid large import,
bulk command or future-growing history. After activation, silently falling back
to the old full-snapshot writer is forbidden. Before production, either prove all
required product operations fit without imposing a new user-facing restriction,
or design and verify a lossless staged large-command protocol (with its own
explicit safety/authority review). Do not quietly convert experimental safety
limits into product quotas or prune history to make tests pass.

## Production prerequisites and staged operations

1. **Capacity and operation compatibility.** Measure actual eligible metadata and
   required read/write sizes only with approved access. Include original blob,
   the second retained head copy, entities/indexes/TOAST, immutable ledger growth,
   temporary migration copies and WAL. The local compressible fixture shows that
   row storage can be much larger. Lower WAL does not prove lower latency or
   adequate production disk/IO headroom. No paid capacity is assumed.
2. **Exact static migration and transport.** Replace the local catalog-patching
   fixture with reviewed static definitions and a catalog/ACL/owner/RLS preimage.
   The current local `pg.Client` transaction does not prove that separate cloud
   SQL-tool calls share a transaction. Choose and test a supported atomic admin
   transport before production. The candidate adds two private schemas, three
   row tables, one legacy epoch column and its write trigger, 15 public service-
   only invoker wrappers, and private helpers; legacy definitions retain their
   existing authority. This complete change set requires separate approval.
3. **Two hosted row-compatible builds, before any owner activation.** Verify A
   and B with the same additive SQL contract. Enabling reads and writers while
   all owner markers remain null still routes those owners through the old
   path; deploy and verify every normal web/MCP/automation caller before cutover.
   Both versions must remain available with row reads enabled.
4. **Retire every unmodified backend, not just its canonical alias.** An old
   deployment URL with valid identity can still perform a raw service-role
   `SELECT` and return the retained stale blob. An update/delete trigger cannot
   fence that read, and Origin validation is not a target-deployment-host check.
   Require evidence that all such old entry points and in-flight workers are
   inaccessible/retired. Alias promotion plus an arbitrary delay is insufficient.
   If the platform cannot provide this, stop: a database read fence and related
   ACL/read-entry redesign needs separate review and authorization.
5. **Per-owner atomic migration.** Lock the legacy owner, check schema/revision
   and canonical eligibility, preserve 305 pending logical audit, copy and fully
   verify exact rows/history, then activate the marker in that same transaction.
   Nothing is deleted. An interrupted pre-commit migration leaves the owner on
   legacy; a committed but unacknowledged migration is discovered, not repeated.
6. **Observe only natural authorized activity after activation.** Verify current
   row reads/writes and original cursor/receipt recovery; do not manufacture real
   Gmail messages, job records or paid provider executions for acceptance.
7. **Rollback keeps rows.** Stop admission of further migrations and route to
   verified A with row reads/writes still enabled. Do not clear the marker,
   disable reads, deploy pre-row code or overwrite with an old blob. A separate
   full-materialization rollback reintroduces the full-blob cost and is not
   claimed usable here. Change-level recovery is not a full disaster-recovery
   backup/restore proof.

Until these prerequisites are evidenced, neither local green tests nor a Draft
PR authorize merge, production DDL, new permissions or cutover.

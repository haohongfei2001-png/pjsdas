# Complete audit byte reader — local, default off

This is an isolated candidate, **not a production migration, rollout, capacity
claim, or authorization to publish**. `PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES=1` is a
server-only opt-in, requires compatible row reads, and is never derived from a
browser/tool body. The SQL lives only under `tests/sql/candidates/`.

## Closed conditional case

The original 2,050-action **long-ID** v3 archive fixture has complete V5 receipt
and compensation SQL bytes of at least 2,105,291. The flag-off finalizer still
atomically rejects it. With the complete reader installed and negotiated, the
actual scoped factory can commit it; fresh-process original replay, first-party
receipt lookup, history, and the original protected Undo read the entire logical
audit. No V5 field, projection delta, unknown field, or compensation is omitted.

The logical document is the original `discovery_history` projection, including
retained-ledger records and its ambiguous split-store guard. It is not an
alternate candidate-ledger projection.

## Protocol and authority

* `read_history` must acknowledge `workspace-audit-bytes-v1`, including for an
  empty lookup. Old readers cannot silently ignore the negotiation.
* The verified first-party API constructs its own owner proof after identity
  verification and delegated-client rejection. The original opportunity tools
  construct a v3 proof after their current grant admission. No other command
  family gets a new byte-reader authorization adapter.
* Each fragment and final fence rechecks the same original owner/grant revision,
  client, capability, consent version and revocation state. A scoped reader
  cannot use this route to obtain another large command family.
* References bind workspace, owner, epoch, current revision, original command,
  resulting revision, exact byte count and SHA-256. SQL verifies all of these
  before releasing bytes. SQL uses the existing grant-before-head lock order.
* The original finalizer retains its previous eligibility refusal unless the
  exact reader protocol was negotiated. In the same transaction, eligibility
  checks required SQL/EXECUTE capabilities and exercises the actual public
  history/first-fragment path on the newly inserted audit. Failure rolls back
  the immutable record and business mutation together.

## Bounds, spool, and deadlines

Fragments remain at most 65,536 decoded bytes. The old 2,097,152-byte page/body
ceiling is not raised; negotiated history reserves its actual response envelope
and promotes a near-limit individual row to a reference when necessary. HTTP
bytes, including error bodies, are bounded before parsing. Complete history
materialization retains its existing 33,554,432-byte capability check; descriptor
and inline bytes count against it. This is not a new product quota.

Every large document goes to a private request-local provisional file (0600 in
a private temporary directory), with contiguous framing, canonical base64,
identity/size checks and an incremental complete digest. No partial bytes are
returned. All documents are read and sealed before the final authority/generation
fence; parsed provisional objects undergo another final fence before return.
Success, conflict, cancellation, malformed data and disconnected transport remove
owned spools. Cleanup failures are not represented as successful reads.

An existing staged signal is reused verbatim: the original absolute ten-second
commit deadline is never reset by an Undo history read, fragment or fence. A
standalone negotiated history operation has one ten-second read budget across
its pages/fragments/fences. Flag-off retains the original request deadlines.
These are explicit boundaries, **not a claim that every entire API invocation,
with its preceding reads/reducers, or remote deployment fits ten seconds**.

Within one request-owned adapter, only the last fully verified audit may be
reused. The entire descriptor must match and the object is cloned on admission
and return. Every hit still gets current SQL authorization, a freshly negotiated
descriptor and final generation fences. This removes duplicate lookup/Undo byte
downloads without caching authority or reusing evidence across generations.

## Evidence and remaining gates

`tests/workspaceRowsAuditBytes.test.ts` checks framing/integrity, unknown UTF-8
fields, cache isolation, deadlines/cancellation, negotiation, HTTP bounds and
cleanup. `TA_ROW_AUDIT_PROOF=1` extends the real native PostgreSQL/public-only
PostgREST/API/scoped-factory harness with the retained exact long-ID fixture,
cold replay/Undo, retained and mixed history, concurrency/final-fence races,
revocation, lock order, missing-reader rollback and temporary-file inventory.
The original flag-off, durable-intent, native and unit matrices remain separate.

Still open: giant individual entity/header documents; complete-history totals
beyond the existing materialization capability; unrelated command families;
incompressible atomic durable intents; cumulative staging/spool admission,
retention and crash reclamation; collection/deep-history skew, scalar quadratic
work and remote RTT; and an approved atomic migration/ACL channel plus genuinely
compatible hosted rollback releases. The old A-prime reader is **not** a rollback
release for oversized audits. No production configuration, SQL, ACL, provider,
credential, resource, budget, push, PR, CI, merge or deployment is changed here.

## Preserved v3 guard semantics under the baseline timeout fix

The original flag-off 1,800-action Undo also reproduced a PostgreSQL statement
timeout in its per-change `jsonb_array_elements(expected_rows)` lookup. The local
fast and staged guards now build scalar ID/ordinal sidecars **after** the original
identity checks. Reconstruction still uses the original JSONB mutations and exact
numeric path expression; final JSONB comparisons and all later validation remain.
The same collection loop reuses scalar IDs for archive selection, retained-row
membership and old/new evidence lookup, avoiding adjacent repeated JSONB expansion.
This does not make scalar lookup or JSONB reconstruction linear.

`tests/sql/workspace-rows-opportunity-guard-equivalence.mjs` compares the complete
fixed original inner guard and optimized guard, plus the exact reconstruction loop,
on 356 deterministic real-PostgreSQL cases. It checks results and exact SQLSTATE /
message, including duplicate IDs, retained/inserted/deleted ordinals, unknown fields,
missing and SQL/JSON NULL values, malformed evidence, equal-index order, integral
numeric scale and huge indices. The fast/staged full-body equivalence remains a
separate unchanged unit assertion. Original failed candidate logs are retained;
passing these cases is not a general timing or capacity guarantee.

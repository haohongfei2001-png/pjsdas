# Optional bounded audit pages — local candidate only

Default **off**, unpublished, synthetic loopback proof only. This extends the complete reader in `WORKSPACE_AUDIT_BYTES_LOCAL.md`; it is not a production migration or activation authorization.

## Why this exists

The original retained 2,050-action long-ID v3 fixture has a complete 2,106,241-byte logical V5 audit. Its 33 original 65,536-byte fragments previously required 33 independent requests, each rebuilding, serializing and hashing the full logical document. A cold protected Undo did not become a single proven end-to-end 10s operation merely because its staged commit had that budget.

The optional `PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES=1` flag requires the original `PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES=1` and compatible row reads. History negotiates an additional exact `workspace-audit-page-v1` ACK. Missing/wrong ACK or a failed page request fails closed; there is no runtime fallback after a failure.

## Unchanged bounds and semantics

A page contains one exact original descriptor and 1–16 independently checked original fragments. Each decoded fragment is still 65,536 bytes except the final remainder. The existing 2,097,152-byte response-body cap and 33,554,432-byte complete-history materialization capability are unchanged. The pure internal packer accounts for real UTF-8 JSON envelope bytes, dynamically fits fewer fragments, rejects a zero-fit page, and asserts the final bound. It reads no database state and stores nothing.

The actual endpoint first checks original owner or current consent-v3 opportunity authority, active layout, owner/head generation, and the **whole owner's** split-history collision invariant. It retrieves the original complete document, serializes/hashes it once, verifies the exact descriptor, then packs the bounded page. Original V5 receipt/projectionDelta/compensation and unknown fields are not truncated, rewritten, compressed or downgraded.

For the retained fixture, this means **three page authorization transactions, not 33 per-fragment reauthorizations**. A delegated grant's original `FOR SHARE` lock covers that page transaction. A revoked grant or changed revision/epoch is checked again on the next page and at both original final authority/generation fences. No provisional data is returned to the application before those fences.

The client validates every page's shared descriptor and full fragment offset/count sequence, then feeds each fragment into the unchanged contiguous-offset/canonical-base64/exact-length/full-SHA spool verifier. Extra trailing fragments cannot be silently ignored. Bounded page memory is request-owned; private disk spools remain provisional and are deleted in `finally`. This does **not** solve process-crash cleanup, aggregate admission or fairness.

The original fragment endpoint remains byte-for-byte unchanged. Selected page metadata is added only after the original small-command fastpath classification and is bound into the original staged/durable manifest. Atomic finalization still probes the original fragment reader and additionally executes the actual selected public history/page path, checking ACK, complete descriptor, wire cap, offsets and all returned fragment bytes. A broken selected reader rolls back unreadable publication.

A pending durable intent cannot silently change page mode: a changed flag produces a different manifest and is refused. Original-mode recovery remains bounded by its original absolute deadline. This does not establish a compatible hosted rollback pair.

## Evidence and limits

The native fixture covers original scoped archive, cold replay, actual API receipt/history, original protected Undo, real disconnect/caller abort, byte/identity/offset/tail corruption, CAS/epoch change, real grant-lock/revocation races, missing/wrong installed reader, and original-mode versus changed-mode durable recovery. Additional cases retain a legal high-entropy/unknown-field 2,050-action variant, a 3MiB mostly incompressible retained field, deep multi-page history, same command IDs under different owners, and non-target same-owner split-history collisions.

The larger high-entropy write fixture first hit the **unchanged original 1MiB core archive-evidence bound**. The legal variant remains within that bound; the retained high-entropy read is not evidence of universal writable durable-intent capacity. A synthetic 1,080,016-byte indexed command ID also hit the existing PostgreSQL index tuple boundary. Pure packer tests of otherwise unstoreable giant descriptors prove envelope arithmetic only, not endpoint eligibility.

All original failed/timed-out logs remain in the private evidence ledger. In particular, an original `read_history -> audit_reference -> audit_descriptor` call reached the unchanged 10s SQL statement timeout before a page corruption hook. Subsequent bounded descriptor diagnostics crossed pooled HTTP and auto/custom/generic SQL plan reuse thresholds without reproducing the timeout; that is **not a root-cause fix or capacity proof**. No timeout, cap, authority, final fence or complete V5 requirement was weakened to pass.

Page aggregation reduces measured full-document/request amplification; whole-Undo samples still vary, including values over 10s. The fixed frozen comparison uses the same implementation/fixture and four serial off/on/off/on runs, with disposable-database statistics controlled and captured. Micro SQL timings, whole operations, wire bytes, PG CPU, proxy/harness CPU, cold-worker CPU and temporary disk are separate metrics. No real cross-region or production-load feasibility is claimed.

SQL statistics can lag; see [PostgreSQL 17 statistics](https://www.postgresql.org/docs/17/monitoring-stats.html). Instrumented nested plans use the already-installed [auto_explain](https://www.postgresql.org/docs/17/auto-explain.html), with per-node timing disabled; these diagnostics are separate from uninstrumented frozen performance samples.

## Remaining activation gates

No production SQL/ACL/configuration, credentials, provider, budget or resource changes; no push, PR, CI, merge or deploy. Activation still requires separately authorized atomic SQL/ACL transport, selected-reader compatibility, hosted rollback verification, capacity/admission/fairness and crash-reclamation policy. Full-document rebuilding still occurs once per page; deep-history checks, other scalar quadratic work and whole-Undo/remote latency remain open.

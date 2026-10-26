# Complete staged request documents: local byte protocol

**Default-off local source candidate, not rollout eligibility.** The real server
runtime selects `workspaceRowsStagedBridge.ts` only when the server-owned
`PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS=1` and both existing row modes are enabled.
No browser input selects an adapter. The byte codec itself does not authorize a
command; SQL retains the original family guards. Its memory-backed receiver is
an executable protocol specification, not a production spool. No production
configuration or database has been changed.

## Actual capability counterexamples

1. The real first-party handler/core generates a contract-V5 receipt for a legal
   abandon with 2,100 actions / 2,102 effects. A separate native full-v4 HTTP
   experiment committed the original command. Its complete staged metadata was
   **1,078,538 compact JSON bytes / 1,167,025 SQL JSONB-text bytes**; the old
   prototype's 1 MiB `large_begin` refused it. The earlier direct-RPC V2 fixture
   is not proof of V5 application parity. Do not fix this by dropping
   `projectionDelta`, affected objects/fields, conflict/Undo dependencies,
   invalidation, lifecycle, result, or compensation.
2. A real Planning core `patch_time_preferences` with three legal retained
   configuration objects of 262,100 bytes each produces **one** timeline effect.
   Each configuration remains below its original 256 KiB bound, and the after
   envelope fits the existing reader candidate. Delta plus compensation alone
   is **2,098,867 bytes**, already above the unchanged 2 MiB fast path, before
   authority and receipt metadata. Original Undo restores the complete fields
   and preserves history. Effect count alone cannot classify this as safe.

3. The original scoped runtime's 2,050-action archive creates a complete V5
   receipt/compensation whose SQL audit representation is at least **2,105,291
   bytes**, exceeding the existing 2 MiB audit-read eligibility check. Finalize
   correctly rolls back. The separate 1,800-action V5 case has 1,803 effects and
   a complete request of approximately **2,452,573 compact bytes**: staging passes
   this real byte-large archive; its original Undo safely uses the unchanged fast
   path. A separate legal compact-ID 2,050-action fixture retains every V5 field
   and stages **both** archive (2,053 effects) and Undo (2,052 effects). Neither
   fixture replaces or hides the larger audit-read counterexample.

These are synthetic legal payloads, not production measurements or new quotas.
The real first-party operation is `domain:abandon_opportunity`; it is retained
verbatim. The historical direct-RPC alias is also supported, not substituted.

## Protocol

`workspace-staged-documents-v1` separates only the already separate `changes`
effect chain. Every other request field is retained in one of four documents:

| Document | Exact original JSON-wire value |
| --- | --- |
| `metadata` | All residual request keys, including manifests, command identity, provenance, complete V5 receiptContext and unknown forward-compatible keys |
| `beforeEnvelope` | Complete original before header; no projection or field whitelist |
| `afterEnvelope` | Complete original after header |
| `compensation` | Complete original compensation, including explicit null |

Each document has its UTF-8 byte count and SHA-256. The manifest binds ordered
document descriptors, stage/owner/workspace/epoch/revision, original command and
payload hash, operation/principal/family, original external authority arguments,
and the separate ordered effect-chain count/hash/version. Authority arguments
are immutable **identities**, not evidence that a grant or lease is still valid.

`manifestWire` is the exact unsigned JSON text; its SHA-256 is supplied separately.
SQL must hash that UTF-8 text, never reserialize JSONB and assume identical bytes.
Fragments carry stage ID, manifest hash, document name, **byte** offset and
canonical base64, up to 65,536 decoded bytes. A UTF-8 scalar may cross fragments;
decode only the verified complete byte document, with invalid UTF-8 rejected.

The receiver rejects cross-stage/context/effect-chain substitution, missing or
reordered directory entries, gaps, overlaps, altered duplicates, noncanonical
base64, wrong sizes and final hashes. Exact repeats are idempotent. No partial
document is returned for final authorization. The caller's original abort signal
is checked during append and before release, including cancellation after the
last byte. A completed byte stream is not a command receipt.

The immutable synthetic native V5 package round-trips through **19 fragments**,
largest fragment JSON 87,568 bytes, retaining the original persisted receipt
context and compensation exactly. A lightweight test independently invokes the
real connected handler/executor/core with a synthetic transport and confirms the
same V5 shape. The handler intentionally moves `projectionDelta` to HTTP `delta`;
that compact HTTP receipt is **not** the persisted receipt to upload.

## Implemented bounded transaction integration

1. Keep the verified handler principal, original domain core, evidence, grant /
   lease / durable preview admission, command ID, payload hash and budget owner.
2. Classify a complete validated request, not a caught generic `INVALID`. Keep
   existing fast-path limits. Only separately proven families may select staging;
   other families remain explicit capability failures, not generic-authority RPCs.
3. Require a pre-authorized durable reservation before accepting fragments. The
   runtime cannot mint reservations; only the synthetic fixture provisions them. Upload only
   provisional bytes/effects; no business revision, receipt, preview consumption,
   cursor settlement or funding mutation. Do not restart the total deadline per
   page. No parallel writer lock order or implicit external retry is introduced.
4. Finalization takes the original family locks before the stage lock (v3 grant
   SHARE → head UPDATE → stage UPDATE; first-party head → stage). After waits,
   check wall-clock expiry and current v3 grant identity. Lease/preview families
   are not enabled by this slice. Verify all
   documents/effects and invoke the complete original semantic/Undo guard.
5. One database transaction applies all effects, changes the header once, stores
   the **complete original** V5 receipt/compensation and consumes original
   authority state atomically. Never call multiple small business commits.
6. An interrupted upload changes no business state and may resume only the same
   immutable identity and exact bytes. Begin/status must not release a cached
   command receipt. Completion/replay rechecks original authority, even if the
   stage has a result. Regrant/replacement lease cannot silently revive a stage.
7. A timeout/disconnect after finalize dispatch is an **unknown outcome**, not a
   proof of rollback. Resolve via original authorized command lookup/replay and
   immutable receipt; never allocate a new command, rerun a model/job, or grant a
   new timeout/budget. Cancellation cannot undo an already committed transaction.

## Native application evidence

The isolated PostgreSQL/public-only PostgREST harness invokes the actual
`api/workspace.ts` entry and normal runtime factory, without an injected row
adapter. A strict synthetic network trampoline sends only the configured
Supabase origin to loopback; no provider or production request is made. It proves
complete V5 abandon/Undo/replay, default-off and missing-reservation refusal,
inactive full-v4 behind the narrowed read ACL, original caller cancellation,
partial upload without business writes, lost final response resolved by original
command replay, fragment and persisted effect/wire/hash-chain integrity checks,
original first-party client/receipt-authority refusal, disconnect-before-COMMIT rollback
and two observed waiting finalizers producing one receipt. The original scoped
runtime factory uses its real grant reader for V5 archive/Undo and revoked replay;
this is not a live OAuth/MCP authentication test.

The SQL document wrapper preserves grant SHARE → head UPDATE → stage UPDATE →
bundle UPDATE, then invokes the original finalizer in the same transaction.
First-party uses head → stage. The v3 semantic guard remains source-parity tested.
Staged effect apply rechecks the complete ordered effect byte/hash chain and
validates every complete preimage before set-based DML; it
retains final-state eligibility, original header/CAS and immutable ledger writes.
The full staged commit attempt retains a single **10-second** budget, not a fresh
budget per fragment. The lab uses `work_mem=2184kB`, pool 2 and public-only schema;
these are local correctness/stress settings, not production latency projections.

### Full transport, not just finalizer time

One synthetic real-entry run recorded the following **uncompressed JSON body**
traffic. REST totals include grant/layout/read/history requests; they exclude HTTP
headers/framing and the separate Auth endpoint. Timings are diagnostic loopback
samples, not production latency or capacity forecasts.

| Actual route | REST calls | Stage calls | Stage request bytes | Stage response bytes |
| --- | ---: | ---: | ---: | ---: |
| First-party abandon | 67 | 39 | 5,101,769 | 1,050,774 |
| First-party Undo | 75 | 34 | 4,609,778 | 767,412 |
| Compact-ID v3 archive | 77 | 47 | 2,996,945 | 1,066,403 |
| Compact-ID v3 Undo | 68 | 34 | 1,854,514 | 793,460 |

Sequential fragments amplify network round-trip time. A local finalizer speedup
is **not** evidence that the original 10-second attempt budget is sufficient on a
remote deployment. Any future bounded batching/concurrency must preserve original
request limits, byte order/hash/idempotency and the same total abort signal.

## Explicit stops
- The byte codec does not remove existing whole-header/entity read restrictions,
  original evidence limits, individual large-effect support gaps, full-history /
  compensation materialization or receipt-read limits.
- The receiver checks an explicit prior durable reservation but does not
  implement global admission, effect-byte accounting, expiry cleanup or retention.
  Reassembly remains O(document bytes), not constant-memory SQL. Existing
  prototype time/count/byte caps are not approved product limits.
- Planning transport coverage does not enable retired Decision Rules writers,
  nor prove Planning's final SQL authority. Other protected families remain
  separately gated in the operation matrix.
- Exact prepared bytes can resume, but a newly evaluated handler draft changes
  timestamps and therefore conflicts with the immutable uploaded intent. This
  native-tested 409 stop must not be hidden by allocating another stage. Durable
  pinned command intent/time and crash recovery remain a production prerequisite.
- A separate A′ reader-only source compiles/builds and its actual API entry can
  read B′ staged state and replay the complete original receipt under the narrow
  ACL. A′ has no new staged writer; this is not a hosted staged-compatible rollback
  pair. Hosted releases, old-reader retirement and production approvals remain
  separate from local HTTP evidence.

No original fast-path threshold, domain bound, timeout, provider budget or exposed
schema is changed. The production saving problem is not declared solved.

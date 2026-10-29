# Large command and byte-document protocol: local vertical slice

**NOT DEPLOYABLE. No production integration or new runtime flag.** The original
A/B fast-path caps, domain behavior and SQL remain unchanged. This separate
prototype is executed only in a disposable loopback database. It must not be
installed as a migration or exposed as a new production API.

## Real capability counterexample

The existing `applyUserDomainCommand` supports abandoning one opportunity with
many retained active actions. A synthetic fixture with 2,100 existing actions
returns `APPLIED`, with 2,102 exact row effects and a delta above 2 MiB. Its real
`applyDomainCompensation` produces 2,101 effects. Neither is a hypothetical
arbitrary snapshot mutation. A/B refuse these otherwise valid operations.
Current-state fit therefore cannot prove future capability parity at cutover.

## Implemented vertical slice

1. Compute the complete existing core output and compensation, without changing
   the core or splitting the user's operation into separate business commands.
2. Create an immutable staging identity bound to owner, workspace, epoch,
   expected revision, command ID/hash, exact metadata, effect count and a SHA-256
   chain over the ordered exact UTF-8 effect wire strings.
3. Upload byte-bounded pages (17 in the fixture). A repeated identical page is
   idempotent; changed repeats, gaps, duplicate entity keys and foreign owners
   reject. Upload changes no business rows, revision, cursor or audit receipt.
4. Finalize under staging and workspace locks in **one transaction**. Recheck
   owner/epoch, expiry, count/hash and the restricted first-party command family;
   retain existing original-command replay and CAS behavior. Iterate staged
   effects rather than aggregate a whole change array, check every preimage,
   apply all cross-entity changes, check complete state and create one immutable
   receipt/compensation record. Any late error rolls everything back.
5. Retain exact receipt on lost-response retries. The actual domain Undo uses a
   separate staged command, validates its original authority and preserves audit.

This original slice allows only first-party `abandon_opportunity` and its original Undo.
A separate local protected v3 archive/Undo extension is documented in
[`workspace-rows-staged-operation-matrix.md`](workspace-rows-staged-operation-matrix.md);
it is not a generic management dispatcher or a production integration.
The private row primitive retains the existing trusted-domain-core boundary:
SQL is **not** independently proving semantic-effect closure. No generic bypass
for delegated management generally, Gmail, AI capture or discovery has been added. The
separate v3 extension covers only its original authority; remaining
families still require dedicated staged guards, exact authority/lease rechecks
at finalize, and their existing compensation/replay rules. No production caller
imports the prototype. The local SQL includes a deliberately explicit copy of
the original apply primitive so its unchanged integrity checks can be reviewed;
a native source-parity assertion verifies every unchanged integrity check. This
duplication still must be resolved and differentially tested before integration.

## Byte-document reads, not larger response limits

An independent fragment reader returns at most 65,536 raw bytes per response,
with exact document identity, epoch/revision, byte offset, total length and an
initial SHA-256 digest. The consumer hashes bytes incrementally, writes to an
unpublished transactional spool, verifies all framing and a final revision
fence, then commits the spool. UTF-8 characters may cross fragment boundaries;
no per-fragment text decoding occurs. Cancellation, changed revision/identity,
wrong hash, invalid base64, gaps and premature empty fragments abort the spool.

The real HTTP fixture reads a synthetic retained audit document larger than
2 MiB into a private temporary file and removes it afterward. A concurrent
revision mutation aborts the read and truncates provisional output. A separate
pure transport test streams 33 MiB into a counting sink without collecting it.
**The 33 MiB test is not native PostgreSQL evidence.** Native JSONB-to-text
conversion currently repeats per fragment, so CPU/detoast cost is not constant
and no latency gain is claimed. A consistent caller must keep this same fence
across an entire multi-document history read, not commit each document and call
the set one consistent snapshot. Full history enumeration, integration with
Undo callers and complete snapshot API materialization remain to be designed.

## Verification

- Unchanged fast path rejects the actual large command, then new staged HTTP
  commits exactly the complete domain output and original compensation.
- Repeated page/lost response, changed repeated bytes, missing/gapped pages,
  owner isolation, ordinary-role denial and protected-family rejection.
- Real connection close after finalize statement but before COMMIT: no business
  changes survive. Two concurrent finalize requests create one ledger record.
- Replay through a new upload returns the immutable original receipt; stale
  different command returns conflict; actual large Undo restores all actions.
- Wrong final digest, expiry and late preimage corruption cannot publish a
  partial write. A retired epoch rejects even a completed staging replay.
- Native HTTP large-audit byte streaming and revision-interruption spool cleanup;
  unit framing, UTF-8, cancellation, final-fence and 33 MiB sink tests.

## Migration remains closed — executable decision

`stagedPrototypeMigrationDecision()` deliberately returns `eligible: false`.
No small-state heuristic or a green vertical slice changes that answer.

Unclosed requirements:

- All required command families need an actual staged finalize contract and
  existing authority/lease/capability checks; staging is never authorization.
- Single huge effect/header, compensation, receipt and total-history APIs are
  not solved by this staged subset. Existing row-layout readability checks stay
  in place. The fragment primitive alone is not their end-to-end integration.
- The prototype's 1 MiB metadata, 240 KB upload pages, bounded effect count,
  128 MiB staging admission and one-hour staging expiry are local resource
  controls, **not approved product quotas or service deadlines**. The supported
  operation set must be complete, or owners remain on the old layout. Do not
  simply raise constants or silently reject a former capability after cutover.
- Per-owner/global staging capacity reservation, retry retention and cleanup of
  abandoned staging need a bounded policy proven safe against active finalize
  and existing receipt replay. No sweeper/deletion job is installed here. Staging retains both exact wire
  text and parsed JSONB plus indexes, in addition to business rows and audit;
  it increases temporary disk/WAL use. The native fixture reports this extra
  physical size, not a production capacity estimate.
- Native finalization still performs all business effects atomically. Chunked
  upload does not promise bounded final-transaction CPU/WAL or faster execution.
  The full-state validation scan is still present.
- Exact production static SQL, ACL/owner/RLS review, platform old-reader fence,
  actual disk headroom and two hosted row-compatible rollback versions remain
  mandatory. Existing A/B commits cannot operate this new staging protocol;
  a later integrated version needs its own compatible rollback pair.

No public upload, merge, deployment, production SQL/ACL, cutover, resource
purchase or change to legacy user data is part of this local slice.

# Local synchronous terminal reclamation — contract

Status: local, synthetic, default off; not a production migration or rollout approval.

## Metering

`reserved` R is the immutable original authorization. `current_held` H and
`released_bytes` L satisfy H + L = R. Current pool/owner admission sums H, not R
and not historical peak. The same original user/global limits charge surviving
control C after retirement: H = occupied = present = C > 0, L = R − C.
`reclaimed` is **not** `released`. Historical peak remains historical and can
legitimately exceed current H; actual new charge must still fit current H.

C is the UTF-8 length of a canonical UTC JSONB representation of all surviving
per-command intent identity/binding/retirement, stage metadata, original document
reservation, original attempt, the full resource-reservation row, old allocation
and chunk tombstones, and the new retained-control allocation/chunk rows. This
includes accounting scalars and the metering record itself. Only the value of its
self-referential SHA-256 is replaced with 64 zero hex characters for hashing: the
key, quotes and all 64 characters still count. The actual stored SHA is separately
verified against the canonical bytes. The byte-length integer fixed point is
checked, not assumed; failure to stabilize within 32 steps conservatively defers
cleanup with the full original charge. No SHA fixed point is attempted. Shared
pool/owner aggregate rows are not duplicated per command; their actual sums are
independently checked. No free metadata bucket is introduced.

The entire old logical occupancy plus C must fit H **before** deleting old copies.
The original 8 MiB peak-negative command cannot be rescued by early deletion.
A separate lower synthetic owner ceiling in turnover tests is not production
quota policy. The full original audit ledger is not a temporary copy and is not
removed or rewritten to manufacture capacity.

## Atomicity and authority

The existing public-only PostgREST finalizer runs all original business, audit,
CAS, readability, authority and deadline guards before cleanup. It then confirms
the authoritative original ledger, or a persistent legal terminal attempt;
validates the exact original-table inventory and hash; precharges C; establishes
an immutable tombstone and writer fence; removes only temporary documents,
effects, encoded intent and reconstructed request/result duplicates; independently
checks absence plus retained control; and reduces H by exactly R − C once.
Everything is in the same public-RPC transaction as the new business commit.
Captured original attempt ID/generation/deadline and original real expiry are
checked again after cleanup, without renewing or extending the original 10 s.
Any failure of a new commit's strict cleanup/last deadline rolls the complete
transaction back. Backend termination at each delete/counter/COMMIT cut does not
leave half-released capacity.

No cleanup occurs inside resolver/history/readability probes. Existing committed
or legally terminal observations may attempt cleanup at an outer public response
boundary; qualified inventory/authorization cleanup failures are rolled back in
a savepoint and do not hide the original result. Timeout/backend/unknown failures
are not swallowed. Missing/frozen policy and insufficient transition space defer
while keeping full charge. This is not a background queue, reaper, TTL, cleanup
window or new operational policy. It does not guarantee cleanup progress for an
existing record whose original authority is no longer valid.

## Irreversibility and replay

Original receipt, projection, compensation, Undo lineage, effective times,
identity/binding hashes, original grant and real resource expiry remain intact.
Retired records cannot become absent/null or trigger admission again. Old/v1/v2
readers resolve the original receipt; late writers use the same original locks
and permanent fence. Expiration of one attempt alone does not expire the intent;
a new bounded attempt uses the original intent, authority and real expiry.
Unknown outcome is never enough to reclaim. True resource expiry is reclaimable
only after a legal persistent terminal state.

RPC lock order is original grant → global pool → owner → resource reservation →
workspace head. Additional triggers protect sequential direct mutations but are
not a substitute for least-privilege ACLs against arbitrary concurrent privileged
DML. The existing broad service-role DML surface remains a production gate; this
local overlay does not claim to close that independent ACL boundary.

## Explicit non-claims

DELETE/NULL changes logical reachability and logical admission capacity. It does
**not** immediately shrink PostgreSQL files or TOAST, reclaim WAL, account physical
indexes/MVCC, or bound VACUUM work. FS spool/FD/process cleanup and real browser
IndexedDB/platform blockers are independent and remain open. No production SQL,
credentials, provider, resource, budget, push, PR, CI, merge or deploy was changed.
Past timeout and SIGKILL evidence remains in its original run directories; a later
pass is not proof that an unexplained historical failure was repaired.

## Self-meter length failure is deliberate and conservative

The finite calculator is not a convergence claim. For a native, private
representation-only fixture with R=q+c, q=10^7, C occupying nine numeric slots
(including its transition peak), the independent oracle constructs
F(c)=c+1 and F(c+1)=c. Its exhaustive output-length bounds stay within one C
numeric-width interval and straddle only the released-byte width boundary; no
candidate in those bounds is a fixed point. The SQL calculator returns NULL and
leaves all fields and full charge unchanged. Synthetic rows are created inside
a rolled-back test transaction, never by changing a live admitted R. This test
is representation mathematics, not successful product admission.

After C is successfully precharged, the reclaiming phase does **not** restart
root finding with a now-fixed peak. It uses that exact C and validates the same
canonical bytes once. Reservation revision maps q→q+1→q+2; peak maps to
max(oldPeak, oldOccupied+C) and remains unchanged. This avoids different roots
at decimal boundaries. Any disagreement still aborts before releasing capacity.

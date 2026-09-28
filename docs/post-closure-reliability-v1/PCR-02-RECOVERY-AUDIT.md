# PCR-02 — account-boundary and legacy recovery audit

Base: `fb3c7505b3290b088f3c48bca0648d1342e9c8b5` (PR #187 closure).
Writer: `reliability/pcr02-account-recovery-v1`.
Status: **COMPLETE — PR #188 merged and exact-main production verified**.

## Demonstrated defects

**PCR02-F1: unhandled auth-boundary failure.** A real Supabase SIGNED_OUT event,
with cache clearing rejected, left account A's tasks interactive and no recovery
surface. The initial regression failed against the merged main implementation.
The subscription launched adoption without consuming its promise rejection.

**PCR02-F2: partial cache loss on synchronous store failure.** With root error
recovery already enabled but exact-main `clearLocalWorkspaceCache`, throwing on
the third clear after earlier requests were queued committed a partial clear.
The raw recovery archive lost both fixture opportunities. The regression fails
on main's cache implementation and passes with explicit transaction abort.

Both are isolated synthetic headless tests. No production state was modified.

## Bounded repair

- Cache boundary failure becomes a root recovery error. Old account UI unmounts;
  raw stores remain downloadable and Retry remounts the provider, rereading the
  real current auth session. A failed adoption never advances binding or links.
- Subscription promises are caught; Google linking follows successful adoption.
- All cache clears and their completion use one transaction. Any request or
  synchronous failure aborts pending clears, consumes transaction rejection and
  leaves binding intact. Replacement/recovery does not fabricate success.
- No blanket workspace purge, remote write, permission change or cursor change.

## Verification

Seven new real-browser regressions:

1. SIGNED_OUT + synchronous failure after partial clear: raw archive and durable
   stores identical, recovery visible, Retry safely clears expired cache, reload
   never revives A. No backend mutation.
2. SIGNED_OUT + transaction abort: same lossless recovery and Retry contract.
3. Settings sign-out + one-shot partial-clear throw: the auth listener and UI
   share a serialized boundary; failed transition is latched until Retry. A
   queued successful clear cannot erase the recovery archive.
4. Settings sign-out + transaction abort: same retained archive and Retry.
5. Legacy v1 restore: Today/Schedule/job details, reload, fresh-page restart;
   readonly startup does not change any durable store.
6. Legacy v2 restore: same contract.
7. Legacy v3 restore: same contract.

All seven pass in Chromium, together with existing A→B account isolation and
cross-client process create/delete regressions (nine cases). They are included
in the Firefox/WebKit Matrix. Unit 204 files / 982 tests, type and build pass.
The final PR must pass applicable full gates and exact-head Codex review; this
candidate receipt does not claim production has deployed this additional fix.

Existing P0 regressions cover invalid timeline rows at initial startup/reload,
lossless raw export/Retry, deterministic projection, root selector/render error
and real queued replacement with atomic baseline/source edits. Existing connected
journeys cover lost responses, receipt recovery, CAS conflict, account drafts,
pending operations and stale-cache refresh failure. Further PCR-03..05 audit is
still required; these tests do not certify every offline/account race.

## Read-only production structural evidence

At revision 844, snapshot schema v4:

- Schedule: 284 scheduled, 13 completed, 3 cancelled; 300 legacy projections.
- Timezone provenance: 241 UTC, 47 floating-date, 12 source-offset.
- All 13 completed nodes lack completedAt; preserve unknown completion times.
- 82 semantic receipts, all with creationSequence.
- Action kinds: 339 apply, 19 follow_up, 15 manual, 7 prep, 4 group_decision.

At revision 845, **358 open DecisionRequests** (`state`, not `status`). These
records were not cleared. The Repair 02 cluster-specific protected counts are
not the total workspace decision count. Production aggregates are structural
evidence only; no private payload or snapshot is committed.

Remaining candidates for later phases: audit generic reopen/Undo with multiple
historical occurrences; inspect connected refresh/auth races and offline startup
without claiming coverage from unrelated capture tests. Only reproduce/fix real
defects, preserving all already-closed packages.

## Valid Codex concurrency finding

Codex P2 at first head 3de0d2d identified duplicate clears from Settings sign-out
and the auth listener. The one-shot Settings regression fails on that head:
the recovery archive is empty after the listener fails and the direct clear
succeeds. Both paths now use one serialized adoption queue; the latest transition
controls exposure, and any boundary failure blocks every queued clear until the
provider is explicitly remounted by Retry. Pending-operation replay runs outside
the boundary queue. The seven-case suite verifies the repaired contract.

Independent diagnostics also reproduced a late authoritative read reviving A
after successful sign-out, and generic task Undo rewriting old completed/elapsed
nodes. These remain factual PCR-03/PCR-05 work; this receipt does not mark those
unfixed classes complete or claim the whole package is closed.

## Exact-main closure

PR #188 final c85781a passed all applicable head gates and latest Codex clean
review 5874738441. Merge d19e5b5236d24f9f04f1ce6ad8cc901ddcd3fcac passed CI
36455446215, Browser 36455446172, Matrix 36455446248, Pages 36455446488,
production Self-Test 36455651129, Brand 36455651080 and Live Visual 36455651021.
Health 1384 returned exact d19. Actual deployed headless bundle with full readonly
revision-847 snapshot passed seven daily-route/reload/fresh-page startup cases,
zero errors and zero network writes. No production workspace mutation occurred.
The separate late authoritative-read privacy race remains an open PCR-05 defect.

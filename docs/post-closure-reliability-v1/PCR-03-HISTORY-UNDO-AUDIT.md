# PCR-03 — historical action Undo and reopen audit

Base: `d19e5b5236d24f9f04f1ce6ad8cc901ddcd3fcac`.
Writer: `reliability/pcr03-history-undo-v1`.
Status: **CANDIDATE — full remote gates, latest review and exact-main required**.

## Reproduced defect

An action linked to several occurrences was completed, then undone through the
real domain compensation reducer. Old Undo carried only action id/prior status
and called the broad schedule synchronizer. This reopened previously completed
and elapsed occurrences and changed prior in-progress state to scheduled. A prior
completion with the same command timestamp was also incorrectly reopened: time
is not ownership evidence. Six regressions fail against the verified base.

Generic todo/doing/skipped transitions had the same terminal-history rewrite.
An edited or removed occurrence was not rejected by the compensation reducer.

## Repair boundary

- Generic task status never reopens completed/cancelled/superseded/elapsed facts.
  Explicit occurrence commands retain their separate identity and meaning.
- New domain compensation captures normalized action before/after and only
  occurrences whose business state changed. Undo validates the whole affected
  set before restoration; matching timestamps and shared action ids do not infer
  ownership of existing history. Missing/replaced/edited targets fail closed.
- State restoration retains all before/after provenance references, timeline,
  ChangeSet and command ledger history. It restores the real prior in-progress
  state. No application, withdrawal or outcome is fabricated.
- Signed MCP status batches capture one compensation for the complete batch,
  including shared nodes, and keep exact authority/CAS/Undo dependency checks.
- Local UI uses returned exact completion evidence. Validation and restoration
  share one all-store IndexedDB transaction; a later edit aborts every write.
  Action expected status is also checked inside the mutation transaction.
- Legacy status-only receipts with linked occurrences fail closed because they
  lack reliable prior-node evidence. Existing history is retained rather than
  guessed or migrated into a fabricated completion. No ledger/receipt deletion.

## Permanent regression evidence

- Domain JSON round-trip: completed/elapsed/cancelled/superseded/legacy and unknown
  completedAt, same timestamp, multiple linked nodes, exact in-progress restoration.
- Generic reopen/doing/skipped preserves historical occurrence state.
- Later node edit/removal and legacy missing compensation evidence are rejected.
- Actual authoritative executor persists compensation, executes CAS Undo, retains
  original command/timeline; existing unrelated/dependent conflict tests pass.
- Signed MCP batch shared-node compensation and actual executor Undo pass.
- Eleven headless Chromium cases: real History → job detail → Mark done → Undo in
  local and connected mode, Today/Schedule/job-detail durable reload/fresh-page
  restart, later occurrence edit refuses Undo with raw store equality, legacy
  projected event action compensation, and a real second-connection status race.
- New eleven cases plus ten P0 and seven recovery cases: 28 browser passes.
  Two existing current-event local/connected create/delete journeys also pass.
- Unit: 205 files / 996 tests. Type and production build pass. Matrix includes the
  new journeys. Full head/main results must be recorded after they finish.

All fixtures are synthetic. No private snapshots or production mutations. The
late authoritative read after sign-out remains a separate PCR-05 reproduced
privacy defect; PCR-04..07 have not been declared complete.

## Historical deletion audit and bounded repair

Three actual IndexedDB regressions against the first candidate reproduced local
event deletion succeeding for completed, elapsed and legacy scheduled/past nodes.
For completed/elapsed nodes it left a missing-event reference rejected by startup
validation; for scheduled/past nodes it rewrote elapsed evidence into cancellation.
The connected reducer already refused invalid snapshots, but surfaced an indirect
validation failure rather than the business boundary.

Both paths now inspect normalized effective history before deletion. A history
reference returns an explicit refusal (connected BUSINESS_CONFIRMATION_REQUIRED /
HISTORICAL_OCCURRENCES_RETAINED; local readable error), keeping every raw store
unchanged. Current/future event deletion remains supported and its two existing
real browser journeys pass. Snapshot reference validation has not been relaxed.
Completed times remain unknown where originally unknown; no new completion or
cancellation fact is invented to make deletion succeed.

Delete compensation also captures only nodes actually cancelled, checks their
exact post-delete state, and retains any unaffected superseded provenance edited
later. It restores every action removed by that scoped event, rather than just
the first. Legacy deletion receipts without post-delete evidence fail closed on
changed nodes. Actual authoritative executor refusal leaves revision and ledger
unchanged; durable local refusal passes all daily routes and restart.

First candidate ae7a4d3 passed CI/Browser/Matrix/UI/Brand/VoiceOver/rollback and
Codex clean review 5875258410. Those results do not certify this later deletion
repair; the final head requires fresh full gates and review.

## Required reimport audit

Reimport preserved completed nodes but could drop their non-local process record,
committing a missing-process reference that startup then rejects. It also removed
explicit elapsed_unresolved and scheduled/past legacy occurrences from storage.
Two retention regressions fail on the previous implementation. The missing-process
regression was rerun with a schema-valid process fixture and fails before repair:
unsafe reimport reports success. The corrected implementation refuses it with
complete raw-store equality. The initial malformed fixture was a harness error,
not counted as a reproduction.

The existing terminal-history retention rule now includes effective elapsed
occurrences. The complete proposed snapshot is validated under the same all-store
transaction locks before any replacement. Missing historical dependencies abort
without changing source or baseline. This preserves existing import semantics for
valid workspaces; it does not weaken validation, create substitute facts, erase
history or introduce another writer. All 28 history/P0/recovery journeys pass.
No production import or write was performed.

Latest-head Codex P1 was valid: validating old stores before overlay prevented a
correct reimport from restoring an already missing process. The import now reads
raw transactional rows, overlays and validates the complete candidate, and only
then materializes the baseline inside the same atomic transaction. Both existing-
marker and no-marker real IndexedDB regressions fail on 5e9b26c and pass after
repair. All 13 history browser cases pass; unsafe proposals still abort unchanged.

Owner escalation: after this single writer closes, dense production Today/decision
membership and lossless cache convergence take priority over general PCR audits.
Readonly revision851 shows 6 selected actions plus358 decisions, not361 selected
actions; 98 historical nodes remain separately unresolved. Classification continues;
no production cleanup has been executed and Repair02 authorization remains consumed.

Two follow-up P1 findings were also reproduced and repaired before merge. The
validated import now persists the pre-import terminal-action baseline before
replacement, retaining undated omitted done/skipped evidence. Changed legacy
import deadlines supersede the retained occurrence with a new version instead
of projecting the obsolete date back onto the imported action. Repeated imports
retain the same version chain. Four new real IndexedDB regressions fail on
40e80a2 and pass after repair; all17 history browser cases pass. No production
workspace mutation, deletion or validation relaxation is part of this repair.

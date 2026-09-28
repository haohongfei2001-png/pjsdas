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
- Three headless Chromium cases: real History → job detail → Mark done → Undo in
  local and connected mode, Today/Schedule/job-detail durable reload/fresh-page
  restart, and later occurrence edit refuses Undo with raw store equality.
- New three cases plus ten P0 and seven recovery cases: 20 browser passes.
- Unit: 205 files / 990 tests. Type and production build pass. Matrix includes the
  new journeys. Full head/main results must be recorded after they finish.

All fixtures are synthetic. No private snapshots or production mutations. The
late authoritative read after sign-out remains a separate PCR-05 reproduced
privacy defect; PCR-04..07 have not been declared complete.

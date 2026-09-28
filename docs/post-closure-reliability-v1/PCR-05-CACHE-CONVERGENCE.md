# PCR-05 cache convergence and account races

Status: CANDIDATE; single writer reliability/pcr05-cache-convergence-v1.
Base: 5d9e52fff0f22f8bc44435ddf398060ccf0c9b65.

## Reproduced defects and bounded repair

- Real IndexedDB returns entity arrays in key order. Prior production snapshot
  compared unequal solely because wire order differed. Read-projection equivalence
  now sorts only unique, nonempty top-level entity IDs. Wire fingerprints and
  meaningful nested order remain unchanged; duplicate IDs and content differences
  remain fail-closed.
- A late authoritative response revived account A after sign-out. A synchronous
  account generation invalidates in-flight read/command/cache work before async
  boundary cleanup. Account identity is checked when obtaining backend tokens.
- A response could overwrite a local edit made while fetching. The captured local
  snapshot is compared inside the same all-store IndexedDB transaction used for
  replacement. Checkpoints use the committed projection, not a later unrelated
  export. Older revisions cannot roll back newer checkpoints.
- Synchronous put errors now abort replacement and preserve every store. Explicit
  rollback regressions inspect all raw data and reload afterwards.
- Receipt retries preserve local edits and pending identities; they cannot adopt
  an intervening edit as a clean baseline and overwrite it.

## Evidence

1022 unit tests and type checking passed before the final pre-send lease check.
Real headless Chromium: seven account race/order scenarios and seven existing
connected command/recovery journeys passed. Three additional dense persistence
and injected failure scenarios passed. Private real snapshot aggregate confirms
prior-to-current projection equivalence, six Today actions, zero Today decisions,
344 exact groups retaining all 358 raw requests. No private data is committed.
Stable candidate reruns and remote CI/Browser/Matrix plus fresh independent review
are required before merge; this is not production certification.

## Boundaries

Real local changes are retained rather than silently overwritten. No broad merge,
entity deletion, Gmail reprocessing, cursor/permission changes or production writes.
Owner browser itself has not been inspected; this proves the reproduced safe
ordering convergence class, not that every possible divergence is equivalent.
Repair02's single-write authorization remains consumed.

## Independent review repair

Fresh exact-head f498ecd source review found one valid P2: explicit cloud conflict
recovery discarded the committed projection baseline, blocking the next command
and receipt lookup on harmless entity reordering. Full report PRcomment5879753272.
A new real IndexedDB recovery→command→receipt regression failed with
AccountCacheChangedError before the repair. Recovery now publishes the committed
projection/source fingerprint pair after the account guard. The regression and
17 other account/command/persistence journeys pass; 1022 unit tests and type pass.
New exact-head full gates and a new independent review are still required.

Second fresh review253ee42 found a valid P2: retained account checkpoints blocked
receipt recovery after a legitimate sign-out cache clear (fullreport5879933584).
The real sign-out/re-login regression failed before repair. A successful boundary
now records the exact committed cleared-cache fingerprint for retained account
checkpoints. Commands/read refresh/sync may recover only that exact projection;
intervening real local data still fails closed. Successful hydration consumes this
marker. Pending commands and drafts remain account scoped and retained.
1022 unit/type and19 headless regressions pass; additional re-login read-only and
valid-local-edit preservation variants pass. New head review/full gates required.

# ZMC-02 — One-authority cache lifecycle candidate

## Product behavior

The connected account remains the durable source of confirmed business state. A verified browser cache at an older revision can read and apply a newer authoritative snapshot, even when the new snapshot contains independent business updates. The persistent conflict recovery probe runs automatically on load, focus, online return, and its bounded interval; it never sends a workspace write. A revision difference alone does not require a local-versus-account choice.

An unresolved account command or a recorded local-only edit prevents cache replacement. Those are retained for command recovery or explicit diagnostic classification; the background refresh does not erase them. A newer remote revision remains observable while both sides stay intact. Exact equivalence can clear a stale local-only marker. Account lease and local snapshot checks protect against late responses, sign-out, and edits during the read.

## Red-before evidence

- A verified `txn:843` cache plus a distinct `txn:1004` authoritative update returned `conflict` from the automatic recovery probe instead of pulling; the targeted test failed before the fix.
- A pending command plus newer remote revision returned `pulled` from passive sync, replacing the cache before the command was confirmed; the targeted test failed before the guard.
- A local-only edit recorded in the checkpoint was also pulled over when a newer remote revision appeared; both sync and Today read-refresh targeted tests failed before their guards. Independent review then exposed three further red-before cases: no current conflict record for a genuine concurrent local edit, a stale pending marker blocking an already equivalent business projection, and an old conflict revision remaining frozen while an unresolved command held the cache.

## Green-after evidence

- The automatic recovery probe admits a read-only pull only after the existing sync decision has proved a safe old-cache baseline, or the current remote projection is equivalent. It never creates or uploads an authoritative workspace.
- Passive sync and Today read refresh preserve unresolved commands and recorded local-only edits; the connected path rechecks the outbox during projection. A genuine concurrent local edit keeps an up-to-date conflict diagnostic, while a proven equivalent business projection clears its stale marker. Pending commands prevent projection but do not freeze an existing conflict's read-only remote revision metadata.
- Owner-browser regression covers Settings at an old conflict followed by an independently changed remote snapshot and reload, with no retry click. Existing owner-browser regressions retain genuine local edits and track advancing remote revisions. The first cloud Browser gate also found that an account-scoped command outbox was incorrectly blocking safe sign-out. Independent review caught the converse risk: an outbox must not authorize clearing an unverified local-only workspace. The guard now permits sign-out only with a verified account-bound cache and no local-only edit; a browser regression preserves unverified local data and the original account's command.
- Full local suite: 208 files and 1,081 tests passed; TypeScript and production build passed. The corrected cloud Browser E2E, Matrix, final independent review, merge, and exact-main production readback remain required for closure.

No production business record, Gmail cursor, OAuth scope, or IndexedDB profile was mutated during this phase.

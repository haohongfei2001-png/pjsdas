# Integrated candidate × complete R0p: independent full 81-case pair

## Scope and present status

This is a **prepared, not executed** local runner. Preparation performed only
source inspection, source-normalization comparisons, and `node --check` on the
five new `.mjs` files. No PostgreSQL, HTTP, bundling, unit suite, package install,
production access, or old-tree modification was performed during preparation.

The new B tree contains the R1p runtime and the original resource SQL chain.
This runner installs those resource primitives on the **same original public
routes, default off**. It is **not** the resource-enabled × rollback matrix.
`pool`, `rpc_scope`, `owner`, `reservation`, `allocation`, `chunk`, and
`temporary_bytes` must all be empty after installation and after all cases.
No limits, owners, enrollment, policy, provider, credential, or production ACL
are introduced. The existing synthetic original document reservations remain.

Earlier evidence stays separate and failed: the old complete run had 55 PASS
then case 56 deadline FAIL; its remaining cases were not run. The independent
25-case tail does not turn that into an 81-case PASS. An earlier attempt's
14 PASS / one deadline FAIL is also not repaired or erased by this new runner.

## Frozen sources and artifacts

| Role | Exact source |
| --- | --- |
| A: complete R0p | `r0p` source-only closure, provenance `a8c13dade102691b6562170a4d3d55d3ef724109` |
| B: integrated candidate | this tree; required `TA_INTEGRATED_SOURCE_SHA`, set to the final committed/frozen candidate |
| Historical producer | `historical103` source-only closure, provenance `103d8c92c485f1e8fd5cba901e75b1de403fbc91` |

The current candidate's exact HEAD and tracked-clean state are checked before
bundling, after scenarios, and after cleanup. Each historical closure is checked
against its independent manifest and all source-file hashes at those boundaries.
Materialized closures are explicitly labeled **not complete Git commits**. An
optional original checkout must also match its exact provenance HEAD and be clean.
A mismatch is fatal and invalidates any provisional scenario PASS. The manifest
pins the actual transitive source imports and retains the historical generated
release-identity bytes; provenance and embedded build identity are distinct.
See [reproducible validation](workspace-rows-reproducible-validation.md).

The unchanged original page-ready worker is copied into
`integrated-pair-cold-worker.mjs`. At authorized runtime, esbuild's `stdin` uses
its exact contents with `resolveDir=<each frozen tree>/tests/sql`. Thus the real
API, scoped runtime, history reader, and transitively imported implementation
are bundled from **that release's tree**, not all from B. `packages: external`
uses existing local dependencies. The three exclusive output bundles live only
under this tree's `tests/sql/integrated-pair-tmp-<release>-<UUID>.mjs` and are
removed in cleanup. No worker, generated bundle, or dependency is written into
A or the historical tree.

New files:

- `tests/sql/integrated-pair-harness.mjs`
- `tests/sql/integrated-pair-scenarios.mjs`
- `tests/sql/integrated-pair-historical.mjs`
- `tests/sql/integrated-pair-cold-worker.mjs`
- `tests/sql/integrated-pair-source-contract.mjs`
- this contract

## Full inventory, original budgets, and safety

All original full-run fixtures, assertions, order, and eight transport breakpoints
remain. The latter are intent admit, documents begin, metadata, beforeEnvelope,
afterEnvelope, compensation, effect append, and documents finish. Count:

| Case group | Count |
| --- | ---: |
| A/B active + inactive first-party write/replay/original Undo/read | 4 |
| Scoped complete-byte-disabled negatives + original long-2050 flows | 4 |
| Two directions × two families × eight durable breakpoints | 32 |
| Original pending Undo recovery, two directions × two families | 4 |
| Missing fragment + unnegotiated complete-reader negatives | 4 |
| Historical three modes × two families × two recovery releases × command/Undo | 24 |
| R0p page-read preference retains fragment admission | 1 |
| Stop-new-durable-admission, two releases × two families | 4 |
| Historical original-grant revocation, two releases | 2 |
| Selected page-reader finalizer atomic refusal | 1 |
| Original read fence, retained blobs, request spool cleanup | 1 |
| **Total required in this single run** | **81** |

Original reservation and decode cap: 8,388,608 bytes. Original reservation
expiry: 30 minutes. Original SQL `work_mem`: 2,184 KiB. Original statement timeout:
10 seconds. Original staged-command total budget: 10,000 ms. PostgREST retains
pool 2 and maximum rows 1,000. Original long 2,050 fixtures and historical compact
legacy-inline fixture exceptions are unchanged. No deadline, byte cap, runtime
profile, staged bridge, durable intent, resource algorithm, or fixture size is
increased to obtain a pass. Encoded bytes, manifest, immutable original deadline,
original grant/client authorization, complete V5 receipt/projection/compensation,
original Undo, one commit, and no replacement admission remain asserted.

Proxy requests increment `proxyInFlight` upon callback entry and decrement only
in `finally`. Each case PASS requires zero outstanding callbacks. Before the
global fragment DROP and before page-fault registration, zero is required;
otherwise the runner fails immediately rather than waiting for a late write.
The page DROP intentionally occurs **inside the one current callback**, after
its upstream `large_documents_begin` response body is fully consumed. Immediately
before DROP it requires exactly one callback: the current settled-upstream hook,
with no other pending request. It does **not** claim total callbacks are zero at
DROP, and never decrements early to disguise this. These counts are explicit in
the selected-page case report.

Fail-fast is retained. A single report-level catch records failure then rethrows;
there is no per-case catch-and-continue, retry, deadline reset, or skipped case.
Aggregate `pageReadyPair` / rollback PASS is assigned only after all 81 distinct
cases, default-off resource checks, zero proxy callbacks, and source checks.
The scheduler must also require process exit 0, `runner-state.json` status PASS,
`cleanupComplete: true`, matching source checks, and all 81 cases in the pair
report; a scenario summary log alone is not final success.

## Authorized launch contract (not run during preparation)

The parent scheduler owns PostgreSQL startup/shutdown and provides existing local
dependencies, existing PostgREST, and a fresh exclusive evidence directory.
PostgreSQL must be loopback port **55634**, with the existing synthetic cluster
roles `anon`, `authenticated`, `service_role`; the fixture requires local database
and role creation rights. PostgREST binds **127.0.0.1:55635**, exposes only `public`,
and uses fresh synthetic signing material. Database and authenticator names use
`ta_integrated_pair_` / `ta_integrated_pair_http_`. The existing global
`pjsdas_workspace_blob_reader` fixture role must not exist; the runner refuses to
take over another fixture. Gateway/proxy use exclusive ephemeral loopback ports.

From this repository root, after the parent freezes the commit and starts PG:

```sh
TA_INTEGRATED_SOURCE_SHA="$FROZEN_SHA" \
TA_INTEGRATED_PAIR_REPORT="$EXCLUSIVE_EVIDENCE_DIR/pair-result.json" \
TA_ROW_DATABASE_URL="postgresql://$LOCAL_PG_USER@127.0.0.1:55634/postgres" \
TA_POSTGREST_BIN="$EXISTING_POSTGREST_BIN" \
node --import tsx tests/sql/integrated-pair-harness.mjs
```

`TA_INTEGRATED_PAIR_REPORT` must be an absolute `.json` path. An absolute
`TA_PAIR_REPORT` is accepted only as a compatibility fallback. The directory
must already exist. Existing pair report or reserved diagnostic filenames cause
startup refusal rather than evidence overwrite. Outputs in that directory:
`pair-result.json` (or chosen basename), `cold-timeline.json`,
`http-timeline.json`, `terminal-command-state.json`, `source-checks.json`, and
`runner-state.json`. No script auto-runs this command or installs dependencies.
A precondition/import failure may precede report creation; nonzero process exit
is always failure. Early startup failure does not query an unconnected PG client.

## Static source and assertion preservation

The public source contract verifies all original SQL hashes, the original resource
harness normalization, no-replacement-admission assertions, and the frozen pair
harness/scenarios/historical producer/cold-worker source hashes. These are source
checks only. There is no private sibling file or raw local evidence dependency.
Every deliberate runner change and durable-v2 evolution is separately enumerated
with original/new source hashes. No deadline, fixture, case count, or failure is
removed by path portability work. Clean-checkout execution remains **NOT_RUN**;
prior local observations are not portable acceptance results.

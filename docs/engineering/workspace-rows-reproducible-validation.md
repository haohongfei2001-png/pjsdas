# Reproducible synthetic row-storage validation

This package removes private sibling-worktree and unpublished-Git-object
requirements from the local validation runners. It does **not** change runtime or
SQL algorithms, activate features, change CI policy, or certify a release.
Source-only checks and six independent bundles passed for the frozen packaging
source in an archive without Git history, sibling worktrees or installed local
dependencies, using separately verified existing locked compiler packages. No
bundle was executed. Fresh dependency installation, TypeScript, unit, PostgreSQL,
HTTP and the full historical matrix remain **NOT_RUN** on that packaged source
until separately executed. Static/compile-only checks are not runtime acceptance.
See the [versioned status summary](workspace-rows-durable-attempts-v2-contract.md#synthetic-validation-status-at-draft-publication).

## Exact historical sources, not invented releases

`tests/fixtures/workspace-rows-history/` contains 15 deduplicated **text source**
blobs plus independently recorded file manifests. These are real historical
implementation bytes, not synthetic reimplementations of the current code.
There are no compiled bundles, Git bundles, private logs, production catalogs,
credentials, user records, dependency packages or complete local Git history.

| ID | Source provenance | Source/config files | Purpose |
| --- | --- | ---: | --- |
| `r0p` | `a8c13dade102691b6562170a4d3d55d3ef724109` | 172 | Original fragment-admission profile, three-mode recovery, actual API/scoped/history worker |
| `historical103` | `103d8c92c485f1e8fd5cba901e75b1de403fbc91` | 170 | Actual old producer with original v1 intent/protocol behavior |
| `reader` | `9288be394d448848fb6a3f47b42c45dc6df08deb` | 165 | Narrow historical reader-only API compatibility; not complete writer rollback |
| `serial` | `0d056961faa4358e7503a124fa102467e84b5b61` | 50 | Original serial row reader/writer used by the two-source regression |

Each profile records the provenance commit/tree, entrypoints, external imports,
per-path SHA-256, Git blob identity and exact byte count. A deduplicated file
catalog records literal relative-import edges, including dynamic and type imports.
The catalog itself is hash-bound by each profile. Historical package/lock and all
referenced TypeScript configs are included. Required worker resolution directories
(such as an otherwise empty `tests/sql`) are declared and materialized too. The source graph was extracted with
TypeScript's static preprocessor and resolved against each **old** tree, not the
current tree. Runtime bundling remains an additional mandatory closure check.

Unchanged files are reused from this repository **only when their independently
recorded historical SHA-256 matches**. Changed historical files live in
`blobs/<sha256>.txt` and are materialized under their original source paths. A
future current-file edit must preserve its old bytes in a reviewed blob first;
the resolver fails rather than silently using the new implementation. Historical
profile, intent, bridge and runtime differences therefore remain independent.

The output is explicitly a **source dependency closure, not a complete Git
commit**, and is never initialized as a fake historical Git repository. Provenance
hashes are historical metadata, not evidence that those commits are publicly
fetchable or deployed. The supplied file hashes permit independent byte review;
they are not a signed attestation of an unavailable historical commit.

### License and build identity

All fixture files originate in this same repository. No `LICENSE` file was found
in those historical trees; this packaging does not invent a license or relicense
the code. Third-party packages are not copied into fixtures and retain their own
package licenses and committed lockfile integrity values.

All four old trees' `gateway/generatedReleaseIdentity.ts` embeds
`e53bb5ad7bcfa6c4ecd23f930a630d24209e81ff`. Those exact bytes are preserved. This
**embedded build identity is not the source provenance SHA** in the table and is
not rewritten to pretend that an old closure is a hosted release. The current
candidate's production build identity is generated from its real final Git HEAD
(or the runner's matching `PJSDAS_RELEASE_COMMIT_SHA`) and captured/restored by the
build gate. Pair reports distinguish original-checkout vs materialized-source
identity and include manifest hashes.

## Clean checkout preparation

Use Linux, Node **24**, npm, Git, Bash, `flock`, and GNU `sha256sum`. The checked-in
workflow is the reference for this toolchain. Install **both** committed lockfile
sets in the new checkout (not symlinks to another project's `node_modules`):

```sh
npm ci
npm ci --prefix tests/sql
node scripts/validation/workspace-rows-integration-source-contract.mjs
node tests/sql/workspace-rows-historical-sources-check.mjs
node tests/sql/workspace-rows-historical-sources.mjs materialize
```

No fixture resolver installs packages or fetches sources. Historical closures
inherit dependency resolution from this checkout's `node_modules`; their package
and lockfile bytes are verified as part of the old graph. External imports are
listed in each manifest (`@modelcontextprotocol/server`, `ai`, `parse5`, `zod/v4`
and Node builtins for the full API/scoped closures). `tsx`, TypeScript, Vitest and
esbuild come from the root lockfile; `pg`/PGlite come from `tests/sql/package-lock.json`.
The old API/scoped workers are independently bundled with esbuild; external npm
packages are deliberately shared at the identical locked dependency versions.

The default cache is `.ta-validation/history/`, ignored by Git. Optional
`TA_HISTORY_CACHE_DIR` must stay inside this checkout so package resolution is not
redirected to an unrelated installation. For an available **original** historical
checkout, `TA_HISTORY_R0P_CHECKOUT`, `TA_HISTORY_HISTORICAL103_CHECKOUT`,
`TA_HISTORY_READER_CHECKOUT`, or `TA_HISTORY_SERIAL_CHECKOUT` selects it instead.
An override must have the exact provenance HEAD, a clean tree, and matching
closure-file hashes. It does not relax source assertions.

## PostgreSQL/PostgREST gates

Provision an existing, local PostgreSQL **17** installation and a verified official
PostgREST binary. The current repository workflow pins PostgREST **v14.5** and
its archive SHA-256. Reuse that exact pinned download/verification procedure;
do not substitute an arbitrary executable or fetch an unpinned latest binary.
No production credentials are needed. PostgreSQL runs only on loopback under the
invoking non-root user, with fresh disposable fixture databases/roles.

In an exclusive local validation window, from a **clean, committed** checkout:

```sh
TA_INTEGRATED_VALIDATION_WINDOW=authorized-by-parent \
TA_INTEGRATED_SOURCE_SHA="$(git rev-parse HEAD)" \
TA_POSTGRES_BIN_DIR=/absolute/path/to/postgresql-17/bin \
TA_POSTGREST_BIN=/absolute/path/to/verified/postgrest \
bash scripts/validation/run-workspace-rows-integration-gate.sh pair clean-001
```

Use a unique run ID for every gate. Outputs default to `.ta-validation/runs/` or
an absolute `TA_INTEGRATED_EVIDENCE_DIR`. Each gate creates its own directory and
PG data directory, refuses overwrite/takeover, snapshots the exact tracked source,
checks source before/after and stops only its owned cluster. The shared lock is
unchanged by default; co-located schedulers must use the same lock and serialize
these fixed loopback ports (55634/55635 for the full pair, 55439 for standalone
resources; other retained fixtures have their own fixed local HTTP ports).

`matrix` explicitly enables the bundled serial fixture; `narrow-reader-only`
explicitly enables the reader fixture. Standalone Stage-A's previous optional
rollback behavior is retained, so this packaging does not silently enable extra
automatic workflow gates. `pair` requires all **81 distinct cases**, zero in-flight
proxy requests and successful terminal cleanup; tail runs cannot be added to a
failed prefix to claim a full pass. All deadline, grant, manifest, original-byte,
receipt, Undo, one-commit and no-replacement-admission assertions remain.

The static composition contract separately checks all 1,488 original baseline
files, all 12 resource imports, 61 original SQL files and the exact candidate SQL
set. The five already-accepted durable-v2 source evolutions have explicit original
and new hashes; portability edits are separately enumerated. New algorithm or
catalog changes require an explicit reviewed contract update, not an exemption.
The preserved pair harness/scenarios/worker hashes and full resource-harness
normalization guard against removing assertions during path cleanup.

## Reporting and maintenance

Report source-only checks, install, compilation, unit, database, HTTP, full pair
and hosted/product acceptance separately. A dependency download failure is an
installation failure, not a runtime pass. Do not publish raw run directories or
reuse private historical evidence as clean-checkout results. Publish only reviewed
synthetic summaries with the exact final candidate and fixture manifest hashes.

To maintain a historical fixture, obtain the original source bytes through an
authorized source, verify both recorded SHA-256 and Git blob identity, add only
needed old text files to `blobs/`, and review the catalog/profile changes. Do not
regenerate historical expectations from current implementations. Updating a
current runtime to support reclamation or a new protocol must not mutate these
old producers/readers; review its composition hash changes and rerun the affected
clean-checkout gates separately. No workflow changes are part of this package.

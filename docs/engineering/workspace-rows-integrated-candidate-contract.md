# Local integrated candidate: recovery + resource transactions

## Scope and immutable provenance

This is a **default-off source integration and verification candidate**. Draft
source publication is not production migration, activation, or release acceptance.
The older v1 mechanism documents remain historical contracts; the current v2
semantics and validation limits are recorded in
[durable attempts v2](workspace-rows-durable-attempts-v2-contract.md).

Base R1p: `c8719d17ee748e830d27881a4e96e5c96460a4c7`.
The resource chain is imported in order with `cherry-pick -x`:

1. `3d12ae12d8f22ca2d9cb9a32fb1a92705b70f62e` — eight independent files;
2. `6a1c47a` — four original-public-RPC integration files;
3. `514ab95` — retain original 8 MiB negative / fresh 16 MiB positive cases;
4. `12fa444ff66acd370afe350ff61419569665dac3` — representation inventory/peaks.

The original integration imported twelve resource files. The later durable-v2
candidate intentionally changed five existing runtime/client files and added a
versioned SQL fixture. Those evolutions are **not** a blanket exception:
`tests/fixtures/workspace-rows-history/composition.json` records original and
accepted SHA-256 values, exact paths, and the reason for each change. The static
source contract rejects any further change until its source contract is reviewed.
The reproducibility-only runner/docs edits are listed separately from algorithms.

All original SQL inputs remain byte-identical. The static contract also preserves
the complete original harness normalization and no-re-admission assertions. Its
provenance SHA values do not require unpublished Git objects to execute. Historical
sources use [independently hashed source closures](workspace-rows-reproducible-validation.md),
not a copy of the current producer/reader. None of this establishes runtime PASS:
clean-checkout runtime, database, HTTP, and independent pair gates are **NOT_RUN**
until explicitly executed on the final frozen candidate.

## Distinct tests; never combine their PASS labels

| Gate | Actual scope | Does not establish |
|---|---|---|
| `focused`, `tsc`, `unit`, `build` | Exact merged source; build includes frontend and actual API/scoped bundles | Hosted deployment or unchanged historical failures |
| `resource-pg` | Original standalone normalized adapter's 21 native groups | RPC reclaim or compatibility of that adapter with RPC peak columns |
| `resource-rpc` | Original 37 baseline + 13 resource groups through actual API/scoped factories | Three saved modes with resources ON |
| `resource-rpc-audit`, `resource-rpc-pages` | Original complete audit/adversarial suites, then original resource proof | Resources ON during the preceding audit suite |
| `resource-recovery-integrated` | Resource ON × API/scoped × inline/fragments/pages × forward/original Undo; cold integrated recovery and replay | Historical-103 provenance or R0p execution |
| `resource-recovery-r0p` | Same fresh matrix, actual independently bundled fixed R0p recovery | Hosted fallback, minutes-long recovery, or every disconnect boundary |
| `pair` | New full 81-case independent pair, fixed R0p / integrated B / real historical103 producer | Resources ON, product deadline acceptance, or repair of old pair failures |
| `install` | Two resource SQL files atomic install/late-failure rollback, public metadata/ACL/definition and lock order checks on fresh fixture | Full static production migration or existing inventory enrollment |
| `narrow-reader-only` | Original `9288be3` reader-only compatibility regression | Complete writer/large-audit fallback; full fallback is `a8c13da` |
| `matrix`, `guard-equivalence`, `equivalence`, `finalizer-plan`, `oldlarge`, `oldv3` | Retained original native regression scopes | Production load/physical capacity/hosted proof |

### Resource ON joint recovery contract

`workspace-rows-integrated-resource-recovery-native.mjs` retains the original
baseline assertions and calls a new independent proof instead of replacing any
original resource test. The original resource runner remains a separate gate.
The new harness compiles the actual original API/scoped worker from the local
integrated tree and the fixed full R0p tree
`a8c13dade102691b6562170a4d3d55d3ef724109`; no adapter or grant mock is injected.

Each target gets a **fresh database**. Each API/scoped family exercises the three
saved modes, first interrupted after original durable admission and then after
the original protected Undo metadata append. New admission is explicitly stopped
on recovery. The proof checks one initial admit, no replacement admit, the full
original encoded row/binding/authority/absolute deadline, manifest and actual
stored protocol, exact V5 receipt/projection/compensation, revision/CAS, held
capacity, per-representation original-table inventory, owner/global totals,
original audit retention, and actual consumer receipt/replay output.

Inline scoped data uses the original legal compact-ID 2,050-action fixture;
fragment/page scoped data retains original long IDs. The prepared-intent decoder
uses the existing 8 MiB decoded bound. Positive reservations are explicitly
**16 MiB before admission**, owner 32 MiB and global 264 MiB, exactly the prior
resource proof's synthetic policy; twelve held admissions total 192 MiB. No
existing admission is enlarged. The original 8 MiB capacity refusal is still a
mandatory negative case in `resource-rpc`, not weakened or relabeled.

RPC reclaim remains **unsupported**. Its historical peak constraints are not
maintained by the independently tested `PgResourceReservations` wrapper, and
release would lower held below historical peaks. Never connect that wrapper to
this RPC schema or transfer its standalone reclaim PASS to the RPC path.

## Atomic install and read-before-write order

The installation rehearsal first creates the original synthetic baseline, then
installs the two unchanged resource files under **one transaction**. An observer
must see only original function preimages until commit. A deliberate late SQL
error rolls back both the sidecar schema and all patched functions. A separate
successful transaction must keep original public RPCs, owners, ACL, invoker
status and search paths, with no seeded policy/enrollment. Structural checks
retain original grant → global → owner → reservation → head/stage ordering on
intent reads/admission and resource observation before history head access.
Observed two-session race tests remain separate dynamic evidence.

**This still uses fixture-only dynamic catalog patching.** It is not a static
production package, and does not validate preStageA → full activation. A
production package requires exact private preimages, full dependency/owner/ACL
transport, static reviewed INVOKER definitions, original legacy reader fences,
existing inventory migration, privileged acceptance, rollback/hosting and
specific authority. None is inferred from this rehearsal. Do not commit private
catalog values or credentials to this source or synthetic fixture.

## Retained failure and product gates

* R1p's two original 5,000 ms focused failures remain unattributed even though
  its separate full unit suite passed. A single diagnostic non-reproduction is
  not a fix.
* The old full page-ready pair has 55 PASS and original wrapper-deadline failure
  at case 56; a separate tail has 25 PASS. **55 + 25 is not 81 PASS.** Its first
  run also retains 14 PASS then deadline failure. New integrated results cannot
  retroactively turn any old failed run green.
* The earlier v1 baseline persisted a 10-second admitted-intent lifetime. That
  historical protocol remains unchanged for old encoded bytes. The current
  [v2 contract](workspace-rows-durable-attempts-v2-contract.md) separates immutable
  intent lifetime from each database-fenced attempt's unchanged maximum ten
  seconds. Real one-minute recovery and grouped safety checks passed on the
  runtime source before source-only packaging. This does not turn old failures
  green or establish the complete final packaged native/pair matrix as passed.
  Mixed-load readability/deadline failures remain open; no budget was enlarged.
* Original descriptor statement timeout and narrow admitted-deadline failure
  remain; no retry-until-pass, larger timeout or instrumentation attribution.
* Complete-history 32 MiB, core-compensation 1 MiB, incompressible atomic-intent,
  2 MiB response, 65,536-byte fragment and indexed-identifier limits remain.
* FS spool/reaper/process death, reclaim/retention/fairness, physical
  heap/TOAST/index/WAL/RSS, global throughput, regional RTT and production load
  remain open. Logical counters are not physical capacity.
* Production SQL/ACL, credentials, providers, resource/budget policy, merge,
  deployment and hosted-pair acceptance remain separate gates. Draft source
  publication and existing synthetic CI do not authorize production changes.

## Frozen execution

No heavy tests run during source packaging. Obtain an exclusive local test window,
install the two committed lockfile dependency sets in a clean checkout, and provide
verified PostgreSQL/PostgREST binaries as described in
[reproducible validation](workspace-rows-reproducible-validation.md).

```bash
TA_INTEGRATED_VALIDATION_WINDOW=authorized-by-parent \
TA_INTEGRATED_SOURCE_SHA="$(git rev-parse HEAD)" \
TA_POSTGRES_BIN_DIR=/absolute/path/to/postgresql-17/bin \
TA_POSTGREST_BIN=/absolute/path/to/verified/postgrest \
bash scripts/validation/run-workspace-rows-integration-gate.sh <gate> <unique-run>
```

The runner sanitizes inherited product/test selectors, uses the shared flock,
creates a fresh owned local cluster per gate, records exit codes, refuses overwrite
or cluster takeover, verifies tracked source before/after, and checks cleanup.
Its source manifest is freshly derived from the exact clean checkout, not a
private evidence directory. The default output is ignored `.ta-validation/runs/`;
`TA_INTEGRATED_EVIDENCE_DIR` may select another absolute output directory.
The build-only generated release identity is captured and restored to its exact
prebuild tracked contents. No workflow or automatic CI policy is changed here.

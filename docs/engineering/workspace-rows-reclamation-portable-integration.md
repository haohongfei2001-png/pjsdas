# Private portable reclamation integration

This private candidate composes source packaging
`dce4ed0fb14db3af45c1cbfc4ebcc6a5203f41ba` with the exact reclamation implementation
`9796fd71bf2f5439e760f0db4508d45479232db0`, both descending from
`88c369b52ec038df1657a8ed89685fd1083f0eba`. It does not change the separately frozen
Draft publication package or any workflow, production resource, configuration,
credential, quota, deadline, activation or deployment.

## Exact source boundary

The reclamation delta consists of eleven files. Its existing runtime change is
only `gateway/workspaceRowsResourceAccounting.ts`; its SQL is the additive
`tests/sql/candidates/workspace-rows-resource-reclamation.sql` overlay. Both are
retained byte-for-byte from 9796fd7. The existing pure accounting test evolves with
the same exact upstream source. All other runtime/SQL files remain unchanged.

No path in that eleven-file delta occurs in any of the four historical dependency
closures. Thus all fifteen old-source blobs, file catalog and four historical
manifests are retained byte-for-byte. If a future integration touches a shared
historical path, preserve its exact old bytes in a hash-pinned blob; never change
historical expectations to match the new implementation.

`composition.json` retains all original baseline/resource/SQL hashes. Two exact
resource evolutions now identify 9796fd7 and their old/new hashes; a separate
integration manifest pins all eleven upstream files. Only the two declared native
runner files have mechanical local changes (historical source selection and
same-checkout dependency defaults). No algorithm evolution is mislabeled as
portability, and no glob or blanket source exemption is introduced. The additive
SQL file is explicitly hash-pinned in the exact catalog set.

## Historical runner defaults

`tests/sql/reclamation/historical-source.mjs` uses this checkout's independently
pinned R0p resolver by default. The gate materializes and verifies the actual old
API/scoped implementation, builds the original historical intent worker, and
checks the historical source before and after use. Its report distinguishes
`same-checkout-source-closure`, an explicitly configured materialized source, and
an explicitly configured original Git checkout.

Legacy `TA_R0P_SOURCE_ROOT` remains an optional override, verified against this
checkout's manifest. A supplied `TA_HISTORY_RESOLVER_MODULE` must be byte-identical
to the local reviewed resolver and must accompany an explicit source root; it is
checked as data, never dynamically executed. The default path requires neither
of these variables or any sibling worktree. Existing optional original-Git
checkout overrides retain exact provenance HEAD and clean-source requirements.

The native fixture defaults `pg` and the cold-worker `tsx` loader to this
checkout's dependencies. Explicit `TA_V2_SQL_DEPS`/`TA_V2_TSX` remain supported for
controlled direct runner use. The aggregate runner sanitizes those inherited
selectors and supplies same-checkout defaults instead. Existing locked dependency
packages may be reused for a source-cleanroom test, but this is not fresh
installation or package supply-chain verification.

## Execution

Use the prerequisites in [reproducible validation](workspace-rows-reproducible-validation.md).
The following source-only checks do not start a service or import an application:

```sh
node scripts/validation/workspace-rows-integration-source-contract.mjs
node tests/sql/workspace-rows-historical-sources-check.mjs
node tests/sql/reclamation/historical-source-check.mjs
```

The existing integration runner now also accepts `reclamation-pure`,
`reclamation-install`, `reclamation-basic`, `reclamation-terminal`,
`reclamation-control`, `reclamation-faults`, `reclamation-locks`,
`reclamation-historical`, `reclamation-compat-v1`, and `reclamation-compat-v2`.
No automatic CI trigger or policy changes. Obtain the exclusive local PG/CPU
window before native gates, then use a clean exact commit and a unique run ID:

```sh
TA_INTEGRATED_VALIDATION_WINDOW=authorized-by-parent \
TA_INTEGRATED_SOURCE_SHA="$(git rev-parse HEAD)" \
TA_POSTGRES_BIN_DIR=/absolute/path/to/postgresql-17/bin \
TA_POSTGREST_BIN=/absolute/path/to/verified/postgrest \
bash scripts/validation/run-workspace-rows-integration-gate.sh reclamation-historical unique-run
```

The native gates own a fresh cluster on PostgreSQL loopback port 55776 and
PostgREST port 55777. Original 10-second statement/attempt limits, 2,184 KiB work_mem,
fixture sizes, immutable admitted reservations and all safety assertions remain.
The runner freezes tracked bytes, checks before/after source identity, refuses
output overwrite/cluster takeover, checks database/role cleanup and stops only
its owned cluster. Historical bundles remain private run artifacts, not source
fixtures or publishable dependency packages.

## Evidence boundaries

The original 9796fd7 gates consumed an external dce4ed0 fixture. They do **not**
establish an end-to-end cleanroom pass for this integrated candidate. Source-only,
compile-only, pure unit, typecheck/build and real PG/HTTP historical execution must
be reported separately against the final integrated commit. At preparation,
these integrated runtime/native gates are **NOT_RUN**. Prior timeout/deadline and
exit137 observations, actual browser/IndexedDB blockers, filesystem lifecycle,
physical storage, production ACL and hosted acceptance remain unclosed.

## Integration with the published consumer recovery candidate (2026-10-27)

This integration was prepared locally from published snapshot
`fc86423646f520fd6d486ca97177ffde87800352`, tree
`c39d908377cb8bb2921af2d841a8d628a750c136` (local equivalent `f72fc012`),
and applies only the `dce4ed0..f315493` reclamation delta. It does not replace
or rerun the frozen mounted-consumer gate. Earlier GC work was kept private;
routine source-only publication to the existing Draft PR is now authorized under
the standing project instructions and continued-development request. Production
SQL execution, activation and deployment remain unauthorized and have not occurred.

The upstream accounting implementation, additive SQL overlay, contract, cold
worker, control mathematics, source helper, installer and two product unit files
remain exact upstream bytes (nine of eleven). The same two native runner paths
are explicitly adapted for local lifecycle correctness. An owned observer's
transaction and session advisory locks are released before draining HTTP which
may be waiting on them; direct fixture RPCs now participate in that drain.
PostgREST startup failure is tracked through `error` and `close`, including an
ENOENT with no successful process ID. All cleanup steps remain independent after
diagnostic I/O failure, with terminal database/role/process checks and a separate
cleanup summary. The original private raw diagnostics are still private and are
not an authorized publication artifact. Trust-loopback authentication, local
roles, public-only RPC transport, 10-second deadlines, work_mem, budgets and every
original product scenario/assertion are unchanged.

`finish-run.mjs` records final PASS only after owned cleanup and source verification;
primary, cleanup, source and evidence failures still cause failure. The new
`reclamation-lifecycle` gate independently exercises spawn ENOENT, a deterministic
private diagnostic-write failure, and actual public HTTP waiting on an owned
observer lock during cleanup. These three fixture checks and the six finalizer
unit tests are **not** additional product GC scenarios. Their three source files
are separately hash-pinned as runner additions, not attributed to upstream GC.

The current published snapshot already failed the older static composition check
on nineteen previously published paths. Their individual original hashes remain
unchanged, prior accepted evolution records are retained, and exact current hashes,
local source commits, published snapshot identity and reasons are now registered.
The current publication-only documentation evolution is preserved. This does not
change the original baseline, SQL preimages, historical closures or pair assertions,
and is not a blanket source exemption.

New integrated evidence must identify its own frozen commit and combine result
status, process exit, cleanup summary, final cluster inventory, successful owned
PG stop and unchanged before/after source. Historical `f315493` passes are not new
integration evidence. Reclaimed control remains charged: H = occupied = present
= C > 0, H + L = R. Empty owned fixture databases/roles after teardown must never be
confused with zero retained control or physical disk reclamation. Production ACL,
physical lifecycle, old unclassified failures and full-v2/browser acceptance remain
separate.

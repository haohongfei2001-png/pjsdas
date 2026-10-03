# Discovery Profile management v5: source-only contract

Current integration note (2026-10-03): source runtime/consent wiring now exists behind the default-off scoped consumer switch. The original slice-stage description below is historical; live activation and real installed-host acceptance remain pending. See [current delivery](../consumer-management/plugin-delivery.md) and [exact migration plan](../consumer-management/activation-migrations.md).

This is a separate `workspace.discovery-profile.manage`, consent-version-5 capability. It is not registered in the production MCP catalog or owner consent routes. It issues no grants, applies no live migration and changes no provider, credential, source cadence or paid-search budget. v2–v4 scopes keep their existing meanings.

## Exact, bounded profile management

- Read returns only the owner-scoped raw profile, effective defaults, configured state and canonical SHA-256 fingerprint. It explicitly uses the raw transactional store rather than a normalized projection.
- One typed patch or reset per request, stable command identity, observed base revision and exact current profile fingerprint. All 13 existing writable fields are covered: role queries, preferred locations/location notes, minimum compensation, role types, location policy, two score thresholds, result allowance, must-have/exclusion/strength lists and notes.
- Required lists/text clear with `[]`/`""`; optional fields also allow explicit `null` removal. Account/client identity, version, update time, unknown keys, budget/provider/security settings and empty patches are never caller-writable.
- Complete resulting rows use existing validators and limits. Untouched raw whitespace, list order/duplicates, absent optional fields and bounded forward-compatible metadata remain unchanged. A patch does not normalize the whole profile or manufacture unrelated defaults. No-op requests leave timestamps and history alone.
- Reset removes the explicit row and yields an unconfigured effective default. Restore uses exact owner-ledger compensation, requires its fingerprint, preserves newer unrelated data and refuses newer profile changes. It never deletes discoveries made under a later profile.
- Individual raw profiles are bounded to 256 KiB, depth 32 and 65,536 JSON nodes. Compensation allows two independently valid raw rows plus bounded envelope overhead. Planning v4 likewise allows four valid rows plus its envelope; retained tests cover structural and byte boundaries.

## Grant, transaction and recovery

The adapter constructs its own authoritative executor and binds the first admitted immutable grant proof internally. The same owner/client/capability/version/UUID/revision must remain active during execution, retry and non-commit response release. Earlier scopes cannot authorize this operation. No generic RPC fallback is allowed after denial.

The service-role-only SECURITY INVOKER wrapper locks the exact grant and workspace in the same transaction as CAS/ledger mutation. SQL permits only `discoveryProfile` changes and append-only timeline additions, and preserves the complete previous timeline prefix. Ledger evidence and original facts are retained. Missing legacy data collections require a separate snapshot migration.

## Relationship to discovery and spending

A profile edit affects later scheduled runs and may make an already-enabled binding eligible once a source is due. Explicit roles/locations change query hints; candidate allowance changes bounded result counts. All profile fields, including notes and strengths, enter the discovery provider's model context when a separately authorized search runs. Any future live consent must disclose that data use.

A new run after reset stops as unconfigured. A run already in progress may already have consumed its approved model request; this change does not cancel or refund it. Before ingestion, the worker compares the exact starting profile fingerprint with the current profile on every attempt. On the transactional workspace path used by v5, atomic workspace CAS protects the check-to-write gap and a conflict rechecks the profile before retrying. The legacy Drive writer has only metadata prechecks and does not gain an atomic race-safety guarantee from this guard. If the current profile differs from the starting profile, obsolete results are skipped without another search or workspace mutation. Changing a profile is never approval to spend: the existing independent request-bound budget reservation remains required for normal and forced runs, and no production spend adapter is installed.

## Verification and activation gates

Synthetic fixtures cover every field, clear/reset/restore, absence/default distinctions, unknown metadata, no-op, malformed profiles, exact fingerprints, stale restore, denied v1–v4/foreign/revoked/regranted proofs, first-admission binding, mutation/read response bounds, raw legacy data, SQL privileges/protected-domain/history checks and actual gateway-to-SQL replay/restore. Worker fixtures cover reset, budget denial, prompt data/result allowance and in-flight patch/reset skip with zero external calls.

The hosted PostgreSQL 17 multi-session fixture checks protected-data contention and mutation-first/revoke-first/regrant-first ordering. PGlite alone is not concurrent-session evidence; record the exact hosted result before activation. Source migration `20261002211312_discovery_profile_management_v5.sql` depends on source v4 and v3 migrations, which are also inactive. Reconcile platform-recorded migration history and obtain separate explicit activation/consent before live use.

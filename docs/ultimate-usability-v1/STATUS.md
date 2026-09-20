# PJSDAS Ultimate Usability v1 — Canonical Status

Package: `PJSDAS-ULTIMATE-USABILITY-v1`  
Blueprint version: `1.0`  
Last revalidated baseline before registration: `main@bf0643eda139125868a9c697b81ff5ac5288a4f4`  
Product origin: `https://todayaction.com`

## Round state

| Round | State | Notes |
|---|---|---|
| UU-00 | **COMPLETE — DESIGN REGISTERED** | Docs-only registration/revalidation; no business code/data/config change |
| UU-01 | **READY** | Baseline Browser E2E closure complete; implementation not started |
| UU-02 | NOT_READY | Depends on UU-01 |
| UU-03 | NOT_READY | Depends on UU-02 |
| UU-04 | NOT_READY | Depends on UU-03 |
| UU-05 | NOT_READY | Depends on UU-04 |
| UU-06 | NOT_READY | Depends on UU-05 / shared intake |
| UU-07 | NOT_READY | Depends on shared intake/read models |
| UU-08 | NOT_READY | Depends on platform-neutral contracts |
| UU-09 | NOT_READY | Final canary/release |

## Revalidation findings

### Confirmed current production architecture

Canonical Round 6 states:

- transactional Supabase/PostgreSQL workspace is authoritative;
- owner-only allowlist is active;
- canonical Web/API origin is `https://todayaction.com`;
- Google Drive is backup/export/portability;
- legacy GitHub Pages remains bounded migration/recovery origin;
- `v1.1.0-rc.1` remains immutable prerelease;
- final `v1.1.0` publication is a separate owner decision.

The release plan is currently **DISARMED**:
`publishOnProductionSuccess=false`.

### Documentation drift found

Root `README.md` still said production remained on legacy Drive authority. UU-00 corrects this
documentation only; it does not migrate or switch data again.

### Baseline browser blocker — CLOSED

The registration baseline `main@bf0643eda139125868a9c697b81ff5ac5288a4f4` had 30 failing Chromium
journeys in run `35496146452` after the decision-first UI change.

Bounded closure evidence:

- PR #95 changed Browser E2E journey expectations only; no business source, schema, data, config,
  permission, or release-policy change was made.
- all 30 failures were audited. The failures were historical UI journey assumptions: the retired
  Today heading/surface structure, the old five-item primary navigation, and the previous locations
  of Activity, manual capture, and the language switch. No separate business-code regression was
  identified in this bounded audit.
- PR head `3394ced2c4aa6dfd06e8fbf4fcadb7068b830b06`: `ci-build` and Chromium passed.
- merged main `0d621c122457321657fa8f560768117d5e5fb0f6`:
  - `ci-build` run `35503041344`: success;
  - Chromium run `35503041342`: success;
  - GitHub Pages / deploy run `35503041331`: success;
  - Production Self-Test run `35503119103`: success;
  - release workflow run `35503130027`: success and publication remains disarmed.

This closes the pre-UU-01 baseline blocker.

## Next authorized work

UU-01 is **READY but NOT STARTED**.

The next implementation execution may handle UU-01 only, under the package one-round protocol.
It must re-read remote `main`, this status, the frozen blueprint/amendments, and
`rounds/UU-01.md` before changing domain/schema code. Do not skip ahead to later rounds.

## Scope evidence

UU-00 plus the bounded baseline closure changed documentation and Browser E2E tests only. They did
not:

- modify business source code;
- alter schemas/database/config;
- migrate workspace data;
- enable Gmail/Tasks/Discovery permissions;
- change release-plan publication;
- publish a release;
- broaden external-action authority.

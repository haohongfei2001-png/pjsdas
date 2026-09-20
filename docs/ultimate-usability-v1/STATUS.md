# PJSDAS Ultimate Usability v1 — Canonical Status

Package: `PJSDAS-ULTIMATE-USABILITY-v1`  
Blueprint version: `1.0`  
Last revalidated baseline before registration: `main@bf0643eda139125868a9c697b81ff5ac5288a4f4`  
Product origin: `https://todayaction.com`

## Round state

| Round | State | Notes |
|---|---|---|
| UU-00 | **COMPLETE — DESIGN REGISTERED** | Docs-only registration/revalidation; no business code/data/config change |
| UU-01 | **BLOCKED — BASELINE BROWSER E2E MUST BE CLOSED FIRST** | Do not start schema/model implementation while required browser suite is red |
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

### Baseline browser blocker found

For `main@bf0643eda139125868a9c697b81ff5ac5288a4f4`:

- CI: success;
- GitHub Pages: success;
- Production Self-Test: success;
- Publish workflow: success/disarmed;
- **Browser E2E: failure** — run `35496146452`.

The failure is not treated as a transient environment issue. The suite reports 30 failing Chromium
journeys after the recent decision-first UI change. Example:

- `e2e/todayReasonI18n.e2e.ts` still expects heading “今天只处理下一步”, which the new Today no
  longer renders.

Other failed journeys also encode historical surface assumptions.

UU-00 is not authorized to modify tests or business code, so this debt is recorded as the blocker
between UU-00 and UU-01.

## Next authorized work

The next implementation round is **not yet READY**.

Before UU-01, execute a bounded baseline-closure task that:

1. audits the 30 Browser E2E failures;
2. updates only stale UI journey expectations where the new behavior is already the intended
   product behavior;
3. identifies any genuine regressions separately;
4. restores required Browser E2E green on current main;
5. does not begin UU-01 domain/schema implementation.

After that closure is green and committed, update this file to mark UU-01 READY.

## Scope evidence

UU-00 changed documentation only. It did not:

- modify business source code;
- alter schemas/database/config;
- migrate workspace data;
- enable Gmail/Tasks/Discovery permissions;
- change release-plan publication;
- publish a release;
- broaden external-action authority.

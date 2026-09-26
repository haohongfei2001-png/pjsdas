# TA-01 pre-merge receipt

Status: TARGETED_VERIFIED / FULL_STABLE_HEAD_GATE_PENDING / NOT_DEPLOYED.

## Writer and scope

Sole writer: PR #169, explicitly authorized by the owner on 2026-09-26 after parking #164. PR #164 remains open at `b67785ebb55b81a5c28e72eff303785a2b41249f`; no overlapping files, recovery trigger, merge, DDL or credential changes were made.
Baseline remote main: `153d8ccb6201e33cd1c9a09a0d7bf84a7cf0f079`.

## Exact targeted candidate

`50708bc31d904ea560903aa0dcfac3e0dc51e460` implements the visible TodayAction spelling, three-part A logo, private-safe static route titles, favicon/touch/icon/manifest integration, static route fallback and production-build asset checksum verification. The pinned cloud export replaced the handoff PNG/ICO encodings; the five source SVGs and immutable docs references retain their original bytes.

| Gate | Evidence | Result |
| --- | --- | --- |
| Asset rebuild, SVG resource rejection, Apple opacity and maskable safe circle | [Brand Gate 36222179123](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36222179123) | PASS; exporter reports no byte differences |
| Root and historical /pjsdas/ production builds and Chromium readback | Same run, 3 tests per base | PASS, 6 total |
| HTML-before-JS title, deep links, local icon MIME/actual bytes/decode/dimensions, 16/32/48 ICO, manifest resolution | Same run | PASS |
| Visible name, capture accessible name/focus, three entries, legacy language key, 320/360/390 at 200% text, self-owned consent page | Same run | PASS |
| Desktop/mobile and original 16/24/32/48 pixel favicon/light-dark/maskable crop screenshots | Same run artifact; visual review in current task | PASS for automated Web render; production/device not inferred |
| All unit tests and TypeScript | [CI 36222179131](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36222179131) | PASS (draft inner loop) |
| Cloud real VoiceOver and settled offline-draft visual | [VoiceOver 36222179156](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36222179156) | PASS |
| Isolated read-only fallback | [Rollback 36222179086](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36222179086) | PASS |

## Remaining frontier

The following documentation-only closure commit leaves the tested runtime/assets unchanged and triggers the existing ready-PR full CI/Browser boundary. Full stable-head gate, merge/exact-main and production readback are pending; this receipt does not claim completion or deployment. Release publication remains disarmed (`publishOnProductionSuccess: false`); package version and protocol identities are unchanged.

Actual iPhone installation/old icon refresh, owner private workspace/real account canary, third-party OAuth/connector branding and formal trademark clearance remain DEFERRED.

## Stable-head boundary finding

At `6f023367eda821da9f1459c70e52ad9da2df323d`, full CI, Brand Gate, Firefox/WebKit matrix, VoiceOver and read-only rollback passed. [Browser E2E 36222456522](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36222456522) passed 79 journeys and failed the new icon path assertion: the Vite dev HTML transform prepended `/pjsdas/` again after `%BASE_URL%` interpolation. Both production builds passed; this was diagnosed from the exact received URL, not retried unchanged. The corrective candidate uses root-absolute public asset links, which Vite rebases for development and build, and checks every initial HTML icon/manifest URL against the configured base. Stable corrected-head gates remain pending.

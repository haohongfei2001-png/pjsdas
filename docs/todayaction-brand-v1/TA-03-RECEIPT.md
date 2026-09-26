# TA-03 production brand closure

Status: IMPLEMENTED / ANONYMOUS_READBACK_PENDING.
Exact runtime baseline: TA-02 main `4b9ca7dd3fa973ee92b0781f62bc5ac8f666f68d`, tree `79a466bca107d2ded67ba10070f89bcaa6121721`. TA-01/TA-02 full stable gates and actual exact-main deployment/read-only/Live Visual passed; receipts linked in this directory.

This batch adds a read-only cloud runner that checks both canonical root and historical /pjsdas/ independently: initial HTML names and local icon links; all 17 committed brand assets against exact pinned SHA-256/bytes/MIME; ICO and PNG dimensions/browser decoding; manifest id/start/scope; known nested and unmatched fallback routes; route titles and accessible TodayAction identity; actual loaded local logo/icons and CSP errors; frontend/backend exact commit plus contract/migration hash.

PR runs read the already-deployed base main; post-Pages runs check the exact new main. These results are distinct. No production candidate claim is inferred from base readback. Requests use no account credentials and browser blocks non-read methods and Supabase calls. No workspace read/write, private email, recovery trigger or authentication decision is performed.

README's current prose/brand evidence links and RENAME_AUDIT are reconciled. Immutable handoff README/WORK_START/design sources and historical receipts remain unchanged. [EXTERNAL_GATES.md](EXTERNAL_GATES.md) records current repository About/homepage, provider/connector/device/native/legal/private frontiers.

Actual evidence will be recorded only after the runner completes. No new product/version/publication/permission/schema/storage/OAuth identity changes. #164 remains parked.

## First actual anonymous readback

[Run 36225692136](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36225692136), source candidate `4ccf27e85dcf523ebdb6c8be725e7b14f7a21c17`, read deployed **base main** `4b9ca7dd3fa973ee92b0781f62bc5ac8f666f68d`: 2/2 tests PASS.
- Both targets: all 17 pinned assets match exact SHA-256 and bytes; MIME/ICO/PNG/browser image decode, manifest id/name/start/scope, initial HTML, local icon paths, nine functional/nested/unmatched routes, Chinese static titles and single accessible brand pass.
- Canonical known routes return HTTP 200; unmatched returns the correct brand SPA HTML with HTTP 404. Historical deep links correctly return committed SPA 404 HTML and render functional routes; do not relabel those as HTTP 200.
- Canonical frontend digest `sha256:b539f8de0d84de61486b6a540ed1af8ad0ef2b073bbe0093a34c8d87298bd503`; historical `sha256:febc8cceaaa4e7ec94f56d7cc376c7f7f4ac494314df7f931631b7059c18b667`. Both release commit plus backend commit match exact base main; MCP/migration hashes match repository metadata.
- Both returned no CSP header on these HTML routes; local images decoded and zero CSP image errors. This does not claim a CSP was installed.
- Zero non-read browser requests, zero failed images; no credentials/private data used. Actual anonymous mobile screenshots reviewed for both targets.
- [Artifact 10900407468](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36225692136/artifacts/10900407468), ZIP SHA-256 `9ebae4fb3491457fdaca67397f704f46b1607f561b921fcb25f818d9a3919623`, retention14 days.

The stable runner additionally checks each origin's root initial HTML metadata and reloads every route. Documentation-only changes no longer rerun the unchanged full before/after gallery; UI source/fixture/config/workflow changes retain that gate.
This is actual deployed-base evidence; exact TA-03 merged-main readback is still required. Devices/native tab UI/provider/private/legal remain DEFERRED.

# TA-03 production brand closure

Status: ENGINEERING_COMPLETE_EXACT_MAIN / EXTERNAL_DEFERRED.
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

## Actual TA-03 merged-main proof

PR [#171](https://github.com/haohongfei2001-png/pjsdas/pull/171), candidate `8f200a54f73de4c3372a32b8691f587ecb326f7a`; test merge `c65a7776c17b65cbce1f622aecad7475c47cd666`; reviewed tree `0d7e802230cf75fdef7c4bf0bed82d9c53ba9987`.
Merged exact remote main `ae5ecfc78b101e581547f1553880d2dbadc1457d` has that identical tree.

Stable candidate CI 36225859307, Browser 36225859269 (80/80 first-pass), matrix 36225859319, UI Review 36225859298 and anonymous deployed-base 36225859301 SUCCESS. The strengthened readback covers ten routes per origin including root/install metadata and reloads.

Actual new main [CI 36226084489](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36226084489), [Browser 36226084444](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36226084444) SUCCESS; 80/80 first-pass, [matrix 36226084480](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36226084480), [Pages 36226084474](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36226084474), [read-only production 36226173012](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36226173012), [Live Visual 36226173022](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36226173022) and [anonymous exact brand readback 36226173027](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36226173027) SUCCESS.

The latter reads actual canonical and historical frontend `ae5ecfc78b101e581547f1553880d2dbadc1457d` plus canonical backend `ae5ecfc78b101e581547f1553880d2dbadc1457d`, all17 asset SHA/bytes/MIME per origin, ICO/PNG dimensions and image decode, stable manifest, ten route initial HTML/metadata/title/links/reloads/accessible brand, and zero non-read/failed-image/CSP-image-error observations. Native tab favicon selection is DEFERRED. Tested HTML has no CSP header. Both live artifact digests remain identical to the certified TA-02 runtime because TA-03 changes tests/docs/gates only.

[Actual readback artifact](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36226173027/artifacts/10900168428), SHA-256 `afa58f40903195f4ba3d25417d02b39ec73f6c358751a8736d6f1a3b463f5217`, retention14 days. [Archived public readback JSON](evidence/production-readback.json) and [capture provenance](evidence/PROVENANCE.json) persist the observed evidence in GitHub. Six native cloud JPEG screenshots preserve the decisive before/after, long job status, wrapped-header scroll and actual anonymous production views; original canonical/historical production captures are byte-identical and share one retained file. No invented/edited imagery or private content.

Actual private Reliability/CGR jobs were SKIPPED after qualification, and release creation SKIPPED. These are not private certification or publication. Real cloud VoiceOver in TA-02 passed separately from human/physical-device evidence.

## Final bounded evidence closure and stop

PR #172 carries only canonical final status/receipt, archived public evidence and a read-only Actions summary. It adds no product implementation or reference change. The runtime artifact/tree remains the reviewed TA-03 source. Final closure's exact main is the immutable `merged_commit_sha` of [PR #172](https://github.com/haohongfei2001-png/pjsdas/pull/172), with its exact-main/Pages/public readback receipt recorded in that PR conversation and Actions. A document cannot embed its own eventual merge SHA without another commit; this fixed PR identity resolves that final SHA directly.

The stored production observations above refer to the already verified ae5ecfc78b101e581547f1553880d2dbadc1457d; they do not falsely label future closure deployment as PASS. Final closure requires its own exact frontend/backend readback before execution stops. [External gates](EXTERNAL_GATES.md) remain DEFERRED. #164 stays open/PARKED at b67785ebb55b81a5c28e72eff303785a2b41249f, with zero trigger/merge/hotfix edits.

After bounded closure: STOP this package. Do not resume #164, reopen CGR/TSUI/UU-08/09, start native/offline/general-domain work, or enter another product line automatically.

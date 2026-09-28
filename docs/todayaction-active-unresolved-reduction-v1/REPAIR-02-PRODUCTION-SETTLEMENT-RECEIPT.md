# Repair 02 — bounded production settlement receipt

Status: **COMPLETE — one owner-authorized write consumed**.

Runtime: `a8d984059a2cc47b98d0f5abb7cb9fd84933f9a2` on 2026-09-28 UTC.
PR #185 P0 repair passed exact-main production verification before this write.
PR #186 changed documentation only; current runtime source is identical to the
verified P0 merge `c93a0fca9ef9b8eec8e234557f525445c0ef6b20`.

## Immediate read-only authorization baseline

Request **1374**, HTTP 200, workspace revision **841 → 841**, no workspace write.

| Metric | Value |
| --- | ---: |
| targeted / fetched | 60 / 60 |
| parserComplete / parserGap | 45 / 15 |
| unavailable | 0 |
| projectedSettled | 38 |
| projected outcomes | 38 ignored, 22 active_unresolved |
| activeUnresolvedBefore / projectedActiveUnresolved | 197 / 159 |

The target digest matches the original Repair 02 60-record cluster. Count 38
and every digest were passed exactly to the write authorization; no scope or
loose count comparison was used.

| Baseline digest | Exact value |
| --- | --- |
| bindingDigest | `ea80ddcf4b7cc105471348f770a37eac5f2da84d00004e3f516a8a77648f8624` |
| targetSetDigest | `4fbcd347aceb1a7d2a707739b53e5f7883594b0eaa2337e45263fd369c4899bf` |
| evidenceDigest | `85be01a7361fe42b239d90f186e3a81c9d5008b85bdc94e1a8ea72692a074f55` |
| settledSetDigest | `0890b24a465c9232701d8d6c7b8bcc8695704b2bebc98a878c1e6360715d5d69` |
| businessDeltaDigest | `9bb0f807417a52defa3c663e1879a6cf286456715dfe3b733705fb92c6ff249b` |

## Atomic commit

A single authorized POST, request **1375**, returned HTTP 200:
`status=committed, attempts=1, selectedCount=38`.
The handler reread workspace and Gmail evidence and reprojected inside that
request; the bounded retry path was not needed.

- CAS revision **841 → 842**.
- Command: `gmail:fragment-reprocess-write:841:1eer7f5`.
- Ledger status: **COMMITTED**.
- Committed: `2026-09-28T16:20:03.585704+00:00`.
- Exactly one settlement command exists in the production command ledger.
- Exactly 38 appended settlement resolutions, all `ignored`.

Normal Gmail automation continued and subsequently advanced revision to 843.
The ledger reports 73 affected timeline objects for the commit; these include
audit/evidence records and are not 73 settlements.

## Readback and preservation

Readback at revision **843**, compared with the full prewrite revision-841 snapshot:

- All **3,747** prior timeline rows remain byte-canonically identical.
- Missing prior rows: **0**; altered prior rows: **0**.
- 38 new settlement resolutions match the authorized outcome.
- Every non-timeline business collection remains unchanged.
- No application, action, process, schedule, reminder or open decision mutation.
- No historical ledger rewrite/deletion, permission/cursor edit or automation pause.

75 new timeline rows were present at readback, including subsequent ordinary
automation. Private snapshots and Gmail payloads remain outside the repository.

## Read-only idempotency

Request **1377**, HTTP 200, workspace revision **843 → 843** unchanged.

| Metric | Value |
| --- | ---: |
| targeted / fetched | 22 / 22 |
| parserComplete / parserGap | 7 / 15 |
| projectedSettled | **0** |
| activeUnresolvedBefore / projectedActiveUnresolved | 163 / 163 |

The 159 count was the immediate prewrite projection. Continued Gmail automation
added four active unresolved records before this verification. The current 163
is preserved as unresolved; this repair does not authorize broader settlement.

**No further production write is authorized by this receipt.** The overnight
one-write authorization has been consumed. Further production mutations require
a new explicit authorization.

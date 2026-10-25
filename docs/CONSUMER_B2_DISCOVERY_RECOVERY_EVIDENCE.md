# B2 Discovery recovery: truthful outcomes before live activation

Date: 2026-10-24 (Asia/Shanghai). Baseline: `58da37ee`.

This is an offline implementation batch, not A17 live-search acceptance. The
production entrypoint remains source-enforced OFF. No model/search requests,
production workspace writes, migration, credentials, permissions or budget changes
are part of this work.

## Corrected defects

1. A successful worker result was replaced with `failed` / `durableCommit: false`
   when the subsequent run-state telemetry write failed. The endpoint now retains
   the original run result, counters and durable receipt outcome. It reports
   `telemetryState: unconfirmed`, a bounded non-retryable warning and HTTP 207.
   `telemetryUnconfirmedUsers` counts that independent status-record problem.
   It does not submit another search or write failure telemetry over the result.
   A later normal tick consults immutable search progress and does not repeat
   already completed queries. `recorded` only means the telemetry write returned
   its expected acknowledgement; an unconfirmed write is not asserted absent.
2. When a successful query was followed by budget exhaustion in the same batch,
   committed partial results omitted the remaining sources from `skippedSourceCount`.
   Every unattempted source is now accounted. The limit remains binding; even a
   forced later tick does not increase the budget or repeat the original requests.
3. A claim write could be committed while its ACK or original receipt was lost,
   yet the first tick reported an ordinary failure and zero uncertain sources.
   That boundary now reports `DISCOVERY_SEARCH_RESULT_UNCERTAIN` immediately.
   Missing or inconsistent post-write receipt proof never admits an external call.
   Explicit CAS conflicts retain their known-conflict classification and bounded
   existing retry; authorization and scope rejections remain fail-closed.

## Verification

- New regressions were first observed failing on the baseline: five telemetry
  scenarios, one partial-budget source-accounting scenario and initial
  claim-uncertainty scenarios. Additional inconsistent-response-proof and known-CAS
  controls also pass.
- Focused integration: 82 tests across five suites passed before the final
  inconsistent-receipt regression was added; the final full suite includes it.
- TypeScript project check passed.
- Final full suite: 4,729 tests / 366 suites passed. Production build passed.
- Plugin package contract: 11 Python tests passed. Independent source review
  found no blocking regression; the suggested inconsistent-receipt case is included.
- A fresh dependency audit exposed Zod high advisory
  [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
  and two moderate Undici advisories. Official patched ranges were verified;
  only Zod (4.6.2 → 4.6.7) and Undici (7.29.1 → 7.30.1) are updated.
  The root Zod lower bound is now 4.6.7. No audit suppression, forced resolution
  or unrelated package upgrade was added. Final patched dependency audit: zero vulnerabilities; the full 4,729-test
  suite, TypeScript and production build were rerun successfully after upgrade.
- The ledger harness executes the actual worker and domain/receipt code with
  intercepted fetch routes. It is an isolated in-memory ledger, not evidence of
  live PostgreSQL lock behavior, real model quality or production search success.

## Remaining boundary

A17 still requires one genuinely authorized source-backed search and a subsequent
scheduled run, including account/funding proof and authoritative readback. Real
AI quality, production activation and owner-account end-to-end acceptance remain
unperformed. Do not translate these offline passes into a completed product or a
completion percentage.

## Explicit exclusion list follow-up

The bounded search-scope proposal parser previously kept “不要运营、销售” as
one literal exclusion. Consequently, neither “产品运营” nor “产品销售” was
excluded. Explicit Chinese/English list separators (、,，) are now split into
individual exclusions, matching the existing exact-title/add-title controls.
Prior criteria are preserved and duplicate terms are removed. This is not an
expansion into general natural-language interpretation; proposals still require
confirmation and do not persist or start automation by themselves.

Four failing-before/fixed-after regression inputs cover Chinese and English
commands and verify the proposal, save payload and actual quality gate together.
The allowed 产品经理 control still passes; excluded 运营、销售、客服 titles fail.

Local full follow-up verification: 4,733 tests / 366 suites and production build
passed. Remote required gates and deployment must be verified separately.

## Search-scope save admission follow-up

The explicit scope editor captured its save payload before awaiting persistence,
but left query, removal, criteria and refinement controls editable. On success
it cleared the draft, so edits made during the pending save could be lost while
showing success for the older payload. All editor controls now share the existing
save-in-progress admission: the existing “Saving…” feedback stays visible and
failure retains the original draft and re-enables editing. This does not change
the separate Tell composer or its continuous-input behavior.

Two isolated browser regressions hold an actual mocked command response and
verify editing/removal/closing admission, one submitted payload, and success or
failure recovery. Local Chromium could not launch because IPC socket creation
was denied by the execution environment; the normal escalation path also failed
at sandbox setup. These browser assertions are NOT locally verified. Required
remote browser CI must pass before integration; no environment restriction was
bypassed and no production data was used.

Local non-browser checks: 4,733 tests / 366 suites and production build passed.

## Interrupted confirmed-scope run follow-up (2026-10-25)

If one source had committed before the confirmed scope changed, the remaining
sources were safely skipped but the worker incorrectly classified the whole run
as `committed`; telemetry also cleared its error. A scope change detected inside
the commit boundary additionally discarded the interruption reason.

The worker now retains the skip reason and classifies a partly committed,
interrupted run as `committed_with_exceptions`. Telemetry preserves the skipped
count and bounded reason codes. Existing committed results and source accounting
are preserved; interruption is not mislabelled as a retrieval failure, no retry
is promised, and only an actually successful source advances `successAt`.
Normal no-work checks still clear their error. Isolated ledger regressions cover
both interruption boundaries and verify that old-scope retrieval/commit stops.
These are offline contract checks, not live A17 or provider-quality evidence.

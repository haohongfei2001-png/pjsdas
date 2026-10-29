# Synthetic stop-following browser component gate

Run only at the hardcoded dedicated `http://127.0.0.1:4187` origin (never a live origin). Before importing product storage modules, the entry enforces exact origin + explicit mock/transactional mode, and refuses any existing localStorage or IndexedDB unless the synthetic-harness ownership marker already exists. Reset preserves that marker, refuses unrelated keys/databases or a non-synthetic owner/session, and only clears known harness-origin keys. An anonymous existing IndexedDB is not taken over.

Run from this checkout:

```sh
VITE_PJSDAS_CLOUD_MODE=mock VITE_PJSDAS_CONNECTED_AUTHORITY=transactional npm run dev -- --host 127.0.0.1 --port 4187
```

Open `/pjsdas/tests/stop-following-browser-private/index.html`.

This imports the exact public `OpportunityDetailDrawer` with its production `asPage` prop
and `StopFollowingAction`,
real connected client/outbox/receipt-locator modules, native IndexedDB and native
Web Locks. Fetch is intercepted in this test document: only same-origin module
loads and synthetic `.invalid` origins are admitted. Synthetic backend changes
use the real domain reducer/compensation, but the HTTP response and auth setup
are test doubles. Responses intentionally use a full snapshot even when the
product request asks for delta-v1: this is narrow snapshot-projection component
coverage, not exact API/delta transport coverage. No app shell, server API, real PostgreSQL or production
allocator is exercised. `onCapture` is an explicit stub, not actual Tell UI.

UI setup buttons never invoke stopFollowing/Undo. Only actual product buttons
create those commands. Observations poll read-only product state and are shown
in the DOM so the supported CUA browser can inspect without runtime injection.

- Reset connected synthetic → Open actual job page → click 不再跟进 → check
  native storage, 1 command/commit, abandoned + skipped; click 撤销不再跟进 →
  check original target and revision 2. Reload between stop and Undo to test the
  real locator/receipt path. Opening/leaving/reloading must not add a write.
- Automated cases use Enter/Space on product controls and the actual page-back
  button plus browser Back/Forward. Tab/focus checks remain manual NOT_RUN.
  The production page is not a modal, so no Escape-dismissal or focus-trap
  behavior is claimed.
- Hold next command before synthetic commit, click product stop, then activate
  the same product control in a second same-origin tab. Release in first tab;
  native Web Locks should yield one command identity/one business commit. The
  automated peer activates its observed “核对原操作” UI, proves one actual held
  lock plus one queued lock, then asserts eventual receipt-read quiescence and
  a real one-second no-churn window. Receipt/read/auth diagnostics stay per-tab
  in memory; only command/Undo attempts are shared, so diagnostics cannot create
  storage-event feedback. Product storage events are never suppressed.
- While a command is held, switch A→B→A using setup controls. The app boundary
  here is synthetic; the real lease/component must not apply the old completion
  to the newly mounted component. Inspect pending/locator and business state;
  don't assert automatic recovery absent a mounted real scheduler.
- Shared-governance setup redirects product control to the stub Tell callback
  without any write. Toggle write-blocked/read-only to verify disabled/hidden.
- Local-only setup exercises actual semantic intake + native DB + local Undo;
  it must make no backend command request. Cross-reload local Undo is not promised.

Reset clears only known keys and the test workspace at this runtime-guarded
dedicated origin. Never use an origin containing real user data. The gate changes only synthetic test/configuration source; no product
runtime/SQL/permission change is made; no full durable-v2 acceptance is claimed.

## Source-bound automated cases

```sh
npx playwright test --config=tests/stop-following-browser-private/playwright.config.mts
```

Five serial retry=0 cases cover connected save/reload/original Undo/page-back/history,
native two-tab locks, blocked/read-only/governance no-dispatch, local-only Undo,
and an A→B→A stale completion. They record the exact checkout commit/tree and
PR head separately, require the PR head to be the checkout or a raw commit
parent, and verify every tracked file against its Git blob before/after. All
seven fixture files must be tracked. They attach synthetic observations,
and retain failures. No network routing/init-script/evaluate shortcut drives the
product controls. The synthetic console is explicitly positioned outside the
product page for test setup; its focus topology is not the full AppV8 topology.

**Evidence policy:** static TypeScript/bundling/discovery checks do not execute
the five browser cases. Browser acceptance requires actual case results on the
recorded source; failures and NOT_RUN stages remain visible. Local browser
execution was unavailable before this gate publication. Hosted results are
reported separately, never inferred from discovery or rewritten into a local pass.

## Browser network isolation

The automated config reuses the existing rejecting `mockCloudGlobalSetup` proxy
and `mockCloudTestUse`. Each fresh browser context installs
`guardMockApplicationRequests`, blocks ServiceWorkers, guards WebSockets and
HTTP (including worker requests), and asserts zero unexpected application
requests. Each test attaches guard results. The entry HTML additionally has a
self-only CSP (only local Vite WebSocket allowed; frames/workers/form submission
refused). `window.fetch` interception alone is not presented as an egress proof.
None of these isolation guards creates commands or replaces product UI clicks.

## Existing CI integration

The historical directory name is retained to minimize the publication delta;
these seven files are public synthetic fixtures, not a private-data artifact.
The gate needs no secrets, database, deployment, runtime flag change, or extra
service. Use the existing UI Review browser installation and isolation setup.
Upload this dedicated output immediately after the gate, so later browser
suites cannot replace its evidence. Run before production builds because the existing release-identity generation
changes a tracked file. The CI step supplies:

```sh
export TA_STOP_BROWSER_CHECKOUT="$(git rev-parse HEAD)"
export TA_STOP_BROWSER_TREE="$(git rev-parse 'HEAD^{tree}')"
# TA_STOP_BROWSER_PR_HEAD is supplied from github.event.pull_request.head.sha,
# or left empty for workflow_dispatch; it is not the merge-test checkout SHA.
npx tsc --project tests/stop-following-browser-private/tsconfig.json --pretty false
npx playwright test --config=tests/stop-following-browser-private/playwright.config.mts
```

Results and failure-only trace/screenshot evidence are written beneath the
dedicated root `stop-following-browser-results/` artifact boundary. Source
attachments contain exact public tracked hashes and synthetic observations only.
There is no automatic retry. Existing UI gates and budgets are unchanged.

## Retained first hosted failure

The first published fixture mounted the component's dialog variant without
`asPage`. All five hosted cases failed at the missing “不再跟进” entry before
reaching their action assertions. The production entry in `AppV8` uses `asPage`,
and the control exists only in that branch. This fixture repair selects that
unchanged production page branch and its `.job-detail-back` control; it does not
move the product control, relax an assertion, or certify the failed run.

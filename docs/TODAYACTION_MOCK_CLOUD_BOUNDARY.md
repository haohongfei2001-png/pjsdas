# Local development and mock CI cloud boundary

Development and test mode default to isolated `.invalid` backend/Auth origins and a separate mock Auth storage key. They never reuse a saved production Auth session. An existing account-bound cache with no complete mock provenance pauses before Auth or workspace children mount; its bytes remain in place. Use `VITE_PJSDAS_CLOUD_MODE=live` only for an intentionally live development session. Ordinary production builds retain their established endpoint, Auth persistence, refresh and account-isolation behavior.

Passive workspace reads pause while hidden or offline and resume on focus, reconnect or visibility. Concurrent passive reads can share the same account/session request. A command refresh always starts a new request; stale account/session responses cannot replace it. Outbox, CAS, conflicts and explicit user operations retain their existing guards.

## Mock browser gate

The existing hosted mock jobs first run `playwright.cloud-guard.config.mts` for their browser engines. Only a successful guard admits the application journeys. The process-local loopback proxy has no upstream client: unmatched HTTP, HTTPS CONNECT and WebSocket requests are rejected. It records host counts only. Browser launch options also apply to extra contexts; the guard explicitly probes pages, redirects, WebSockets and a service worker. A failure blocks the job, including when proxy adoption is missing.

Node-side Playwright API consumers use `mockApiTest` or `createMockApiRequest`. Their proxy cannot be overridden. Automatic redirects are disabled, including per-request overrides: an initial loopback request can otherwise retain its direct transport when redirected externally. Callers inspect redirect responses instead of following them. The guard preserves this regression.

Fixed visual baselines still use their original production-shaped synthetic fixtures and approved commit IDs. Routes fulfill those requests locally; the rejecting proxy covers unmatched traffic. Existing explicitly live configurations remain separate and do not collect the mock guard. Anonymous production brand readback runs after a successful main deployment, not automatically from a pull request.

## Evidence and limits

The API guard has run locally with real Playwright API contexts. Browser execution remains pending hosted evidence because this cloud environment rejects Chromium's required Unix socket. A zero forwarding counter describes this rejecting proxy only; it does not establish that every transport uses the proxy. Hosted browser proof must pass first.

The current ordinary browser suites' Node API consumers are the brand and isolation suites. Existing unit source-network tests inject request/DNS or fetch implementations. There is no global Node HTTP/DNS barrier: arbitrary Node clients and child processes are outside the proxy's guarantee. Package downloads, audit, browser installation and dry-run build tooling also have their own network traffic. Production canary scripts and live workflow configurations must not be run as a substitute for these mock gates.

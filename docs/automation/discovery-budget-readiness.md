# Managed discovery: truthful state and default-deny spending

This source-only change does not activate search, edit preferences, create budget approvals, change external GPT monitoring, or reuse any other project's budget.

## Existing behavior and activation inventory

The hourly scheduler already returns `not_configured` before search when the canonical discovery profile is empty. `checkedAt` marks a scheduler check; only a durably completed source run advances the historical commit timestamp. The UI previously described an enabled switch as operational discovery even when these prerequisites were missing.

A read-only aggregate inventory on 2026-10-02 found one active opted-in managed-discovery account and zero nonempty configured profiles. No application-specific approved monetary-budget/reservation path existed in this worker. The model setting had no override, so the source default was `perplexity/sonar` via Vercel AI Gateway. These observations are deployment-specific evidence, not fixtures or permanent assumptions; repeat the aggregate check before integration/activation. Do not inspect or publish users' profile contents or credentials.

Existing GPT monitoring ingestion and the core MCP tools remain separate and unchanged. They are not evidence that the managed paid-search worker has run.

## Request-time gate

Every model request, including force/probe paths, now requires a server-owned reservation adapter. The immutable request binds a fresh request ID to application `todayaction`, verified scheduler account, source, exact model/provider, input byte bound, 5000 output tokens and exactly one SDK request attempt. The receipt must bind every field, include a positive reserved USD amount and still be unexpired. Invalid/missing reservations prevent the model call. SDK automatic retries are explicitly zero. This does not constrain AI Gateway internal provider routing; a future pricing adapter must separately bound and reserve any routing/search fees.

**No production reservation adapter is wired.** The default therefore refuses paid generation. A synthetic adapter exists only in test fixtures to exercise downstream parsing/provider failures. An enabled automation switch, Vercel plan credit, HCLA allowance, or inbound request headers are never spend approval.

This is not a completed monetary accounting system and does not promise a provider-wide billing cap. Before wiring an adapter, obtain a distinct TodayAction amount/period/provider approval; implement durable atomic reservations, conservative token/search-fee pricing, concurrency limits, expiration/revocation and uncertain-outcome accounting. Reserve the entire worst case before each request and do not refund unknown provider outcomes. Provider-level cost enforcement must also be reviewed; an asynchronous Vercel pause is not an exact total-bill guarantee.

## Read-only status

The first-party status endpoint reads only the verified account ID and its discoveryProfile JSON projection using the existing server credential. It never returns the profile or complete workspace. Missing/failed/malformed/foreign-account results are unverified, not configured or approved. This additional read has a bounded timeout and cannot make unrelated Gmail status fail.

The discovery badge distinguishes disabled, status unverified, preferences required and TodayAction budget required. Historical committed discovery remains labeled historical; a scheduler check is never presented as a successful search. Current account/client authorization and mutation Origin requirements remain unchanged. No CSS/layout redesign is included.

## Verification

Synthetic regressions cover missing/foreign/expired/replayed reservation identity, HCLA receipt rejection, input bounds, denied probes, provider errors after explicit fixture reservation, profile ownership/projection/failure handling, and truthful status text. Existing Settings hierarchy browser fixtures include unconfigured and configured-but-unfunded states at 1440/390/320 widths; no performance or pixel threshold is relaxed. Live paid searches and provider credits are not used in tests.

## Batch deployment economy

The existing single-star branch suppression did not match slash-separated branches under documented glob semantics; unmatched branches default to enabled. Use `**: false` with `main: true` so main still wins while ordinary, slash and nested feature branches do not create automatic previews. Behavioral tests cover both the former escape and the main override. Chromium/Firefox/WebKit and UI evidence run from local GitHub Actions servers and retained artifacts; they do not depend on hosted Vercel previews. Production smoke remains on the canonical live domain.

Do not replace this with an ignored-build command to claim quota savings: Vercel counts canceled ignored builds toward deployment quotas. Group reviewed related source changes into one release; an emergency functional fix may be released separately. The configuration must be verified from the actual deployed source after release before claiming hosted preview suppression is effective. References: https://vercel.com/docs/project-configuration/git-configuration and https://vercel.com/docs/project-configuration/project-settings#ignored-build-step .

## B2 public-web adapter checkpoint (2026-10-07; not activated)

`perplexityDiscoverySearch.ts` supplies a server-constructed direct Search API adapter. It does not read a key from the environment or enable the worker. Each call sends one exact query in one HTTP request, with redirects and automatic retry disabled. General-web requests have no domain, language or country restriction; an explicit platform supplement may supply its recorded domain list. The response must contain the provider's own request ID. Both response bytes and body-read time are bounded. The execution ledger records the actual requested result limit, query, outcome and a canonical response hash, not a raw search dump.

The [current Search API contract](https://docs.perplexity.ai/api-reference/search-post) caps web results at 20. The [current pricing](https://docs.perplexity.ai/docs/getting-started/pricing) charges $0.005 per successful standard request, or $0.001 for explicitly selected Fast Search; a successful empty response is chargeable, with no additional token fee. The existing reservation boundary uses the selected adapter's ceiling. An uncertain transport outcome must retain its full reservation. The adapter never silently substitutes Fast Search for standard search.

These are synthetic transport/contract tests, not paid-provider execution evidence. Production still lacks an approved TodayAction amount/period/provider, a wired durable reservation adapter, a confirmed real search scope, and verified credential availability for the selected provider. Model interpretation, if used, needs its separately bounded approved reservation as well. No new key, account, payment or deployment configuration was created for this checkpoint.

Activation remains gated on those prerequisites, the reviewed authority migration, exact-head CI and actual query → source access → verified facts → domain commit → receipt/readback evidence. Daily execution also requires a subsequent genuine scheduler-triggered run. Source access blocks or unsupported formats must remain visible; query execution never implies exhaustive coverage of every recruiting website.

## Publisher verification coverage (B2, local candidate)

Discovery queries remain broad. A recognized recruiting platform proves only that platform's exact tenant/job publication; it does not establish legal employer identity or permit name-based cross-source merging. Hosted Moka/Beisen routes require a matching fetched job URL or native document ID, not the ID supplied in the request. Empty application shells, access challenges and unknown ATS formats remain unverified.

The domestic university resolver now follows the current [Ministry of Education directory](https://hudong.moe.gov.cn/jyb_zzjg/moe_347/) to the specific university homepage and its literal employment link, allowing one bounded same-origin navigation layer. It contains no per-university name/portal list. This directory covers its listed institutions, not every Chinese university; shared external portals and other unsupported relationships remain unverified. The `.edu.cn` suffix is only a lookup hint. Directory evidence, link evidence and the exact job's evidence remain separate. The publisher is labeled `university_recruiting`, never employer-official.

Public evidence is cached only within a verification batch with a one-hour maximum age tied to the oldest fetched relationship document. Expiry requires current evidence; removed links cannot be replaced by cached authority. Pages use the reviewed public-address pinned transport, bounded bodies, timeouts and per-redirect checks. The current field extractor still requires a single independently addressed structured JobPosting with matching visible company/title. A supported publisher alone does not prove that any arbitrary announcement or multi-role page is a verified job. Tests use original synthetic documents; the directory research is not a genuine automated search/commit demonstration.

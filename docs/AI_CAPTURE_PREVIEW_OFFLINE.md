# Model-powered capture: offline implementation checkpoint

This change implements the real installed AI SDK transport, authenticated preview,
durable bounded admission and reviewed-observation confirmation. Production remains
disabled. No production model call, credential change, migration or activation was
performed by this implementation. Synthetic tests are not evidence of live quality.

## Implemented path

1. Behind `VITE_PJSDAS_AI_CAPTURE=enabled`, the existing composer requests model
   interpretation only when the user presses its organize arrow, never on typing.
   Preview errors do not silently fall back to local keyword interpretation. The
   disabled path retains the released composer behavior and layout.
2. `/api/workspace?surface=ai-capture-preview` authenticates the first-party owner,
   enforces allowed origin/audience and binds the request to the workspace revision.
   The existing Gateway key is resolved server-side by the installed SDK. No new
   key or provider is requested. Model stays `openai/gpt-4.1-mini`, OpenAI-only,
   no tools, no fallback, no retries, one dispatch and redirect rejection.
3. Only the user's exact capture text, timezone and server reference time go to
   the model. The workspace inventory stays on the server for exact target
   resolution. Account IDs, credentials, stored history and resumes are not added.
   Limits: 8,000 characters, 40,000-byte HTTP body, 48,000-byte prompt, 5,000 output
   tokens, 80,000-byte output. Unsupported operations require clarification.
4. A service-role ledger atomically reserves approved free-only units before
   dispatch. Account/request/payload identity cannot dispatch twice across process
   restarts; failed/unknown results retain their full reservation. Repeated browser
   requests for the same unchanged input reuse its ID. Stale/expired responses
   permit a new explicit request; unknown results do not automatically retry.
5. Strict candidate validation checks evidence spans, exact identity, dates and
   temporal meaning. Model questions/quotes/examples/hypotheticals/rewrite requests
   do not become writes. The legacy mode check can only conservatively veto intent;
   it never supplies model candidates. Uncertainty is shown as actual questions.
6. The server persists the reviewed observation. Confirmation sends only its ID
   through the existing authoritative command client/outbox. It uses the exact
   preview revision with no rebasing, consumes the review atomically with the
   workspace CAS and durable receipt, and uses existing semantic undo. No model
   candidates enter `submitWebSemanticCapture({ candidates })`.
7. Text/account changes synchronously hide old AI previews and disable confirmation.
   Save recovery looks up the original command receipt without rerunning the model.
   Browser-only recovery text is not sent as command authority. Preview and funding
   approvals expire; ready observations cannot be silently replaced.

## Activation and verification still required

- The SQL migration is source-only, not deployed. Review and deploy it through the
  existing database process before configuring runtime admission.
- Verify an enforceable provider-side free-only/no-overage funding boundary and an
  approved data scope. Existing API-key presence, a pre-existing subscription limit,
  a free-credit screenshot or an arbitrary configured budget is not that evidence.
  Account policies and server/browser gates default off. See
  `docs/ai-capture/durable-preview-boundary.md` for exact policy inputs.
- Verify the conservative reservation against the bounded model tariff before
  provisioning an account policy; reservations are never automatically refunded.
- Run exact-head hosted browser CI. Local Chromium startup was blocked by sandbox
  socket permissions before any page loaded. The mocked suite reuses the existing
  TodayAction UI CI environment and rejecting network proxy, without real models.
- Serial PGlite verifies SQL constraints and transactions, not multi-session
  concurrency certification. Perform staged database integration/lock verification
  before activation. Live language quality remains untested until authorized.

## Mainline integration checkpoint — 2026-10-22

The original PR #282 implementation is retained and integrated with main
`64af7779c967ac6a5bd7c19e5224c24f5c4808fd`. The approved plus-only entry,
rightward expansion, fine input boundary and keyboard focus contract are unchanged.

A concrete retry-lifecycle gap is fixed: closing or switching composer modes
previously discarded the request identity after an uncertain preview. Retry identity
is now separate from the active view trigger. Reopening does not dispatch; the next
explicit click for the same account/input reuses the original durable request ID.
Known expired/stale responses may release that identity; unknown failures do not.
This memory-only retention is not cross-reload recovery or new write authority.

Verification milestones:
- Original PR #282 hosted synthetic AI browser and real multi-session PostgreSQL
  checks passed (runs 39235884927 and 39235885174). These supersede the original
  historical pending statements above, not the new integration's exact-head gates.
- Integrated local suite: 363 files / 4,565 tests passed, with typecheck and build.
- New exact-head browser, SQL and required release checks remain pending publication.
- Runtime activation, live model quality and production SQL migration remain NOT
  performed. No paid model/search call or credential/configuration change was made.

Next bounded milestone is exact-head acceptance of this default-off integration.
A later real-model quality milestone remains gated on verified funding and data
scope; passing mocks must not be described as a usable live AI conversation.

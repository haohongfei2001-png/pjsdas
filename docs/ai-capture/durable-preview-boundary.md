# Durable AI capture boundary (offline implementation)

## Activation remains disabled

No real model request, deployed migration, new credential, billing change or runtime activation is part of this implementation. A balance screenshot, an existing API key, a pre-existing subscription budget, and disabling automatic top-ups are not sufficient evidence of zero additional spend. In particular, shared Gateway credit can be consumed by other applications.

The production route now has an injectable, configured runtime factory. It returns no runtime unless all server gates are explicit: `PJSDAS_AI_CAPTURE=enabled`, `PJSDAS_AI_CAPTURE_FUNDING=verified-free-only-no-overage`, and a positive safe-integer `PJSDAS_AI_CAPTURE_MAX_RESERVATION_UNITS`. Existing Gateway credentials are resolved by the SDK; no new key is created. These configuration values are operator assertions, not independent proof of provider billing behavior.

Ready previews expire 15 minutes after admission. The account funding approval must have a future `valid_until`; expired approvals cannot dispatch. Globally disabling the server gate blocks new confirmations while allowing same-command receipt recovery.

The separate service-role-only account policy defaults to disabled, unapproved data scope, zero free units, zero approved per-request units, and no funding-boundary reference. Before activation an operator must verify and record an enforceable provider/account funding restriction preventing paid overage even under shared-account usage. Merely recording a reference does not establish that guarantee. If the provider cannot supply such a restriction, keep this route disabled.

## Approval and bounds

The approved model-bound data is only capture text, timezone, and server-selected reference time. The prompt contains a fixed schema/instruction; no workspace inventory, account identifiers, receipts, documents or credentials go to the model. Local opportunity matching happens after the response. The fixed transport uses `openai/gpt-4.1-mini`, OpenAI-only routing, no tools, no automatic retry, 48,000 maximum UTF-8 request bytes including instructions and schema, and 5,000 output tokens. User text is additionally bounded to 8,000 UTF-16 code units and HTTP request stream to 40,000 bytes.

Policy `free_units_limit`, `reserved_units`, and `max_request_units` must use the same independently documented conservative accounting units. No tariff or USD equivalence is invented here. The approved worst-case unit amount must cover this capture envelope and all applicable provider charges; Discovery's unrelated input bound/rates must not be substituted. Each request reserves at least the policy's approved `max_request_units`, and available units must cover the full reservation. The SQL constraint forbids `paid_spend_allowed=true`. All admitted holds are retained permanently, including failed/unknown results. Any future release/settlement requires separate verified accounting work. Policy replenishment and billing proof are not automated.

## State and recovery

`(user_id, request_id)` is the immutable key. Canonical payload hashing includes text, timezone, request ID and expected workspace revision. The durable row binds this hash, original text, timezone, server reference time, expected revision, reservation, status, review, observation and committed command ID.

Admission is the final awaited operation immediately before the transport's network dispatch. Its SQL transaction locks the account workspace and policy, checks revision and approved funding, increments reserved units and inserts `DISPATCHED`. The unique key and lock prevent concurrent processes from admitting the same request twice. A lost admission response sends no model request; a later read sees an unresolved receipt and refuses resend. A lost model response, crash or malformed result retains the hold and leaves `DISPATCHED` or `UNKNOWN`, neither of which can confirm or redispatch. This favors false-negative availability over duplicate spend.

Only successful immutable persistence of a ready review/observation enables `canCommit`. Retry reads return the stored preview, never reinterpret relative dates. A changed payload under the same ID is rejected. A changed workspace disables confirmation and requires a fresh explicit preview. A failed response does not imply no internal ledger writes; no workspace changes occur during preview.

Confirmation is the existing authoritative command envelope with `command.type=ai_capture_confirm`, `command.value={requestId}` and `baseRevision=preview.workspaceRevision`. No client candidates or original text are authoritative. The authenticated first-party server loads and validates the stored observation, requires exact revision equality and applies existing Semantic Intake. Any decision-required or coverage-debt item rejects the whole batch before persistence. The special commit RPC locks the workspace and preview, checks exact stored observation and preview revision, calls the existing authoritative v2 CAS/receipt function, and consumes the capture in the same database transaction. It neither rebases nor retries a lost CAS. Same-command recovery uses existing durable receipts; different commands cannot consume a committed capture. Existing semantic compensation supports undo.

## Evidence and limits

Synthetic unit tests cover actual installed SDK transport with mocked networking, final admission ordering, unknown/no-resend recovery, immutable preview recovery, disabled runtime gates, exact-preview confirmation, account isolation, strict revision, whole-batch refusal, existing receipt recovery and undo. The SQL fixture runs the real migration and existing v2 commit SQL in serial PGlite under service-role permissions, checking admission, budget denial, immutable results, exact binding, commit/replay, consumed receipt and authenticated denial.

Serial PGlite is not a real multi-session PostgreSQL concurrency certification. Before production activation, run independent multi-connection admission/confirm/revocation race tests against a disposable PostgreSQL instance, verify the deployed migration and grants, and verify provider billing enforcement and conservative cost bounds. No live language-understanding accuracy or actual model cost is claimed by these synthetic tests.

## Multi-session fixture (original candidate verified; integration gates separate)

`tests/sql/ai-capture-concurrency.mjs` is included in the existing `test:concurrency` chain and existing PostgreSQL 17 CI service, with no new job or resource. It permits only the synthetic loopback fixture URL, creates and cleans up only its own uniquely named database, and witnesses exact transaction blockers through PostgreSQL catalogs. Eleven schedules cover same-ID admission, last-credit contention, admission rollback, conflicting confirmations, same-command replay, intervening workspace CAS, confirmation rollback, expiry crossed while queued, and both orders of dispatch-policy revocation. Expiry gates use `clock_timestamp()` rather than transaction-start `now()`, so waiting cannot preserve expired approval. A funding/data-sharing revocation stops future sends but does not cancel a previously reviewed local write; server disable still rejects new confirmations before SQL.

The fixture was syntax-checked locally; the actual multi-connection run is pending the existing hosted CI service. Serial PGlite was rerun after the wall-clock correction. Do not describe this fixture's presence as a successful concurrency certification before that CI result.


On 2026-10-22, the original PR #282 CI record was checked: SQL run 39235885174
passed its real migration/authorization and multi-session contention steps, and UI
run 39235884927 passed the synthetic AI composer step. This closes the original
fixture-execution uncertainty, not production migration, provider billing, model
quality, or the required gates for any later integrated head.

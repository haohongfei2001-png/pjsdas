# B3 Gmail bounded interview reschedule

Original plan: A18/A19 in `TODAYACTION_CONSUMER_CONVERGENCE_V1.md`.
Base: merged main `d302c291230bb1b5e384784c8a85b9967c70e0fc`.
This slice connects the already-supported finite old/new interview notice to
Gmail's shared semantic core. It does not complete all Unified Intake or certify
real Gmail collection.

## Contract and authority

The currently asserted message body must contain one known-job notice such as:

`京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30`

The subject must identify the same company/role and be the finite recruiting
progress or interview-reschedule subject. Both dates include year and clock;
trusted source timezone is retained. A valid decimal provider internalDate is
authoritative; only when absent can one complete RFC Date header with explicit
numeric ±HHMM offset provide the source clock. Unknown zones, malformed provider
values, conflicting headers or invalid calendar/weekday fields remain unresolved.
Unknown qualifiers, missing or future source timestamp, elapsed arrangements,
ambiguous identity/history, multiple fragments
and unsupported temporal forms remain unresolved. The same exact current-node
and old-instant preconditions apply as the existing Web adapter. No new interview
or Action is created by the reschedule.

Binding happens separately for each record against the batch's evolving snapshot,
using the existing stable receivedAt ordering. A successful preceding invitation
or reschedule can establish the next notice's current arrangement. Deferred body
text stays in memory and is never persisted. Previously consumed messages are
not replayed; explicit reconciliation retains its existing separate contract.

Quoted/forwarded plaintext does not become a sender assertion. Semantic HTML
parsing preserves blockquote, cite and known Gmail/Yahoo/Mozilla/Outlook quote
container boundaries using the existing parse5 dependency. HTML is limited before
parsing to 128 Ki characters, then to 4096 visited nodes and 64 levels before
serialization. Inert templates, parser failures and complexity overflow produce
explicit interpretation debt and no business writes. A complete plaintext MIME
alternative is preferred without interpreting its unused HTML alternative. Current text before a
quoted thread remains eligible; quoted-only content does not. This is bounded
body handling, not an attachment, arbitrary HTML provenance or linked-page reader.

## Source clock and truthful reconciliation

The internal reschedule command accepts optional source occurredAt. It must be
a valid complete offset-aware, non-future instant. Legacy/manual commands keep
the processing instant. Process progress uses the maximum existing/source time;
schedule updatedAt and timeline recordedAt stay on the processing audit clock.
This prevents processing the first old message from incorrectly making every
later message in the same batch look stale. Existing late-source checks, guarded
compensation, lease, CAS and public gateway DTO are retained.

Reconciliation cannot rebind a successfully changed notice against the final
snapshot's now-different old-time precondition. Its read-only summary projection
requires exact source ledger fingerprint, committed non-invalidated reschedule
mutation receipt, affected job/node, source evidence/version and matching temporal
fact key. It does not manufacture a writable candidate. Missing/undone/wrong
proof remains unresolved. This preserves target attribution and actionable/fixed
counts after successful commits, new cycles and lost-finalization retries.

## Evidence and remaining gates

- Exact unchanged main produced five real product failures for valid Gmail
  reschedule, sequential evolving batch, quoted-thread current assertion,
  consumed-source replay and explicit unresolved reconciliation. An earlier
  syntax-invalid test invocation is retained separately and is not product RED.
- The elapsed-processing negative was separately RED before its processing-clock
  eligibility fix. Previous independent review reproduced two further blockers:
  HTML quotation promotion and false-unresolved reconciliation accounting.
  Three corrected tests were RED before those fixes.
- Candidate `64348a951949e03b299d662c17e0f7d32a9f65b7`, tree
  `0889ddabc192faa349cfb83538803f3fe877f657`: 27 targeted files / 452 tests pass
  under UTC. The new 66 cases also pass under Asia/Shanghai. Type checking passes.
  Tests include the real reconciliation worker with synthetic provider/credential
  mocks, first completion proof, same-cycle replay, later cycle, lost prefix
  finalization, invalid source/receipt/node evidence, Undo, equal timestamps,
  source clock and finite grammar boundaries.
- Independent review then reproduced a 5000-level HTML stack overflow before the
  old post-conversion body bound. Three actual RED cases covered deep HTML,
  oversized markup and an unused deep HTML alternative poisoning valid plaintext.
  Candidate `cd2fb92d6037105d87af9ed0c3604a6c361980d8`, tree
  `a0a21f1e70cc0720ece98eb4dd9824027dff4ef8`, fixes those bounds and adds node-count,
  template and ordinary-parser-to-reconciliation version coverage: 72 new cases
  pass under UTC and Asia/Shanghai. These results supersede only the changed
  candidate, not the retained original failures.
- A further real-worker RED showed that an audited opportunity merge preserved
  historical receipt IDs but lost summary attribution. The fix resolves only
  explicit durable aliases on pending, receipt and node owners, preserving all
  other proof requirements. The negative without the alias remains unresolved;
  immutable receipts and existing occurrence versions are unchanged.
- First frozen product/test candidate `efdbd1019435379f4b1959d89e55f64ce77a07b0`, tree
  `0c8e3c17fefa4d96a3398a3c00fd445a6de832f6`, received independent CLEAN review.
  Final independent verification passed 3 files / 87 tests and type checking.
- One frozen UTC full run passed **344 files / 4125 tests** first time, followed
  sequentially by the production build. Start/end: 2026-10-18 03:10:32–03:11:07 UTC.
  The existing >500KB chunk warning remains visible. This evidence document is
  added after those tests; runtime/test bytes remain unchanged.
- Required official CI remains pending. No browser, performance or production-
  Gmail PASS is inferred from Node results. No existing threshold, fixture
  baseline or gate changed.

## Source-clock closure after the first frozen candidate

While the initial PR276 CI ran on `6300000ef3de50b87353a4137bddd4e2d47fe509`,
a bounded probe found a pre-existing Gmail Date-header fallback issue. Without
internalDate, `20 Sep 2026 12:00:00` used the host timezone, yielding source instants
8 hours apart under UTC and Asia/Shanghai; both previously authorized this finite
reschedule. Normal Gmail full responses are expected to include internalDate;
no real provider omission was observed. The accepted adapter fallback nevertheless
must not grant this new bound path an unknown source clock.

Candidate `b1c6ce2dfbb0ed7ba668c7fdd4a3ffbb6fa9a42d` limits only the new bound
path to strict provider time or a complete numeric-offset RFC header. Its fallback
constructs and checks calendar/time/weekday fields using UTC operations, with no
host Date.parse. Duplicate/invalid Date headers, unsupported zones, malformed
provider values and future timestamps cannot establish binding. A valid provider
acceptance timestamp takes precedence over sender Date, which may legitimately
differ due to delivery delay. Existing general Gmail parsing is unchanged.

- Nine negative cases were RED under each timezone, with four controls passing.
- Independent review found three finite but out-of-range provider values that
  threw in the legacy classifier before the new validation. Their actual RED
  traces are retained. Strict bound-source recognition now happens first; invalid
  bound clocks use a metadata-only classifier copy with time fields absent.
  The original message is unchanged, source assertedAt is absent, and explicit
  interpretation_failure prevents any business mutation. The classifier's
  processing-time fallback cannot become source fact authority.
- Final source-clock candidate `6048b5d56ddfbd50063c9166ca3a6ed0a2f8fd57`, tree
  `ff08e04844b44b623397545f912ec2880eae5ee3`, passed 4 targeted files / 170 tests
  under UTC and 89 tests under Asia/Shanghai. Narrow independent review is CLEAN;
  gateway, app and node TypeScript checks passed with no emit.
- New-head official CI remains pending. The earlier 4125-test full run/build
  belongs to the preceding runtime, not this new delta. The original CI is
  preserved; its result cannot certify new bytes. No local full-suite repetition
  was used for this small reviewed closure.

## Rollout boundaries

No Gmail scopes, consent, scheduler, provider, secret, paid discovery or primary
activation changes are included. Existing Gmail authorization failure remains a
separate real-service prerequisite. No real mail or workspace was written during
these tests. Preserve domain/read compatibility and existing exact arrangement
guards if reverting an adapter; use guarded compensation rather than replacing
an entire workspace. This slice introduces no database migration.

## Actual Tell entrypoint timezone parity — 2026-10-22

The earlier pure-interpreter equivalence checks did not exercise the composer
entry adapters. Actual preview/submission used browser timezone ahead of the saved
workspace preference, producing an eight-hour difference from Gmail under a UTC
host and Asia/Shanghai workspace. A second RED showed invalid saved timezone being
silently replaced by the browser zone.

The Web entry adapters now preserve explicit caller overrides, then use a present
saved workspace timezone, with the existing browser/UTC fallback only when absent.
Invalid/empty preferences are not replaced with a guessed zone. Default-off AI
preview uses the fetched workspace preference too, rejects invalid timezone before
preview dispatch, and retains its original timezone/revision for unchanged request
IDs. Two additional AI client regressions were RED before that change.

Tests exercise actual preview/submission, a local domain commit compared with the
Gmail parsed appointment instant, invalid/absent preferences, explicit override,
date-only precision, untimed facts, offline queueing and receipt recovery after a
preference change. Synthetic AI tests verify immutable retry binding. No production
model request, paid activation, historical timestamp rewrite or UI redesign occurs.
These changes do not claim adapter equivalence without a shared saved preference,
nor broaden supported natural-language forms or live Gmail collection.

Local UTC full verification passed 363 files / 4,586 tests, TypeScript and production
build. Independent scoped review was clean, including shuffled AI retry tests.
Exact-head hosted gates and release remain separate requirements.

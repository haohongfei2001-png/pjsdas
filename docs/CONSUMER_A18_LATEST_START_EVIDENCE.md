# A18 bounded latest-start contract

Original plan: section 6.4 and acceptance A18 of
`TODAYACTION_CONSUMER_CONVERGENCE_V1.md`.
Base: merged main `2e09997814e42199379bcfe33f3d18b4a4bfae73`.

## Existing meaning, newly connected admission

The source temporal resolver and domain already represent an employer window such
as 18:00–20:00 with an explicitly supplied latest entry time of 18:20. Both public
strict temporal DTOs omitted `latestStartAt`, rejecting that existing supported
fact. This slice connects it through Semantic Intake/PAIA and the existing exact-
occurrence user reschedule route. The authoritative HTTP wrapper and registered
MCP tools reuse those same schemas.

Only inputs that supply the new field receive its additional admission checks:
availability window, datetime precision, complete valid offset-aware start/end/
latest instants, positive interval, inclusive latest bounds, and a valid non-
floating timezone. UTC and explicit source-offset representation remain valid.
Unknown fields and malformed values are rejected before source authorization,
workspace reads or writes, including low-confidence candidates. Inputs without
the field retain their existing contract. Internal legacy temporal validation is
unchanged; no new natural-language grammar or inferred time is introduced.

The source authorizer, lease/CAS, domain validation and Undo paths remain in place.
New window invitations retain the full temporal fact on the event, with the end
as completion deadline. They do not create calendar appointments. Today uses the
existing projection-only event owner to show the explicit latest start. An
explicit occurrence reschedule still versions that occurrence; no new application
Action, event, or parallel mutation engine is added. Existing legacy reschedule
projection behavior is not rewritten by this DTO slice.

## Fact identity and historical safety

Process-event and occurrence-reschedule keys append a normalized instant suffix
only when latest-start is present. Equivalent offsets identify the same instant;
different latest values, including explicit removal, cannot borrow an old receipt
to claim a correction happened. Keys without the field remain byte-compatible.

Historical receipts are immutable. Same input/source-record/version replay keeps
its existing early no-mutation path. Cross-source legacy duplicates require a
committed, non-invalidated receipt whose exact current object references and full
temporal meaning prove the candidate. A reference to an old node is never followed
to a new node and promoted into proof. The duplicate receipt retains the proven
legacy dependency key for guarded Undo; global key equality is not relaxed.

An undone legacy receipt that never bound the latest value cannot authorize its
automatic restoration. That fragment remains pending, produces explicit NO_WRITE
when alone, and asks for a fresh confirmed notice. In a mixed replay, independently
provable facts may still restore under the existing partial-application contract;
the result and persisted receipt explain that latest-start was not restored and
retain coverage debt. A subsequent replay does not duplicate the independent
action or clear the pending latest constraint.

## Retained evidence

- An initial test invocation incorrectly assumed new windows create persisted
  calendar nodes. Its fixture errors are retained and are not product RED.
- The corrected unchanged-base contract test produced four real admission
  failures and eleven passing controls before either DTO was changed.
- Separate pure-domain RED reproduced colliding latest keys and a cross-source
  18:20→18:40 correction reporting APPLIED while retaining 18:20. Historical
  receipt and late-source cases were retained alongside it.
- Independent review of `9c8043587f2dbc45936b11cb29599a2286620bda` found two more
  gaps: explicit latest removal borrowing an old absent-field receipt, and mixed
  legacy recovery omitting its unresolved latest explanation. Both were reproduced
  as deterministic RED before the final narrow fix.
- Final runtime/test candidate `516f6882c19cc42fd5553098566e2cc1642b84c7`, tree
  `2be7859a2a63994267819baa376e38c7ecd04c29`, received independent CLEAN review.
  The reviewer reran all 36 focused cases and both prior failure probes, including
  Undo restoration and a second mixed replay with the old key still pending.
- Related UTC targeted suite: 12 files / 280 tests PASS. Focused Asia/Shanghai
  suite: 36 tests PASS. Gateway/app/node TypeScript checks PASS.
- One frozen UTC full run: **346 files / 4177 tests PASS first time**, followed
  by production build PASS, 2026-10-18 04:58:24–04:58:59 UTC. The existing large-
  chunk warning remains. Build-generated release identity was retained separately
  and restored; it is not part of this commit. This document is added afterward;
  runtime/test bytes are unchanged.
- Official final-head CI/browser/performance remains required before merge. No
  thresholds, baselines, browser assertions or workflow gates were changed.

## Browser confirmation target regression

The first official head `a91c25fa65bc4fabe0c7dab6fbea3cc4a082df52`
passed CI (4177 unit tests), strict UI, Brand and the Chromium browser suites.
Its Matrix workflow reported success, but core Firefox contained **one real first-
attempt failure followed by a passing retry** (287 passed / 1 flaky). That is
retained as a merge blocker, not described as first-pass acceptance:
[original run](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39099116101),
[original trace artifact](https://github.com/haohongfei2001-png/pjsdas/actions/runs/39099116101/artifacts/12126028477).

The trace shows the asynchronous preview body appearing after confirmation was
stable and the click began, but before the click completed. The footer moved from
under the pointer. The receipt never appeared and there was **no semantic command
request**, ruling out a successful hidden save. Original Auth admission, domain
command and Undo checks had already passed. Matrix dense and all four original
performance checks passed first time; their limits are unchanged.

The narrow fix holds only preview presentation while the footer is occupied by
pointer or keyboard focus. Both must leave before a queued result can display.
Text, account/session, close, mode and save transitions invalidate queued and late
results. Submission still uses current text and its existing authority/lease path;
no pointer-down submission, readiness wait, CSS or baseline change is introduced.

The new deterministic browser case delays delivery of the **real** read-only
preview result in test middleware, then delivers it between actual mouse-down and
mouse-up. It checks stable button geometry and zero premature mutations, followed
by authoritative save, exact readback and Undo. The pre-existing failing case has
no added wait. The new case has not been run against old production source: the
original official trace is the browser RED evidence. Local browser execution is
unavailable; official final-head browser acceptance is still required.

Runtime/test candidate `7b25d59609854cbef6185b0173889d5f30358ee6`, tree
`6df338ca08787e3bad87f76939d0aa7ba05dcc27`, received independent CLEAN review.
All 48 related unit cases and app type checking passed; the reviewer independently
reran the 12 presentation cases and app types. One frozen UTC full run passed
**347 files / 4189 tests first time**, followed by production build PASS,
2026-10-18 05:50:16–05:50:53 UTC. Build identity was retained separately and restored;
only this evidence document was added after the tested runtime/test commit.

## Operational boundary

All messages, jobs and provider inputs in this evidence are synthetic. No real
mail/workspace mutation, paid-discovery activation, account permission, credential,
provider or scheduler change is included. No database migration. This does not
certify the separately blocked real-account first run.

Preserve the existing exact-arrangement/domain guards and receipt compatibility
when reverting an adapter. Do not replace a whole workspace or roll the backend
back past bound-decision compatibility. Retain value-bound latest keys and their
dependency proofs if rolling back unrelated presentation code.

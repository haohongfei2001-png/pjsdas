# Owner Amendment — Fresh Recruiting Gmail Becomes Post-Closure Observation

Date: 2026-09-25 (Asia/Taipei)
Package: PJSDAS-CONSUMER-GRADE-REFOUNDATION-v1
Authority: explicit owner authorization in the active development conversation

## Decision

The requirement for **a fresh, naturally arriving real recruiting Gmail message on the repaired final runtime** is no longer a blocking CGR-04/CGR-05/package exit criterion.

It becomes a **post-closure live observation**.

This is a contract amendment, not a claim that the unavailable observation passed.

## Why this is valid

The remaining item depended on an external event that the product team cannot safely or truthfully manufacture. At the time of this amendment there was no new recruiting email available.

Manufacturing the event would weaken the evidence rather than strengthen it:

- sending a synthetic recruiting email would not be a natural production source event;
- replaying the already-consumed historical Southern Asset Management message would test replay/dedupe, not fresh transport and interpretation;
- changing OAuth permissions, source grants, or real recruiting state merely to obtain a PASS is outside the approved boundary.

The final repaired production runtime already has complementary evidence for the material risk:

- the earlier real recruiting email exposed the actual identity/conditional-language/duplicate-DecisionRequest defect;
- that defect was repaired and covered by targeted regression tests;
- final exact-production Gmail transport subsequently ran successfully with 12 real messages, 12 accounted, 0 unresolved, no continuation backlog/error, and only ingestion/audit timeline effects for a non-recruiting batch;
- final exact-production Web and MCP source journeys passed with authoritative receipts, DecisionRequest behavior, replay/idempotency, cross-session projection and cleanup;
- exact-main CI, 71/71 Browser E2E with zero retry/flaky, real macOS visual, real VoiceOver, Production Self-Test, long-session and cross-browser RC evidence pass.

Therefore the unavailable natural recruiting message is useful **future observation evidence**, but no longer proportionate as an indefinite package blocker.

## Closure rule

Under this amendment:

- CGR-04 may close using the existing exact-production evidence plus truthful source-capability scoping;
- CGR-05 may close as the stable consumer-grade baseline;
- the package may become COMPLETE;
- no claim is made that a fresh post-fix recruiting Gmail message was observed before closure.

The first naturally arriving recruiting Gmail message after closure should still be checked end-to-end when practical. If it reveals a material correctness or integrity defect, create/reopen a defect against the stable baseline and repair it; do not rewrite the historical closure evidence.

## Boundaries unchanged

This amendment does **not**:

- waive source authorization, privacy, security, idempotency, replay, or fail-closed requirements;
- authorize synthetic recruiting email as production evidence;
- authorize replay of consumed private email as a substitute for a fresh event;
- authorize new Gmail/OAuth permissions, new paid services, external recruiting actions, PAIA grants, or release publication;
- certify delegated ChatGPT-host OAuth when no PJSDAS/Todayaction host connector is available;
- certify PAIA as active while no delegated PAIA grant exists;
- authorize UU-08, UU-09, iPhone work, a new CGR phase, or any post-CGR feature work.

## Certified runtime identity

The final product runtime certified before this docs-only closure is:

`58e9f7f4bd584139ffeb8c17a3ee6c8c15d94c3a`

Subsequent canonical closure commits are documentation-only and do not replace that runtime evidence unless they modify runtime-affecting product code or configuration.

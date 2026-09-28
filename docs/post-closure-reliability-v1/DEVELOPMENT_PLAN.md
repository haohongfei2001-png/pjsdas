# Development Plan — TodayAction Post-Closure Reliability v1

The execution order is PCR-01 → PCR-02 → PCR-03 → PCR-04 → PCR-05 → PCR-06 → PCR-07.

The purpose is not to occupy a fixed number of hours. Every change must close a
reproduced defect, strengthen a concrete invariant, or add evidence for an
identified reliability risk. If the queue is truthfully exhausted early, stop.

## PCR-01 — history/startup P0 exact-main closure

Adopt merged PR #185 as the starting repair.

Verify on exact current main:
- the historical-entry → job detail → completion path no longer unmounts Today;
- valid storage provenance/timezone markers cannot become invalid display
  timezones;
- startup/reload/root render failures reach bounded recovery rather than blank UI;
- raw recovery backup remains read-only and complete for declared IndexedDB stores;
- generic completion does not fabricate an application submission;
- elapsed, superseded, previous completion and unknown legacy completion facts are
  preserved;
- legacy timeline baseline materialization and local source mutation remain atomic
  under queued replacement/concurrency.

Run applicable exact-main CI, Browser, Matrix, VoiceOver/UI and production
self-test/read-only gates. Repair any ordinary regression. Any previously
authorized Repair-02 production mutation may execute only if its exact existing
authorization and current preconditions still hold; otherwise defer it rather
than expanding authorization.

Exit: exact-main P0 receipt and no known reproduced startup/history blocker.

## PCR-02 — startup and recovery invariant audit

Systematically reproduce startup/reload against representative local and connected
states:
- legacy v1/v2/v3-compatible snapshots;
- malformed but recoverable records;
- invalid individual rows;
- partial account cache / stale local cache;
- offline startup and later reconnect;
- root selector/render error;
- workspace refresh during startup;
- recovery export and Retry.

Required invariant: one corrupt/legacy item must not blank the whole application.
Where safe normalization is impossible, fail closed with user-visible recovery
and a complete read-only export path.

Only fix demonstrated defects. Every fixed bug class becomes a permanent unit or
browser regression.

## PCR-03 — Schedule/history mutation semantics audit

Audit the complete mutation matrix for:
- scheduled;
- in_progress;
- completed;
- cancelled;
- superseded;
- elapsed_unresolved;
- legacy/unknown completedAt;
- multiple occurrences of one process;
- history reopen and subsequent edit/delete/import.

Verify that mutation of one current fact cannot erase historical evidence or
silently complete a different occurrence/process.

Check local and connected command paths, CAS/Undo boundaries and durable
reload/restart. Preserve append-only/provenance principles.

## PCR-04 — action-intent correctness

Audit user-visible intent across Web, domain commands and MCP where applicable.

Keep distinct:
- generic task `Mark done`;
- `I applied` / application submitted;
- interview/test occurrence completed;
- reminder/action completed;
- withdrawal/abandonment;
- process result/outcome.

A generic completion action must never silently create an application,
withdrawal, offer, rejection or other stronger recruiting fact.

Add cross-surface contract/regression coverage for any inconsistency found.

## PCR-05 — connected-mode restart/reload/recovery

Exercise:
- page reload and browser restart;
- offline → online transition;
- background authoritative workspace refresh;
- CAS conflict during local interaction;
- account change/sign-out/sign-in;
- stale local state superseded by connected authority;
- invalid local row with otherwise valid connected workspace;
- interrupted import/restore paths that interact with current daily surfaces.

The UI must remain recoverable, authority must remain explicit, pending/draft
state must not leak across accounts, and successful receipts must not appear
before authoritative success.

Do not redesign normal product UX unless a reproduced recovery defect requires a
bounded change.

## PCR-06 — read-only production integrity classification

Use only existing read authorization and safe aggregate/redacted inspection.

Classify actual production state shapes relevant to PCR-02..05, such as:
- legacy temporal provenance markers;
- completed/elapsed/superseded combinations;
- historical rows lacking newer optional fields;
- unresolved records and source linkage classes;
- schema/version/cache compatibility classes.

Do not expose private payloads in receipts. Do not mutate production merely to
manufacture evidence.

If a real class is not represented in tests, add a synthetic/redacted regression
fixture matching its structural contract. If inspection is unavailable, record
that gate and continue.

## PCR-07 — bounded reliability closure

Run the full applicable gates for the final exact head/main:
- unit/type/build/security checks;
- Chromium critical journeys;
- Firefox/WebKit matrix where configured;
- accessibility/VoiceOver gate where configured;
- production self-test and exact frontend/backend identity;
- read-only production integrity checks allowed by current permissions.

Closure requires:
- every defect found in PCR-01..06 has a permanent regression or an explicit
  unresolved/deferred record;
- no test/assertion is weakened to obtain green;
- no production/private-data claim exceeds actual evidence;
- no new permissions, external recruiting actions or release publication.

The package may close `COMPLETE`, `COMPLETE_WITH_DEFERRED`, or
`COMPLETE_WITH_UNRESOLVED`; it must not invent PASS.

## Continuous execution rules

1. One writer per affected boundary.
2. Re-read remote main and active PR before each new phase.
3. Ordinary bugs, CI/test failures, review findings and harness defects are
   manager-owned; repair and continue.
4. Do not block on CI if independent dependency-safe work exists, but never merge
   an unverified slice as verified.
5. External/device/private/owner-only gates are recorded and bypassed for
   independent engineering.
6. Never weaken tests, delete evidence, bypass CAS/provenance/authorization, or
   create filler PRs to keep the manager running.
7. Preserve all completed CGR/UU/reliability historical receipts.
8. Stop only when PCR-01..07 are truthfully exhausted or every remaining item
   depends on an owner-only/external/prohibited action.

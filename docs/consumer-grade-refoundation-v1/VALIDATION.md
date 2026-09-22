# Validation

## Core rule

Validation proves a user result, not internal agreement with a contract.

Necessary but insufficient alone: code exists, contract exists, tests pass, CI green, page renders,
selector visible, CSS string exists, historical round COMPLETE, capability flag supported.

## Evidence layers

1. **Domain correctness** — lifecycle, ScheduleNode identity/precision, ranking, Semantic Intake,
   DecisionRequest, idempotency/provenance, command/Undo semantics.
2. **Integration** — real client → server command → transaction → receipt → read projection.
3. **Production reliability** — expired session, duplicate command, lost response after commit,
   restart with pending command, version skew, timeout, concurrent unrelated/same-object mutation,
   account switch.
4. **Continuous journeys** — complete outcomes across pages/sources.
5. **Information comprehension** — user can identify next action, protected commitment, real save
   state, decision meaning and recovery.
6. **Visual regression/craft** — reviewed baselines for primary/degraded states; stability does not
   make a bad baseline good.
7. **Responsive** — phone/intermediate/wide, long bilingual content, dense schedules, safe areas,
   soft keyboard, large text/zoom, no overflow/occlusion.
8. **Accessibility** — automation plus keyboard, focus, dialog return, labels, reduced motion, large
   text and screen-reader primary journeys.
9. **Realistic density** — hundreds of opportunities, long history, same-company roles, mixed time
   precision/source records.
10. **Production canary** — exact runtime and real path; health/tool listing only supplementary.

## Canonical journeys

- Natural update completes correct written-test occurrence without completing recruiting process.
- Quoted reschedule mail updates current occurrence once and preserves history.
- Authoritative Web update appears on another active client.
- Unrelated later mutation does not block safe Undo.
- Commit response lost; receipt lookup prevents duplicate.
- Same-company ambiguity asks only missing business question.
- Account switch never renders/uploads prior-account cache.
- Authorization loss appears as freshness/capability impact.
- Elapsed time without evidence remains unresolved.

## Intake metrics

Report coverage and correctness together: observations; candidates; safe auto-commits; business
ambiguities; interpretation failures; transport failures; normal capability boundaries;
wrong-target/wrong-occurrence/wrong-time critical errors; duplicates; time to authoritative result.

Do not improve accuracy by ignoring most real inputs.

CGR-02 healthy active-client target: p95 <= 5 seconds from authoritative commit to second-client
visibility.

## Release blockers

Silent authoritative loss/overwrite; wrong opportunity/occurrence; fabricated time precision;
accidental process completion; duplicate authoritative write; cross-account exposure; success shown
before authority; inaccessible primary flow; unrecoverable normal network/session failure; or an
unbounded legacy normal write path.

UU evidence remains valid for its scoped assertion, not overall consumer quality.

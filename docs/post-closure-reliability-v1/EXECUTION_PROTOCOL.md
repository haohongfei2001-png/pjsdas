# Execution Protocol — TodayAction Post-Closure Reliability v1

## Source of truth

Before each phase:
1. fetch remote `main`;
2. read this package STATUS and DEVELOPMENT_PLAN;
3. inspect active PRs/writers and exact workflow state;
4. prefer current GitHub facts over prior chat context.

## Writer discipline

- Maintain one writer for the active affected boundary.
- Do not open parallel product writers that touch the same state/mutation surface.
- Documentation-only evidence may be staged separately only when it cannot race
  runtime truth.
- Merge stable verified slices; then acquire the next writer.

## Failure handling

The manager owns ordinary engineering failures:
- reproduce;
- diagnose root cause;
- add/strengthen regression;
- repair;
- rerun affected and required full gates;
- continue.

Do not return to the owner merely for routine CI, merge conflict, test, harness,
browser, type, review or deployment-debug work.

## Deferred gates

When a remaining step needs an unavailable device, private artifact, new
permission, paid commitment, external consequential action or owner-only
decision:
- record the exact gate and current evidence;
- keep the dependent behavior disabled/fail-closed;
- continue every independent later phase;
- revisit deferred gates only at final convergence or when new evidence arrives.

## Safety and scope

No new authorization is implied for production data writes, Gmail cursor edits,
OAuth scope, external recruiting actions, release publication, iPhone/native
work, UU-08/09 or a new product refoundation.

Existing bounded production authorization may be used only under its exact
documented prerequisites. If those prerequisites are stale or ambiguous, do not
generalize them.

## Quality floor

- No deleted/weakened regression to achieve PASS.
- No stale-head receipt.
- No \"tests passed therefore production is correct\" shortcut.
- No truncating private/legacy edge cases out of the supported contract merely to
  close the package.
- No filler work: every PR must identify a concrete defect, invariant, capability
  or closure delta.

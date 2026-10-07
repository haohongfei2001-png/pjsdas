# TodayAction Post-Closure Reliability & Product Hardening v1

Package: `TODAYACTION-POST-CLOSURE-RELIABILITY-v1`

This package is the authorized continuation path after the stable Consumer-Grade
Refoundation baseline. It does **not** reopen, rewrite or downgrade the completed
CGR package. It exists to convert newly reproduced post-closure defects and
high-value reliability risks into permanent product invariants and regressions.

## Objective

Keep TodayAction trustworthy in daily use as real historical, legacy, connected,
offline and partially malformed states accumulate.

The package may:
- repair reproduced correctness/recovery defects;
- strengthen bounded startup, history, mutation, restart and connected-mode
  invariants;
- add regressions for real bug classes;
- perform read-only production integrity inspection where already permitted;
- run the repository's existing CI/browser/matrix/accessibility/self-test gates.

The package must not:
- start UU-08 or UU-09;
- start another broad product refoundation;
- implement iPhone/native work;
- publish a new public release;
- broaden Gmail/OAuth/PAIA/other permissions;
- manually edit Gmail cursors or destructive history;
- perform job applications, withdrawals, recruiting emails or other external
  consequential actions;
- mutate private production data merely to create a test case;
- weaken tests or manufacture work to fill elapsed time.

Canonical files:
- [STATUS.md](STATUS.md)
- [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)
- [EXECUTION_PROTOCOL.md](EXECUTION_PROTOCOL.md)

Remote `main`, the active PR/head, exact-SHA verification and package receipts
are the engineering source of truth.

## Approved subsequent product convergence

[TodayAction Consumer Convergence v1](../TODAYACTION_CONSUMER_CONVERGENCE_V1.md) is the separately approved small-scope next-stage plan for Intake/Discovery and job/action/schedule semantics. It does not reopen or rewrite this package's historical STATUS or receipts. At implementation start, reconcile the actual current runtime writer (PR #256 at the plan's baseline) and continue that affected boundary without a parallel implementation. The current convergence task creates documentation/design references only and stops after its PR.


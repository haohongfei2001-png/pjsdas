# PCR-06 — Read-only integrity classification

Status: COMPLETE. Earlier aggregates below are dated evidence from the
2026-09-28 audit, not a claim about the current production revision. No raw private
payloads are published. PCR05's dependency is verified on main `85e2f568`.

| Observed class | Preserved interpretation | Permanent regression |
| --- | --- | --- |
| Revision 875: schema 4, 384 actions, 358 open decisions | Existing business records retained | `tests/fixtures/denseDecisionWorkspace.ts`, `tests/denseDecisionReadModel.test.ts`, `e2e/denseTodayDecisions.e2e.ts` |
| 300 nodes: 284 scheduled, 13 completed, 3 cancelled; all 13 completed lack completedAt | Unknown completion time stays unknown | `tests/historyCompletionStartup.test.ts`, `e2e/historyCompletionStartup.e2e.ts` |
| Revision 876: all 300 nodes legacy_projection; 241 UTC, 47 floating-date, 12 source-offset | Storage provenance is not an Intl display timezone; floating dates retain calendar semantics | Same startup suites and dense read-model suites |
| No missing action/process/event/opportunity references; no action linked to multiple nodes in those aggregates | No orphan cleanup justified | `e2e/postClosureHistoryUndo.e2e.ts`, startup validation suites |
| No semantic receipts missing creationSequence; 358 nested Gmail source bindings, no decision lacking a referencing receipt | Preserve source identity and stable ordering | `tests/gmailSemanticIntake.test.ts`, `e2e/gmailSemanticIntake.e2e.ts` |
| Earlier 851 classification: 121 repeated source/candidate pairs, only 14 exact candidate/reason/choice replays | Exact presentation grouping only; repeated wording alone does not establish safe deletion | Dense decision suites |
| 98 legacy past nodes and unresolved historical debt | Available through inbox/history, not automatically promoted into Today | Dense decision and history Undo suites |
| Saved 847/851 snapshots differ in top entity-array ordering for equivalent content | Normalize only unique entity IDs for equivalence, preserve wire/content/nested ordering | `e2e/cacheProjectionPersistence.e2e.ts` |
| Late account/read/command responses and genuine local edits | Account generation, atomic baseline comparison, journal and pending receipt recovery | `e2e/postClosureAccountRace.e2e.ts`, cache projection suite |

The actual deployed 85e2 bundle passed isolated 847→851 cache convergence with
358 decisions retained and no outgoing mutations. This does not prove the exact
state of the owner's currently open browser.

## Deferred / unresolved

- The earlier connector-unavailable deferral was resolved after Supabase reconnection.
  Read-only SQL on 2026-09-29 returned revision934, schema4,388 actions,
  363 decisions,300 nodes (284 scheduled/13 completed/3 cancelled).
  All300 remain legacy_projection:241 UTC/47 floating-date/12 source-offset.
  All13 completed nodes still have unknown completedAt. Missing action/process/
  event/opportunity references:0; missing receipt creationSequence:0;
  Gmail decisions363, decisions without a referencing receipt:0.
  The earlier358 count describes saved fixtures, not current production totals.
  Current production Today membership was not recomputed from this aggregate query.
  These SELECT queries did not mutate the workspace or reprocess new records.
- Historical ambiguity remains: 52 privately audited source messages produce
  283 candidates / 44 bound / zero missing in the latest bounded parser audit.
  Unknown or mixed instructions are retained; these counts do not authorize
  historical reprocessing, deletion, or bulk settlement.
- Repair02's one authorized write was consumed at 841→842; no repeat is allowed.

All identified structural classes above have a permanent regression binding.
No new mutation was needed to manufacture evidence or remove historical debt.

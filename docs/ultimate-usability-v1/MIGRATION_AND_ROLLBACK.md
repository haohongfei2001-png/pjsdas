# Ultimate Usability v1 — Migration and Rollback

## Migration order

1. additive schema/contracts;
2. compatible server readers/writers;
3. compatibility projections for old clients;
4. new client/read models;
5. shadow processing/evaluation;
6. bounded source/event enablement;
7. retire old projection only after evidence.

Never introduce an active-active dual business authority.

## Schedule/time migration

Legacy deadline/event/action fields may temporarily mirror ScheduleNode, but:

- only one transaction may generate/update the canonical time fact and mirrors;
- equality/invariant checks are required;
- Timeline copy must not be re-parsed to recreate future schedule;
- Reminder data may not become business truth.

## Workspace compatibility

Snapshot schema version, command contract version, and read-model contract version are separate.

An older client must not overwrite newer fields by uploading a whole stale snapshot.

## Rollback

Rollback code must not restore an old snapshot over new facts.

Preferred recovery:

- forward fix;
- compensating mutation;
- disable one source/event autonomy class;
- keep intake/evidence for diagnosis;
- preserve ledger/receipts/history.

## Per-source kill switch

If an event type/source begins miswriting:

- stop autonomous commits for that source/event class;
- continue safe observation intake where possible;
- preserve evidence and diagnostics;
- route only material ambiguity to DecisionRequest;
- do not shut down the entire product unless authority/integrity itself is unsafe.

## Real-data protection

UU rounds use synthetic fixtures first.

Real owner workspace changes require the round contract to explicitly authorize them and must preserve
backup/recovery and receipt evidence. UU-00 authorizes none.

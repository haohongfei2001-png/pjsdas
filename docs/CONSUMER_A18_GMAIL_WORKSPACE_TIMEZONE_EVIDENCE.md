# Consumer A18: trusted Gmail workspace timezones

## Scope and original defect

This continues the existing bounded Gmail semantic intake plan. The actual
transactional workspace read returned saved `UTC`, while Tell interpreted a
14:30 notice as UTC and Gmail hard-coded the same notice to Asia/Shanghai. The
result was an eight-hour discrepancy in the persisted event and schedule node.
The ordinary worker, reconciliation and bounded fragment reprocessing now pass
the same trusted workspace timezone into the existing semantic adapter.

A present saved preference takes precedence over the older Drive read context.
Invalid preferences are not replaced with a convenient fallback. The already
established explicit Gmail service default remains Asia/Shanghai when its normal
service context supplies that default; absence of all trusted context leaves a
timed message unresolved. No host-local timezone is inferred. Non-temporal facts
retain their previous behavior.

The existing explicit `北京时间` date-prefix form stays source-authoritative,
including when the workspace uses UTC. Only that bounded form is recognized;
qualified, negated, conflicting and unsupported source-zone syntax stays
unresolved. Timezone meaning is not propagated into another fragment or a quote.
The general source-temporal parser is unchanged.

## Consumed-source and legacy boundaries

Changing a preference or parser source version cannot reinterpret an already
consumed source and silently add an eight-hour-shifted duplicate. For timed
history, the guard matches the exact Gmail source tuple, receipt fact key and
original object references. It checks value-bound temporal data and does not
follow a superseded node to its latest arrangement. Identical proven explicit or
mixed-zone facts can replay without acquiring new timing meaning. Missing or
conflicting provenance retains existing business history and reports unresolved
coverage; ordinary policy, authority, Undo and recovery checks still apply.

For old dueAt-only decision receipts, the narrow compatibility proof requires the
exact recorded decision/choice, source version, command/input IDs, original-text
fingerprint, and original event/node instant. A stored valid IANA source zone is
required. A raw numeric offset cannot prove an IANA interpretation. Undone
receipts may prove historical provenance, but do not grant current answer or
recovery authority.

Pre-UU06 timed consumption without semantic receipts uses its exact source-bound
ledger/event link only to establish that a timed fact was already consumed. With
no trustworthy original IANA interpretation it remains unresolved, rather than
creating another arrangement. Unrelated sources cannot supply that proof. Legacy
unresolved mail without a timed fact remains eligible for normal recovery.

A legacy latest-start-less key may prove its base clock zone. It does not prove
latest-start identity: the existing core's exact temporal/receipt compatibility
checks remain responsible for unchanged, changed and removed latest-start facts.

## Evidence

All messages, account identifiers and provider responses are synthetic. Real
transaction-read context and real domain functions are used where stated.

- Corrected unchanged-base timezone contract: 9 genuine RED failures and 9
  controls. Earlier fixture mistakes are retained separately.
- Cross-version re-interpretation: 3 genuine RED cases, including the actual
  ordinary-worker-to-first-reconciliation path, before the provenance guard.
- Legacy decision compatibility: 4 genuine RED failures and 13 controls after
  correcting an initially invalid history fixture. History/Undo and missing-proof
  cases remain in the final suite.
- Existing explicit Beijing-time handling: 4 genuine RED cases before the narrow
  date-prefix fix, with unsupported/qualified syntax negative coverage.
- Final independent review of ffdb92d44289148e80f9cb500bc0807ad145d008 found
  pre-UU06 timed-history duplication and a false unresolved legacy latest-key
  replay. Both were reproduced as 3 genuine RED cases / 34 controls. The older
  snapshot's normal duePrecision backfill was separately identified; the final
  fixture uses the actual snapshot upgrade and verifies its original instant.
- Fixed candidate 57124698b3cb039cae24526855e37fc92a4dde7a, tree
  33acc2506c16b6dbe38d019a10efd50e998dd635 received independent CLEAN closure.
  Independent probes covered exact versus unrelated source tuples, no-fact
  recovery, unchanged legacy latest keys, latest changes/removal and zone changes.
- Final bounded UTC suite: 26 files / 444 tests PASS. Asia/Shanghai suite:
  3 files / 66 tests PASS. App and gateway TypeScript checks PASS.
- Integration of the reviewed PR277 confirmation-target baseline changed none of
  those seven timezone runtime/test files. Integrated candidate:
  a6304fe8303be48ce870e03ca43114233b50c462, tree
  064af2e2872c2998ce4a7a259b124c5d0b2d5d84.
- One frozen integrated UTC full: **350 files / 4255 tests PASS first time**,
  followed by production build PASS, 2026-10-18 06:17:02–06:17:38 UTC. The existing
  large-chunk warning remains. Generated release identity was retained separately
  and restored; only this evidence document was added after the tested candidate.
- Official exact-head CI, browser, original performance and strict visual gates
  are required before merge. No assertion, limit, baseline or workflow is relaxed.

## Operational and rollback boundary

No real mail or workspace writes, timezone preference edits, credentials, OAuth,
provider activation, paid service, primary discovery or scheduler changes are
included. This does not certify the separately blocked real-account first run.
There is no data migration or bulk reinterpretation of existing mail.

Keep exact-arrangement/domain guards, durable receipts, latest-key compatibility
and source-time provenance when rolling back unrelated adapters or UI. Do not
replace a workspace or restore a whole backend predating those guards. An adapter
rollback must not replay consumed mail under a different current timezone.

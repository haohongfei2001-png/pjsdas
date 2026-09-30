# ZMC-04 — Typed field reconciliation candidate

## Scope and authority

Connected commands still run against the latest authoritative snapshot under transactional CAS. The server records both the fields actually changed (`affectedFields`, for audit) and the fields that a command semantically protects (`conflictScopes`, for rebase). A stale command may be rebased only when its typed intent and every intervening receipt prove that those protected scopes are independent. A deadline or participation command protects the whole opportunity even if it changed only a few stored fields. A missing or malformed historical scope stays object-wide and blocks an overlapping stale command. No client snapshot or timestamp wins by default.

| Entity or fact family | Reconciliation rule |
|---|---|
| Opportunity | Confirmed `detail.userFacts.location`, `compensationText`, `applicationUrl`, and `roleType` are independently typed fields. An identical confirmed value is already applied without another evidence write. Deadline, participation, stage, source identity, and unknown semantic updates remain object-scoped because they can change dependent action, process, or schedule state. |
| Action | Status is a lifecycle transition with possible schedule effects. Title, timing, and status changes remain object-scoped until the dependency bundle can be proven. Independent action IDs rebase. |
| Process and ProcessEvent | Stage/result/effective event form a business lifecycle bundle. Distinct event IDs append and remain in the audit; a stale competing update to the same parent fails closed until refreshed. Process notes are recorded as fields but have no loose writer that can silently overwrite them. |
| ScheduleNode | Every version of one occurrence is one conflict unit. Completion, cancellation, and reschedule cannot race through a stale base. Superseded nodes and provenance remain intact. Distinct occurrences rebase. |
| DecisionRequest | Answer, state, and binding are one decision unit; concurrent different answers never merge. Historical requests and source evidence remain retained. |
| Prep | Field changes are recorded in receipts, but current free-form source updates use conservative object scope. Distinct prep IDs rebase. |
| ReminderIntent and reminder outbox | Trigger, delivery owner, and lifecycle state remain one intent unit; no timestamp-based winner. Distinct reminder identities rebase. |
| Notes, rules, and preferences | Opportunity user facts and role preference follow the typed rule above. Other notes/rules/profile replacements remain object-scoped until explicit typed commands exist. |
| Time capacity | Default daily capacity, weekly windows, and each date override are separate authoritative keys. The same key conflicts; different keys rebase. |
| Append-only provenance | Timeline, semantic receipts, source versions, process events, and occurrence versions are retained by identity. New rows are never deleted to make reconciliation pass. |

New receipts carry `affectedFields` and `conflictScopes` under version 4. Earlier receipts stay readable and conservative. Unknown types or missing conflict scope evidence are treated as whole-object changes. The field ledger ignores clock-only `createdAt`/`updatedAt` changes as merge proof, but a metadata-only or unknown difference falls back to whole-object conflict.

## Red-before and regression

- Red-before: a user-confirmed location and role preference for the same opportunity, issued from one base revision, produced `OBJECT_CONFLICT` despite independent fields.
- The sequence matrix runs confirmed location, compensation, and application URL against role preference in both orders. Separate confirmed fact fields also run in both orders. Same-field contradictory values conflict without a second write; an identical value is already applied without a duplicate receipt.
- A synthetic legacy receipt with only object scope still blocks a stale overlapping command. Append-only process evidence remains after sequential events, while a stale competing parent stage is held. A stale reschedule cannot supersede an already completed occurrence.
- Independent review exposed an unsafe first attempt that used changed fields as merge permission. The regression now checks deadline versus user fact in both command orders; its whole-opportunity scope blocks both stale sequences.

Final full gates, independent review, merge, and exact-main production readback remain pending.

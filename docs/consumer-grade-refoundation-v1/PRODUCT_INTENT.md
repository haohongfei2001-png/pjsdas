# Product Intent

## Product definition

PJSDAS is a personal job-search operating assistant whose responsibility is to maintain a trustworthy model of the user's recruiting reality and turn it into the smallest useful set of actions, upcoming commitments, and true human decisions.

It is not primarily a task manager, CRM, database browser, automation console, or AI chat surface.

## Responsibility transferred to PJSDAS

PJSDAS should, within the authority granted to each source:

- ingest relevant changes from trusted sources;
- resolve them to stable opportunities, processes, schedule occurrences, actions, and preparation context;
- preserve source truth, history, temporal precision, and provenance;
- reconcile duplicate and superseding facts;
- update safely when the fact is clear and compensatable;
- ask for a DecisionRequest only when a real business ambiguity remains;
- surface the next useful action and near-term commitments;
- explain what it understood and whether authoritative save has completed;
- remain recoverable when sources, networks, devices, or sessions fail.

The user should not have to maintain PJSDAS in order to trust PJSDAS.

## Daily user perception

A normal visit should answer four questions quickly:

1. What should I do now?
2. What important interview, test, deadline, or commitment is coming next?
3. What meaningful change has PJSDAS already handled for me?
4. Is there anything that truly requires my judgment?

The product should be allowed to be quiet when there is nothing important to do.

## Complexity hidden from routine use

Routine product surfaces must not require understanding of workspace revisions, CAS, command ledgers, IndexedDB, source coverage internals, transactional snapshots, ChangeSet mechanics, migration generations, deployment topology, or authority implementation names.

Those mechanisms remain essential engineering contracts. Product language translates them into saved, pending, offline, source unavailable, needs your decision, or conflict between two concrete facts.

## Primary-surface relationship

### Today

Today is the highest-frequency decision surface. It is not a dashboard of all system state. It presents one primary action, a small number of alternatives when useful, near-term schedule commitments, meaningful recent changes, and only the decisions that deserve interruption.

### Opportunities

Opportunities is durable job-search context. It supports browsing, comparison, progress understanding, preparation, history, and deeper decisions. It is not a maintenance console.

### Tell PJSDAS

Tell PJSDAS is a global low-friction way to state a fact, correction, intention, or decision. When opened from an opportunity context, that context travels with the input. The result is explicit: what was understood, what was saved, what remains unclear, and how to undo or inspect it.

### Automation

Automation is a background responsibility, not a primary destination. Gmail, PAIA/current-chat, future mobile capture, and other authorized sources feed the same intake and business rules. Users see the effect and actionable exceptions, not transport mechanics.

## Trust model

PJSDAS must distinguish received locally, understood as a specific candidate fact, waiting for authoritative save, authoritatively saved, ambiguous and requiring a decision, unsupported source content, source transport failure, interpretation failure, business conflict, and normal capability boundary.

A capability flag, health indicator, or successful poll must never imply that a promised end-to-end user capability has completed.

## Mac and future iPhone relationship

Mac Web is the richer planning and work surface: Today, opportunity comparison, detailed history, preparation, materials, and longer actions.

A future iPhone client should share the same domain semantics, command contracts, receipts, and read models but emphasize glanceable Today, quick capture, immediate decisions, reminders, and entry into imminent recruiting events.

The iPhone client must not reimplement business rules. It may be discussed after CGR-05; it is not part of this package implementation.

## Anti-goals

This package does not optimize for maximum feature count, maximum number of autonomous sources, visible technical sophistication, preserving every historical UI route, making every internal object directly editable, turning all errors into user decisions, hiding uncertainty behind optimistic wording, or aesthetic novelty at the expense of comprehension.

## Owner decision boundary

The executor proceeds independently on ordinary professional design and engineering choices.

Stop for the owner only when a choice materially changes product value, irreversible data or permissions, new financial commitment, privacy/legal exposure, consequential external action, or a direction where alternatives are meaningfully different and neither is objectively better.

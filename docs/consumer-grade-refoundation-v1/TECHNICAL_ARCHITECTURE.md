# Technical Architecture

## Objective

Preserve the proven domain and transactional foundation while changing the boundary between user intent, client state, authoritative mutation, read projection, and user feedback.

The central refoundation is not a database rewrite. It is the replacement of routine connected whole-workspace mutation with explicit authoritative business commands and a cleaner frontend responsibility model.

## Preserved authoritative foundation

- Supabase/PostgreSQL transactional workspace.
- workspace revision/CAS.
- command ledger and receipts.
- provenance and source identity.
- idempotency and replay protection.
- Opportunity / Process / Action / Prep semantics.
- ScheduleNode / occurrence / temporal precision.
- deterministic decision/ranking logic.
- Semantic Intake policy kernel.
- DecisionRequest.
- Gmail cursor, lease/fencing, continuation, and replay protection.
- owner authorization and external-action boundaries.
- exact-SHA release/security gates.

## Target client architecture

Production Web converges on:

    App
      SessionBoundary
      Router
      AppShell
      TodayFeature
      OpportunitiesFeature
      CaptureFeature
      DecisionsFeature
      SettingsFeature

    Shared application layer
      ReadModelQueries
      BusinessCommandClient
      ReceiptTracker
      AccountScopedCache
      PendingOperationQueue
      SourceCapabilityView

    Shared UI layer
      DesignTokens
      AccessiblePrimitives
      LayoutPrimitives
      FeedbackStates

Business rules stay outside page components.

The architecture must not create another version-numbered monolith such as AppV9 and keep older shells active beneath it.

## Authoritative business-command boundary

Routine connected writes become typed commands such as record interpreted fact, complete a schedule occurrence, reschedule an occurrence, update participation state, complete/defer an action, resolve a DecisionRequest, and compensate/undo a prior command.

The server revalidates each command against current authoritative state, source authorization, domain invariants, object versions, and idempotency identity.

The server returns a structured receipt containing command/receipt identity, authoritative revision, affected object identities, read-model invalidation, semantic interpretation summary, undo/dependency information, DecisionRequest identity when applicable, and safe retry status.

Routine connected user actions must not require the client to author a replacement snapshot.

Whole-snapshot operations may remain only for bounded import, migration, backup/restore, or recovery workflows.

## Conflict and Undo semantics

A changed global revision is not automatically a user conflict.

Independent changes may proceed or merge; same-object compatible changes reconcile deterministically; true contradictory facts produce a concrete conflict or DecisionRequest; destructive identity changes fail closed.

Undo is compensation, not stale-snapshot restoration. Unrelated later updates do not by themselves block undo. Later dependent changes may narrow or block compensation with a concrete explanation.

## Client cache and pending operations

Connected mode has one business authority: the server.

IndexedDB or equivalent local persistence is an account-scoped cache, draft store, and pending-operation queue. It is not a second business authority.

Requirements include account-scoped data, no cross-account display/replay, stable pending-operation identities, receipt lookup before retry after unknown network outcomes, bounded optimistic UI, and visible freshness.

## Read-model boundary

Pages consume stable read models for Today, opportunity list/detail, DecisionRequests, source/connection status, and receipt/pending state.

Read models derive from authoritative domain state and shared deterministic logic. Pages do not reconstruct ranking, scheduling, or process semantics independently.

## Cross-client visibility

Cross-client visibility is driven by authoritative revision/read-model freshness, not competing snapshot uploads.

Implementation may use lightweight server notifications, focus/resume refresh, bounded polling, or another compatible mechanism. CGR does not require a new real-time infrastructure product; it requires measured propagation appropriate to the user journey.

## Semantic interpretation pipeline

All natural-language sources converge on:

    Source acquisition
    -> source-safe normalization
    -> contextual interpretation
    -> structured candidate facts
    -> deterministic identity/temporal/authorization validation
    -> authoritative business command or DecisionRequest
    -> receipt and user feedback

Rules/parsers remain useful deterministic helpers. They are not allowed to define the entire capability if real user language requires stronger interpretation.

Quoted email/user content is data, not an instruction to the interpreter.

A new paid model, raw-data processor, or permission requires the applicable owner decision.

## Observability

A user-relevant update is traceable across received, interpreted, accepted/rejected/ambiguous, committed, projected, visible to client, and externally delivered when that is an authorized capability.

Engineering metrics separate source transport health, interpretation coverage/failure, business ambiguity, command/save failure, cross-client propagation, pending-operation age, external delivery failure, and normal capability boundary.

Raw private text is not required in routine telemetry.

## Design-system architecture

One active token source and one active primitive layer govern typography, spacing, surface hierarchy, focus, validation, loading, pending, error, and disabled states.

Feature styles are locally scoped. A migrated route must not depend on historical global override order. Adding another catch-all polish stylesheet is prohibited.

## Versioning and deployment

Snapshot schema, command contract, read-model contract, client cache schema, and source adapter version are separate concepts.

Older clients must not be able to overwrite newer state through stale whole-snapshot mutation.

Existing exact-SHA, authorization, security, and production release gates remain. CGR adds end-to-end user-journey evidence; it does not weaken release protection.

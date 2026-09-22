# Technical Architecture

## Objective

Preserve the trustworthy domain/transaction core while changing client-to-authority and frontend
boundaries that make normal use brittle. Incremental migration; no database rewrite.

## Authority

Connected mode has one business authority: authenticated server-side transactional workspace.

IndexedDB becomes account-scoped client infrastructure for read cache, drafts, view continuity,
identified pending commands and bounded recovery metadata. It is not a second business authority.

## Normal mutation path

`intent → typed business command → server authorization/domain validation → transaction →
ledger/receipt → read-model projection → client refresh`

Ordinary Web actions must not upload a whole locally-mutated workspace snapshot. Initial command
families cover semantic intake, completion, reschedule/correction, DecisionRequest resolution and
compensating Undo. Whole-snapshot replacement may remain only for named import/migration/recovery.

## Concurrency / Undo

CAS remains transaction guard. Product conflict becomes object/command aware: unrelated objects
rebase automatically; same-object semantic conflicts fail closed; idempotent command identity
handles uncertain retries; lost response resolves by receipt lookup first.

Undo compensates affected objects/fields. Unrelated later revisions should not invalidate it;
dependent later changes may.

## Read models

TodayBrief, opportunity summary/detail, DecisionRequest and history remain domain-derived. The client
does not invent parallel ranking/time/process truth. Read models carry freshness/authority metadata.

## Cross-client

CGR-02 must provide a production-capable revision/change mechanism. Healthy active-client target:
p95 <= 5 seconds from authoritative commit to visibility on a second active client. Vendor choice is
ordinary engineering work.

## Frontend boundaries

SessionBoundary/account scope; Router/AppShell; Today; Opportunities/Detail; Capture/Decisions;
Settings; read-model query/cache; authoritative command client; design tokens/accessibility
primitives. Avoid duplicated top-level business state and global custom-event consistency as the
primary architecture.

## Design system

One authoritative token/primitives layer for typography, spacing, surfaces, status/focus,
radius/motion, buttons, fields, menus, dialog/sheet, toast, skeleton, list rows and time display.
Legacy global CSS is isolated then deleted as consumers migrate.

## Interpretation

`source acquisition/cleaning → contextual interpretation → structured candidates →
deterministic Semantic Intake policy/authorization → authoritative commands`

Models/rules may interpret but never gain independent write authority or bypass precision,
permissions, idempotency or provenance. New private-data transmission, material cost or
retention/privacy change requires applicable owner decision.

## Observability

Trace received → interpreted → policy → command → commit → projection → client visible → external
delivery (if applicable), without unnecessary raw private text. Separate transport health,
interpretation failure, business ambiguity, normal capability boundary, save failure, propagation
latency and delivery failure.

## Release

Preserve exact-SHA, authorization, migrations, security/deploy gates and disarmed publication.

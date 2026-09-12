# v1.8 — Product Surface Consolidation

## Goal

PJSDAS already has enough decision intelligence. v1.8 reduces the cognitive cost of reaching that intelligence.

The primary product question remains:

> What should I do next for my job search?

The UI therefore organizes the product around user goals rather than internal engines or data tables.

## Primary surfaces

v1.8 has five first-level surfaces:

1. **Today** — execute the next moves and capture real progress/process events.
2. **Decide** — review discovered jobs, maintain the formal opportunity pool, and track recruiting pipeline state.
3. **Prepare** — manage reusable preparation assets and inspect Prep Graph leverage.
4. **History** — audit Timeline facts and ChangeSet history.
5. **Settings** — manage Discovery Profile, Decision Rules, cloud sync, imports, language, and local backup.

The following are no longer first-level destinations:

- Discovery Inbox
- Opportunities
- Pipeline
- Prep Graph
- Application Portfolio
- Continuous Discovery Radar
- Timeline
- Decision Rules
- Backup
- Progress Update
- Process Event capture

They remain fully available, but only inside the user-goal surface where they are needed.

## Decide information architecture

Decide has three contextual tabs:

- **Discover & Review** — Discovery Inbox plus Continuous Discovery Radar.
- **Opportunities** — formal opportunity pool plus Application Portfolio decision support.
- **Pipeline** — active recruiting process state.

This preserves the underlying domain distinctions while presenting them as one decision journey:

`find → review → pursue → track`

## Today capture model

Natural Language Update and Process Event capture move next to the execution plan. They are no longer permanent global floating controls.

The user should not need to decide whether a real-world change is a “tool” before recording it. Today owns the question: what happened, and what should happen next?

## Prepare model

Prep inventory and Prep Graph are one surface:

- Prep inventory is the durable preparation asset layer.
- Prep Graph explains leverage, coverage, active needs, and trigger suggestions.

The graph remains deterministic and read-only. It does not silently create Prep Actions.

## Settings model

Settings contains policy and infrastructure, not daily work:

- Google Drive / account sync
- Discovery Profile
- Decision Rules
- Excel initialization / recovery
- local backup / restore
- interface language

This keeps important governance controls accessible without giving them equal navigation weight to Today or Decide.

## Safety and architecture

v1.8 is a surface consolidation only. It does not change:

- ChangeSet mutation semantics
- review-only MCP proposals
- Discovery quality gates
- Opportunity / Posting identity model
- Rich Opportunity facts
- component assessment aggregation
- Application Portfolio engine
- Prep Graph engine
- Continuous Discovery / refresh protocol
- local-first IndexedDB / Drive synchronization

`FixedEventGuard` remains globally mounted because it is a safety/recovery surface rather than a user-selected workspace.

## Acceptance criteria

1. First-level navigation contains exactly Today, Decide, Prepare, History, Settings.
2. Discovery, Opportunities, Pipeline, Rules, and Timeline are no longer parallel first-level navigation items.
3. Application Portfolio, Continuous Discovery Radar, and Prep Graph are contextual, not globally floating.
4. Progress Update and Process Event capture are available from Today.
5. Backup is available from Settings.
6. Existing decision engines and persistent schemas remain unchanged.
7. Existing local-first and review-only safety semantics remain unchanged.
8. Mobile layout keeps the contextual hierarchy understandable without restoring the old global Dock stack.

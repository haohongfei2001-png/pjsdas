# PJSDAS v1.4 Round 1 — Discovery Inbox

## Goal

Separate "worth keeping for later" from "promote into the real Opportunities pool". v1.3 made web discovery safe and reviewable; v1.4 Round 1 makes it durable across multiple discovery sessions without forcing every candidate into Opportunities.

## User workflow

1. ChatGPT discovers public jobs and PJSDAS quality-gates them as before.
2. The signed review page now offers **Save to Discovery Inbox** in addition to per-job Apply / Discard.
3. Saving to Inbox is an explicit write, but it does **not** create Opportunities or application Actions.
4. The new top-level **Discovery Inbox** page supports explicit lifecycle states:
   - `new`
   - `seen`
   - `later`
   - `dismissed`
   - `promoted`
5. A user can promote an Inbox candidate into Opportunities. Promotion still uses a normal local ChangeSet and the existing discovered-opportunity apply path.
6. Inbox state is part of the workspace snapshot, Google Drive sync, fingerprint/conflict model, and backup restore path.

## Re-discovery control

- `new`, `seen`, and `later` candidates are treated as already represented and are not repeatedly sent back through review.
- `dismissed` candidates suppress highly similar same-company roles for 120 days.
- `promoted` candidates are also represented in Opportunities and therefore deduplicate through the normal Opportunity path.
- `get_discovery_context` exposes Inbox summary + candidates so ChatGPT can avoid repeated public-search processing before it calls `propose_changes`.

## Safety boundaries

- Opening a signed proposal link still performs no write.
- Save to Inbox requires an explicit user click and baseline validation.
- Inbox does not auto-apply, auto-submit, or auto-promote.
- Promote to Opportunities is an explicit user action and runs through a pending ChangeSet.
- Public-source evidence remains attached to every Inbox candidate.

## Non-goals

- No automatic job applications.
- No scheduled crawler.
- No silent movement from Inbox to Opportunities.
- No learned/implicit rewriting of Discovery Profile.
- No deletion/retention automation in Round 1.

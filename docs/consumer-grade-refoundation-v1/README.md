# PJSDAS Consumer-Grade Refoundation v1

Package: `PJSDAS-CONSUMER-GRADE-REFOUNDATION-v1`  
Registration phase: `CGR-00`  
Registration baseline: `main@fbc9cb7577da14eae9855205c27f1f926d407cbf`  
Canonical truth: GitHub remote `main` + this package `STATUS.md`.

## Purpose

This is not a Product Reset. PJSDAS already has valuable domain, transactional, source, timing and
release foundations. This package preserves those foundations while replacing/refactoring the
product-facing and client-authority boundaries that prevent a mature consumer product.

Goal:

> Move PJSDAS from “many correct parts” to a stable, natural, trustworthy, high-completion
> consumer-grade baseline in which normal use does not require the owner to maintain or debug the
> system.

## Preserved foundations

- Opportunity / Process / Action / Prep semantics.
- ScheduleNode / occurrence / temporal precision.
- Deterministic Decision Rules / ranking.
- Semantic Intake policy kernel and DecisionRequest.
- Supabase transactional workspace.
- CAS / command ledger / receipts / provenance.
- Source identity / authorization / idempotency.
- Gmail cursor / lease/fencing / replay protection.
- Exact-SHA release / authorization / security gates.

Historical completion protects the invariant actually proved, not every UI, mutation path, CSS layer
or acceptance method.

## Forward authority

- UU-00..UU-07 remain historical implementation/evidence.
- This package governs forward product development after UU-07.
- UU-08/UU-09 are paused for execution order and require CGR-05 completion plus a new owner decision.
- Security, authorization, provenance, transaction integrity and no-unapproved-external-action
  boundaries remain mandatory.

## Canonical files

`PRODUCT_INTENT.md`, `TARGET_EXPERIENCE.md`, `TECHNICAL_ARCHITECTURE.md`,
`PRESERVE_REFACTOR_REPLACE.md`, `DEVELOPMENT_PLAN.md`, `VALIDATION.md`,
`MIGRATION_AND_RETIREMENT.md`, `EXECUTION_PROTOCOL.md`, `STATUS.md`, and
`phases/CGR-00.md` through `phases/CGR-05.md`.

## Completion rule

Every phase first answers: **What can the user now reliably accomplish that they could not reliably
accomplish before?**

Code existence, contract existence, green tests, page rendering, CI success, or a historical
COMPLETE label are never sufficient by themselves.

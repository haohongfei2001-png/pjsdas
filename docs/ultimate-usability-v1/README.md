# PJSDAS Ultimate Usability v1

Package: `PJSDAS-ULTIMATE-USABILITY-v1`  
Blueprint version: `1.0`  
Registration round: `UU-00`  
Canonical source of truth: GitHub remote `main` + this package `STATUS.md`

## Purpose

This package converts PJSDAS from a capable job-search control console into a product that is
easy to use without learning or maintaining the system.

The frozen user promise is:

> PJSDAS should silently maintain the job-search state from trusted sources; when the user opens it,
> they should immediately understand what to do now, what important schedule nodes are coming next,
> and the few questions that genuinely require a human decision.

The package preserves the existing transactional workspace, CAS, command ledger, receipts,
provenance, authorization, source truth, exact-SHA release gates, and no-unapproved-external-action
boundaries.

## Canonical files

- `FROZEN_BLUEPRINT.md` — registered product/UX architecture.
- `OWNER_AMENDMENTS.md` — owner-specific overrides; these win on conflict.
- `STATUS.md` — canonical package/round state.
- `EXECUTION_PROTOCOL.md` — one-round execution discipline.
- `DATA_AND_MUTATION_CONTRACT.md` — target domain/write/read contracts.
- `SOURCE_CAPABILITY_MATRIX.md` — source automation capabilities and limits.
- `UX_ACCEPTANCE_MATRIX.md` — hard UX gates and golden journeys.
- `MIGRATION_AND_ROLLBACK.md` — additive migration and rollback rules.
- `rounds/UU-00.md` … `rounds/UU-09.md` — per-round contracts.

## Precedence

1. Security, authorization, transactional integrity, source truth, and external-consequence
   constraints in the existing AI-operated production architecture remain mandatory.
2. For product information architecture, daily interaction, source intake, scheduling, and
   automatic-write policy, this package supersedes conflicting historical UI/product documents.
3. `OWNER_AMENDMENTS.md` overrides the base blueprint where explicitly stated.
4. Historical documents remain implementation history and must not be used to restore retired
   primary surfaces or maintenance-heavy workflows.

## Source artifact provenance

The registered design is based on the owner-supplied file:

- filename: `PJSDAS_Ultimate_Usability_v1_Frozen_Product_Blueprint.md`
- date: 2026-09-20
- source artifact SHA-256:
  `70233581884bcd5f0ede00f9fe310aeb66685941534964f5c7cd9dacfa82d147`

The source artifact was 1,053 lines / 67,862 bytes. This repository package splits its normative
requirements across focused canonical files rather than duplicating one monolithic implementation
document.

# Preserve / Refactor / Replace

| Area | Disposition | Treatment |
|---|---|---|
| Opportunity / Process / Action / Prep | **PRESERVE** | Keep identity/business meaning. |
| ScheduleNode / occurrence / precision | **PRESERVE BUT HARDEN** | Keep versioned time truth/date-only semantics; harden entry paths. |
| Decision Rules / ranking | **PRESERVE BUT HARDEN** | One authoritative model; improve executability/freshness/presentation. |
| Semantic Intake policy | **PRESERVE BUT HARDEN** | Improve interpretation/context upstream, not authority bypass. |
| DecisionRequest | **PRESERVE BUT HARDEN** | Keep business ambiguity; exclude technical faults from fake decisions. |
| Supabase transactional workspace | **PRESERVE** | Connected authority; no aesthetic rewrite. |
| CAS / ledger / receipts / provenance | **PRESERVE BUT HARDEN** | Add business-command/object dependency semantics. |
| Source identity / auth / idempotency | **PRESERVE** | Mandatory. |
| Gmail cursor / lease / replay | **PRESERVE BUT HARDEN** | Keep transport reliability; improve semantic coverage/exception UX. |
| Exact-SHA/security/release gates | **PRESERVE BUT HARDEN** | Add real journey evidence. |
| TodayBrief/opportunity read models | **REFACTOR** | Preserve domain computation; add action/freshness/recovery semantics. |
| Connected Web whole-snapshot daily mutation | **REPLACE** | Authoritative typed commands. |
| IndexedDB quasi-authority | **REPLACE** | Account-scoped cache/draft/pending operations. |
| Whole-workspace conflict UX | **REPLACE** | Object/command-aware merge/conflict. |
| Revision-global Undo refusal | **REFACTOR** | Dependency-aware compensation. |
| Regex/rule-dominant interpretation | **REFACTOR** | Contextual interpretation + deterministic write policy. |
| AppV8-style monolithic state/composition | **REPLACE** | Stable shell/page/query/command boundaries. |
| Major daily UI | **REPLACE THROUGH VERTICAL SLICES** | Today first, then workspace. |
| Useful existing domain UI pieces | **PRESERVE SELECTIVELY** | Only if behavior/accessibility/style ownership fit. |
| Layered global CSS/polish overrides | **REPLACE / DELETE AFTER MIGRATION** | One token/primitives owner. |
| Legacy entrypoints/write paths | **DELETE AFTER MIGRATION** | Zero-consumer + compatibility/rollback proof. |
| Source health/coverage UX | **REFACTOR** | Separate transport, interpretation, ambiguity, capability boundary. |
| Source-string tests as UX evidence | **REPLACE AS ACCEPTANCE EVIDENCE** | Static checks may remain, never certify usability. |
| Useful E2E/domain regressions | **PRESERVE BUT EXPAND** | Add dense/degraded/visual/accessibility journeys. |

A historical COMPLETE protects its proven invariant, not every UI/CSS/client-authority choice.
Conversely, “cleaner architecture” alone is insufficient reason to rewrite a working foundation.

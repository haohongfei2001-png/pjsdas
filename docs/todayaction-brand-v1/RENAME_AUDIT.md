# TA-01 rename audit

Baseline main: `153d8ccb6201e33cd1c9a09a0d7bf84a7cf0f079`. Writer: #169 after the owner explicitly parked #164 and released its writer on 2026-09-26.

## Display changes

The remote read covered all 42 TSX components, all 115 front-end TS modules, the gateway modules, all 197 unit test files and 37 browser test sources. Edits use a reviewed file/line allowlist of static product-name literals, not a repository-wide replacement. Existing persisted records, user-entered text, fixture snapshots and historical evidence are not rewritten.

| Path | Nature | Action | Verification |
| --- | --- | --- | --- |
| `gateway/addOpportunities.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/audienceAccess.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/audienceStatusHandler.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/authenticatedRemoteHttp.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/authoritativeCommands.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/authorizationGrantStore.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/automationConnectionStore.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/automationSettingsHandler.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/connectedWorkspaceHandler.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/coverageTool.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/driveWorkspaceSource.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/googleAccessTokenHandler.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/googleConnectionStore.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/googleLinkHandler.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/googleOAuthTokens.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/proposalToken.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/proposeChanges.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/readTools.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/reminderTools.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/serverFactory.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/supabaseIdentity.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/transactionalWorkspaceSource.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/transactionalWorkspaceStore.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/userCommands.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/workspaceIntegrityTool.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `gateway/workspaceSource.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/AppV8.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/ApplicationPortfolioDockHeavy.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/ContinuousDiscoveryDockHeavy.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/CoverageIndicatorHeavy.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/DecisionRequestsView.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/DiscoveryInboxViewHeavy.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/DiscoveryProfileCardHeavy.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/FixedEventGuard.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/LocalBackupDock.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/OpportunityAssessmentSummary.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/OpportunityDetailDrawer.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/PrepGraphDockHeavy.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/ProcessEventDock.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/ProgressInboxHeavy.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/RulesView.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/TellPjsdasCapture.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/ai/applicationPortfolioRead.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/ai/mcpProposal.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/ai/mcpProposalApply.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/ai/readLayer.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/aiAccess/AiAccessContext.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/aiAccess/AiAccessSettingsCard.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/aiAccess/McpProposalReview.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/aiAccess/OAuthConsentPageHeavy.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/applicationPortfolioPresentation.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/audienceAccessClient.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/backendEndpoints.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/changeSet.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/cloud/CloudSettingsCardHeavy.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/cloud/ConnectedMigrationCard.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/cloud/authoritativeCommandClient.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/cloud/cloudClientPresentation.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/cloud/cloudOperationGuard.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/cloud/cloudRepository.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/cloud/cloudSync.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/cloud/connectedMigrationService.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/cloud/driveEnvelope.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/cloud/originMigrationRecovery.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/discoveryAutomation.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/discoveryQualityReason.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/domainCommands.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/ingestionHardening.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/semanticIntake.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/snapshot.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/today/TodayFeature.tsx` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/todayBrief.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `src/webSemanticIntake.ts` | Static display/error/explanation literals | Rebrand standalone product words; retain every code, key, target and control flow | Unit/Browser and diff review |
| `api/oauth-protected-resource.ts` | Human-readable resource_name | TodayAction; resource URL, authorization servers and scopes unchanged | OAuth capability tests |
| `index.html` | Initial public name and installation metadata | TodayAction, base-aware local icons and manifest | Root/legacy built browser gate |
| `src/brand.ts`, `src/BrandMark.tsx` | Shared display identity | Static route titles and decorative A logo | Browser title/a11y readback |
| `README.md` | Current product description | TodayAction, former PJSDAS; three TSUI entries | Documentation review |
| `public/brand/` | Production asset copies | Preserve approved geometry; pinned exporter and checksums | Cloud render, decode and MIME gate |

The affected unit/browser assertions change only the expected display spelling; their authorization, receipt, identity, list, Undo and account-isolation assertions remain intact.

## Retained compatibility and historical occurrences

| Paths / occurrences | Nature | Reason |
| --- | --- | --- |
| `src/db.ts`, `src/snapshot.ts`, cloud envelopes and model type names | IndexedDB `pjsdas`, snapshot schemas, data identifiers | Existing data/import compatibility |
| `src/uiLanguage.tsx`, `captureSession.ts`, `TellPjsdasCapture.tsx`, cloud pending/checkpoint modules | `pjsdas-ui-language`, `tell-pjsdas`, account draft/pending operation keys | Existing drafts, receipts and account isolation |
| `AppV8.tsx`, component event handlers | `pjsdas:workspace-replaced`, `pjsdas-proposal`, `pjsdas.invalid` route parser base | Event and deep-link compatibility; not visible names |
| AI-access clients and Supabase constants | `pjsdas_ai_link`, `pjsdasSupabase`, `PJSDAS_*` | OAuth callbacks and configuration identity |
| `gateway/serverFactory.ts` | Server name `pjsdas`, registered tool names, schemas and annotations | MCP protocol identity; only human titles/descriptions rebrand |
| Package, Vite, release scripts, workflows, deploy configuration | `pjsdas`, `PJSDAS_*`, `/pjsdas/` | Repository, build, rollback and release compatibility |
| `src/progressInputPolicy.ts` | Historical PJSDAS semantic classifier token | Business classification is outside a display-name migration |
| Gateway operational diagnostics and source-verifier user agent | Legacy technical identity | Stable operations; no permission, provider or source identity change |
| `gateway/gmail*.ts`, #164 workflow/script/migration/tests | Parked reliability hotfix and historical/provider diagnostics | #164 scope explicitly excluded; no recovery or DDL action |
| Existing docs/reference/migrations/receipts/test fixtures | Historical/source evidence or persisted user content | Immutable evidence and backward compatibility |
| Google OAuth app/connector cards, existing iPhone installations, legal clearance | Third-party/real-device controls | DEFERRED; repository code cannot certify them |

## Installation identity

No prior manifest/service worker exists in the baseline tree or HTML. The new manifest uses stable `id: /` per origin, relative `start_url: ./today`, `scope: ./` and relative icon URLs. Canonical and historical deployments retain their existing origins/bases. Identity does not depend on the brand asset version. This adds installation metadata, not offline operation or native iOS.

## Asset provenance

Original PNG SHA-256: `33c6f1e93bcb6958d2bb0324675f7eaad92f3d152205559436eb54cf5cd9f417`.
Reference SHA-256: `3916158ffd7f8a21d52715024afb2ff8b95b4d1e78cfd0a58def6bb4a0ea8114`.
The five production SVG copies preserve the handoff bytes. Immutable design assets under docs remain unchanged. Exported pixel/byte evidence is tracked in `public/brand/ASSET_MANIFEST.json`; the cloud exporter refuses external SVG resources and checks opaque installation icons and the maskable safe circle.

## Gate evidence and follow-up

TA-01 exact candidate `8e60faa17dc5422dc09d6f56a75f68e22f54d83f` merged as `6f4fe9a6528adf40c506cea84695b44b679aa24e`; full CI/browser/root+legacy builds/matrix/VoiceOver/rollback and exact Pages/read-only production/Live Visual passed. See TA-01-RECEIPT.md. One existing local-pending sign-out browser text assertion used the configured retry; no safety assertion was weakened.

TA-02 changes display-only styles and truthful state copy, plus header-height presentation measurement. Shared synthetic fixture extraction is byte-preserving and the existing command/receipt server remains intact. Exact corrected gallery and retained before/after evidence are in TA-02-REVIEW.md. No file in #164's nine-file hotfix diff is changed by either brand batch.

TA-03 uses an anonymous read-only cloud gate for canonical and historical HTML, static asset hashes/MIME/actual decode, public release identity, and route DOM titles/visible/accessibility names. Production PASS is recorded only after actual readback. The current README's three remaining unqualified prose uses in architecture/discovery/storage become TodayAction; the explicit former name, internal environment examples and historical version policy stay intact. Repo About/homepage remains DEFERRED because metadata writes are not exposed, with observed current values recorded in EXTERNAL_GATES.md.

Device, private-workspace, provider/connector control and legal evidence remain DEFERRED. Release publication stays disarmed. No service worker, private authentication, storage purge or new native/offline promise is added.


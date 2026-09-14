# PJSDAS v1.9 — Pre-release Hardening Contract

Status: final release-candidate hardening after v1.9 entered `main`, before the production backend can deploy because of the external Vercel Hobby rolling deployment quota.

This contract covers correctness, migration safety, autonomous-ingestion assurance, workspace integrity, source health, launch acceptance, production self-test, and rollback. It does not create a generic mutation path.

## 1. Release discipline

`main` remains frozen while the production deployment quota is unavailable. Hardening is developed and validated only on `v1.9-pre-release-hardening`. Feature-branch Vercel Preview deployments are disabled, so hardening consumes GitHub CI without consuming the Vercel production quota.

PR #22 is merged only when the production deployment window is available. That merge itself is the single intended production trigger. A second release-trigger commit is permitted only if the merge produced no Vercel production deployment at all.

GitHub Pages remains backend-first: it must refuse to publish until the production backend advertises the complete hardened v1.9 health contract.

## 2. End-to-end ingestion hardening findings

### 2.1 Ambiguous Monitor identity must fail closed

The base v1.9 Monitor path could reuse the first similar Opportunity when several same-company Opportunities were semantically close. Adversarial tests reproduced this as a real correctness bug.

Hardening rule:

- a unique exact normalized role identity may auto-match;
- a single semantic winner may auto-match only when both confidence and separation are high;
- otherwise the source record is accounted as `unresolved`;
- ambiguity never silently merges two distinct roles and never creates a duplicate Opportunity merely to avoid the ambiguity.

### 2.2 Gmail message identity and logical-event identity are different

Gmail `messageId` is the immutable ingestion-ledger source-record identity. `threadId` is context only and never authorizes deduplication by itself.

For messages that are demonstrably about the same logical recruiting event, trusted upstream classification may provide:

- `eventKey`: stable logical-event identity;
- `eventState`: `scheduled | rescheduled | completed | cancelled`.

With a reliable `eventKey`:

- invitation -> reschedule -> completion remains one Process Event and one Action;
- reschedule updates timing;
- completion marks the existing Action `done`;
- cancellation marks it `skipped`;
- every Gmail message remains separately accounted in the ledger.

A reschedule/completion/cancellation without a reliable `eventKey` is downgraded to `unresolved` rather than guessed.

### 2.3 Tracking-only URL changes must not create another job

Canonical public-source URLs strip known tracking parameters before posting identity comparison. Different `utm_*`, `ref`, or equivalent tracking variants of the same source must merge/update evidence rather than create another logical Opportunity.

### 2.4 Catch-up scans, retries, and Drive writes are idempotent/fail-closed

- a seven-day Gmail catch-up scan may see an already-accounted message without duplicating Process Events or Actions;
- an exact ingestion-run retry does not write Drive a second time;
- trusted Drive writes require the exact `workspaceVersion` read before mutation;
- a concurrent browser/cloud change produces a conflict rather than last-write-wins overwrite.

## 3. Read-only real-data audit

The authoritative live local workspace is the user's browser IndexedDB. During the audit no authorized desktop device was connected, so historical files were not treated as current truth.

The most recent retrievable saved spreadsheet was the August 28 `秋招投递总表2.49.xlsx`. It was used only to identify migration-risk patterns. Current Gmail was inspected in read-only shadow mode to validate post-baseline recruiting-message shapes. Neither source was used to overwrite PJSDAS.

The audit confirmed:

1. same-company multi-role is normal, so company-only trusted matching is unsafe;
2. campus program families can run in parallel and must not be collapsed by brand name;
3. old deadlines/states become stale quickly and historical Excel must remain initialization/recovery material only;
4. process facts commonly arrive after the historical application table;
5. a generic first mail may be followed by a role-specific second mail, so unresolved-first / explicit-later resolution is necessary.

No private mailbox content, message IDs, applicant contact data, or private recruitment links are committed to the public repository.

## 4. Gmail shadow-mode validation

Real read-only Gmail shapes covered:

- direct application acknowledgements;
- assessments and written tests;
- generic assessment invitations with no role;
- interview booking followed by role-specific interview confirmation;
- one role rejected while another role at the same company remained active;
- invitation followed by reminder/reschedule;
- multiple distinct messages in one thread;
- broad campus-recruiting newsletters and marketing.

Operational rules:

- production source identity is `gmail:primary`;
- `messageId` is source-record identity;
- `threadId` is context only;
- generic recruiting marketing is `ignored` but still accounted;
- same-company multi-role ambiguity becomes `unresolved`;
- `eventKey` is used only with high-confidence same-event evidence;
- normal successful ingestion is silent; urgent actions, material process changes, unresolved exceptions, or ingestion failure may notify the user.

## 5. Source Registry and Coverage v2

Coverage is no longer permanently hard-coded to five source IDs. The five current production sources are a **bootstrap registry** for legacy/first-run compatibility; the effective registry is reconstructed from the latest policy-bearing ingestion run for each source.

Each trusted source policy contains:

- `enabled`;
- human-readable `label`;
- `cadenceMinutes`;
- `freshnessSlaMinutes`.

Current bootstrap sources are:

| Source | Stable sourceId | Cadence | Freshness SLA |
| --- | --- | ---: | ---: |
| Urgent campus-job monitor | `monitor:urgent-campus` | 24 h | 36 h |
| State-owned / foreign-enterprise monitor | `monitor:state-foreign-2027` | 24 h | 36 h |
| High-match middle-layer monitor | `monitor:middle-layer` | 24 h | 36 h |
| Key job-change monitor | `monitor:key-changes` | 24 h | 36 h |
| Recruiting Gmail ingestion | `gmail:primary` | 1 h | 2 h |

Registry semantics:

- a policy-bearing run persists the source's current cadence/SLA;
- a zero-input run may intentionally set `enabled:false`;
- a new external trusted source must provide an explicit policy before its first autonomous write;
- disabling a source changes Coverage expectations without editing Coverage code;
- explicitly having zero enabled sources does not fall back to old historical runs and cannot produce a false green state.

Global `All caught up` is true only when every currently enabled source:

1. has a durable completed run;
2. is still within its current freshness SLA;
3. has a balanced latest run (`receivedCount = accountedCount = sum(outcomes)`);
4. has no latest unresolved source record.

Low-level reconciliation functions remain usable for testing one run independently; only UI/MCP global Coverage loads the Source Registry completeness contract.

Coverage proves integrity for configured sources, not that every job on the public Internet has been discovered.

## 6. Workspace Integrity Audit

PJSDAS now has a read-only structural integrity scanner. It never repairs, deletes, merges, or rewrites data.

It reports:

- duplicate entity IDs;
- highly similar duplicate Opportunities;
- one canonical posting source attached to multiple Opportunities;
- orphan Process Events;
- Actions pointing to missing Opportunities or Process Events;
- actionable Process Events missing their persistent Action;
- closed Opportunities retaining active Actions;
- expired `not_applied` Opportunities that need newer facts.

Severity is `critical | warning | info` with an explanatory health score.

Two surfaces use the same audit logic:

- authenticated MCP read tool `get_workspace_integrity` audits the Drive-backed workspace;
- the web app uses a raw IndexedDB adapter that reads `opportunities`, `processEvents`, and `actions` directly rather than normal reconciled getters. This is deliberate: read-time repair must not hide persistent data defects from the integrity audit.

The Coverage popover now shows both autonomous-source Coverage and raw local workspace Integrity. Integrity remains report-only.

## 7. Ingestion Dry Run / Replay

Both trusted ingestion tools support a non-mutating simulation mode:

- `dryRun:true` executes full parsing/identity/quality/accounting logic without writing the workspace;
- dry-run is allowed on read-only sources;
- `replayOfRunId` is legal only with `dryRun:true`;
- replay requires a durable historical baseline run;
- the simulator removes that historical run/ledger slice from a clone before re-evaluating the newly supplied source facts;
- output compares baseline counts/outcomes with the preview result;
- replay never mutates Drive/IndexedDB.

PJSDAS does not store raw Gmail bodies or entire Monitor result payloads merely to support replay. The upstream source re-provides bounded facts using durable IDs.

## 8. Source Health / Run History

Coverage now also exposes operational source health, not just the latest accounting result.

Per-source state is one of:

`healthy | missing | stale | unresolved | unbalanced | disabled`.

Per-source diagnostics include:

- last completed run;
- next expected run time;
- freshness deadline;
- age since last completion;
- run count in the last 24 hours;
- run count in the last 7 days;
- healthy run count in the last 7 days;
- consecutive healthy runs;
- recent run outcomes.

This allows the user to distinguish “the last run was clean” from “the source has consistently been operating on schedule.”

## 9. Production Self-Test

The repository includes a read-only production self-test runnable through:

`npm run self-test:production`

It verifies:

- `/api/health` HTTP status, version, mode, and required capabilities;
- unauthenticated `/api/google-access-token` is rejected;
- anonymous authenticated-MCP endpoint access is rejected;
- when an optional test access token is supplied, authenticated `tools/list` includes:
  - `get_coverage_status`;
  - `get_workspace_integrity`;
  - `ingest_discovery_run`;
  - `ingest_gmail_run`.

If no test token exists, authenticated tool discovery is explicitly `skipped`, never falsely reported as passed.

`.github/workflows/production-self-test.yml` can run manually and after a successful Pages deployment. It performs no ingestion write.

The hardened backend-first Pages gate now requires these additional health capabilities before frontend release:

- `dynamicSourceRegistry`;
- `coverageFreshnessSla`;
- `workspaceIntegrityAudit`;
- `ingestionDryRunReplay`;
- `sourceHealthHistory`;
- `productionSelfTest`.

This prevents an earlier v1.9 backend with the same version string but an older capability set from unlocking the hardened frontend.

## 10. Migration contract for first production launch

### 10.1 Local workspace remains authoritative

- IndexedDB remains the immediate browser workspace.
- Signing in is not required to read the existing local workspace.
- First Google/PJSDAS sign-in must not automatically replace local data with Drive data.
- Logging out must not delete IndexedDB data.

### 10.2 Stable account migration

The durable Supabase session is an identity/authentication layer, not a server-side copy of the job-search database. Existing browser workspaces historically bound to the Google subject retain compatibility; the Supabase UUID remains the backend account identity.

### 10.3 Cloud conflicts remain explicit

If local and Drive lineages diverge after their last common checkpoint, auto-sync stops. Neither side is silently overwritten. Trusted background ingestion uses optimistic Drive version checks and retries only after a fresh read.

### 10.4 Historical files remain initialization/recovery material

Older Excel tables/exports are never silently replayed over an established v1.9 workspace.

## 11. First-launch acceptance checklist

The release is not fully accepted until the following pass in the user's real browser.

### Account/local data

- [ ] Existing Opportunities, Processes, Actions, Prep, rules, and history remain before sign-in.
- [ ] Sign in once with Google/PJSDAS.
- [ ] Existing local data remains immediately after sign-in.
- [ ] Refresh and remain signed in.
- [ ] Close/reopen the browser and restore the account session.
- [ ] Sign out and confirm IndexedDB remains intact.

### Drive

- [ ] Existing Drive binding restores or links without a full consent loop on every refresh.
- [ ] `Sync now` succeeds.
- [ ] No conflict is silently resolved.
- [ ] A trusted background Drive write is subsequently pulled into the browser.

### Monitor/Gmail ingestion

- [ ] Each enabled Monitor source completes at least one run with its exact sourceId.
- [ ] `gmail:primary` completes at least one durable run.
- [ ] New jobs may appear automatically without review confirmation.
- [ ] Cross-source and tracking-only duplicates do not create extra Opportunities.
- [ ] Same-company ambiguity becomes unresolved.
- [ ] Role-less Gmail for a company with several active Opportunities becomes unresolved.
- [ ] Seven-day Gmail catch-up does not duplicate old messages.
- [ ] Invitation -> reschedule -> completion with a valid eventKey remains one Event/Action and ends done.
- [ ] Invalid/missing eventKey on an event update becomes unresolved.
- [ ] Generic recruiting marketing is ignored but accounted.

### Coverage/Integrity

- [ ] Coverage starts non-green until all enabled sources have completed their first run.
- [ ] Coverage becomes green only when every enabled source is fresh, balanced, and unresolved-free.
- [ ] Source health shows cadence, next expected run, and recent healthy-run history.
- [ ] A disabled source no longer counts as missing/stale.
- [ ] Raw local IndexedDB integrity scan runs and shows its score/issues.
- [ ] `get_workspace_integrity` produces the corresponding read-only Drive audit.
- [ ] Dry-run returns predicted outcomes without writing.
- [ ] Replay compares a prior run without mutating state.

### Production self-test

- [ ] health/version/mode/capabilities pass;
- [ ] unauthenticated token/MCP access is rejected;
- [ ] authenticated MCP exposes Coverage, Integrity, and trusted ingestion tools;
- [ ] GitHub Pages backend-first gate releases only after hardened backend health is live.

## 12. Rollback contract

Rollback defaults to **code rollback, not data rollback**.

If a production defect appears:

1. stop/disable the affected trusted source if continued writes could amplify damage;
2. preserve ingestion ledger/source evidence;
3. roll back backend/frontend code to a compatible revision;
4. do not delete browser IndexedDB;
5. do not delete Drive appData workspace;
6. do not restore an old Excel export over current data;
7. do not silently choose one side of a local/Drive conflict;
8. do not delete unresolved records just to make Coverage green.

If malformed trusted data was already written, prefer a bounded evidence-driven correction with retained audit history rather than a whole-workspace rollback.

## 13. Final validation baseline

Final hardening candidate after reliability infrastructure and performance re-hardening:

- dependency audit: **0 vulnerabilities**;
- **87 test files / 359 tests passed**;
- Source Registry: **5/5**;
- Workspace Integrity: **5/5**;
- ingestion Dry Run / Replay: **4/4**;
- Source Health: **5/5**;
- Production Self-Test: **3/3**;
- pre-release ingestion hardening: **7/7**;
- Coverage freshness/completeness: **4/4**;
- Gmail entity resolution: **5/5**;
- trusted-ingestion MCP boundary: **3/3**;
- release-gate contract: **2/2**;
- TypeScript + Vite production build: **passed**;
- **181 modules transformed**;
- deferred Coverage/Integrity chunk: **17.92 kB / 6.39 kB gzip**;
- initial main JS: **495.99 kB / 151.78 kB gzip**;
- no Vite `>500 kB` warning;
- latest validated code head before this documentation-only commit: `25fb5c0d979510aa6cd24a6e4cbc33446855112d`;
- GitHub CI #608: **success**.

The remaining production blocker is external: Vercel Hobby's rolling deployment quota. The hardening branch itself must not trigger a Vercel Preview deployment.

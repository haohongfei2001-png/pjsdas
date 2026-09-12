# PJSDAS v1.9 — Pre-release Hardening Contract

Status: release candidate hardening after v1.9 entered `main`, before the production backend can deploy because of the external Vercel Hobby deployment quota.

This document is intentionally about correctness, migration safety, source coverage, launch acceptance, and rollback. It does not add another product surface or another generic mutation path.

## 1. Release discipline

`main` is treated as frozen while the production deployment quota is unavailable. Hardening changes are developed and validated on `v1.9-pre-release-hardening` only. Feature-branch Vercel Preview deployments are disabled, so iterative hardening consumes GitHub CI but does not consume the Vercel production quota.

The hardening branch must not be merged merely because unit tests pass. It is merged only as the single release candidate commit when the backend deployment window is available.

## 2. End-to-end ingestion hardening findings

### 2.1 Ambiguous Monitor identity was able to choose the first similar Opportunity

The v1.9 base implementation reused the existing logical-job matcher for Monitor observations. When several same-company Opportunities were semantically similar, the old caller could accept the first match. That behavior is unsafe for unattended ingestion.

Hardening rule:

- unique exact normalized role identity may auto-match;
- a single strong semantic winner may auto-match only when confidence and separation are both high;
- otherwise the source record is accounted as `unresolved`;
- ambiguity never creates a duplicate Opportunity and never silently merges two distinct roles.

This is implemented in `src/ingestionHardening.ts` and the production trusted-ingestion gateway routes Monitor writes through the hardened path.

### 2.2 Gmail messages need logical-event identity in addition to message identity

Gmail `messageId` remains the immutable ingestion-ledger identity. A Gmail thread is not a safe deduplication key: a thread can contain multiple distinct facts, and two messages about the same recruiting event can also live in separate threads.

For messages that explicitly describe the same logical recruiting event, trusted upstream classification may additionally provide:

- `eventKey`: stable logical recruiting-event identity;
- `eventState`: `scheduled | rescheduled | completed | cancelled`.

Hardening behavior:

- invitation -> reschedule -> completion can update one Process Event and one Action;
- reschedule updates timing instead of creating another Action;
- completion marks the existing Action `done`;
- cancellation marks it `skipped`;
- every Gmail message remains separately accounted in the ingestion ledger;
- a reschedule/completion/cancellation that lacks a reliable `eventKey` is downgraded to `unresolved` rather than guessed;
- `threadId` alone never authorizes logical-event merging.

### 2.3 Tracking-only URL changes must not create another job

Canonical public-source URLs strip known tracking parameters before posting identity is compared. A second Monitor that finds the same job URL with different `utm_*`, `ref`, or similar tracking parameters must update/merge evidence rather than create another logical Opportunity.

### 2.4 Catch-up scans and retries are idempotent

- the same source record can appear in a later Gmail seven-day catch-up scan without duplicating Process Events or Actions;
- an exact ingestion-run retry does not write Drive a second time;
- Drive writes require the exact workspace version that was read before mutation; a concurrent browser/cloud change fails closed with `WORKSPACE_CONFLICT` before overwrite.

## 3. Read-only real-data audit

The authoritative live workspace is the user's browser IndexedDB. It was not directly reachable during this hardening session because no authorized desktop device was connected. No claim is made that a historical export represents the current browser state.

The most recent retrievable saved spreadsheet was an August 28 historical job-search baseline. It was used only to inspect migration risk patterns. Current Gmail was inspected in read-only shadow mode to validate post-baseline recruiting-message shapes. Neither source was used to overwrite the live PJSDAS workspace.

The audit established these risk classes:

1. **Same-company multi-role is normal, not exceptional.** Many companies can have several simultaneous Opportunities. Company-only matching is therefore prohibited for trusted Gmail/Monitor writes unless the company has exactly one active Opportunity.
2. **Program families are not one job.** Campus programs can allow several tracks/projects to proceed in parallel. A generic company/project assessment must not be attached to another track simply because the brand matches.
3. **Historical deadlines and states become stale quickly.** An old initialization/recovery spreadsheet is not current truth and must never be replayed over newer IndexedDB/Drive state.
4. **Process facts arrive after the historical application table.** Assessments, interview booking, interview details, rejection, reminders, and reschedules must be reconciled as source facts rather than inferred from the old sheet.
5. **A generic first message can be followed by a specific second message.** The generic message remains unresolved when identity is ambiguous; the later explicit message may safely resolve to a concrete Opportunity.

No private mailbox content, message IDs, applicant contact data, or private recruitment links are stored in this public repository.

## 4. Gmail shadow-mode validation

The hourly Gmail automation was exercised against real recruiting-mail shapes while production `ingest_gmail_run` was still unavailable. It remained read-only/safe-degradation mode.

Observed message classes covered:

- direct application acknowledgements;
- assessment invitations with relative deadlines;
- generic assessment invitations with no role;
- interview-booking requests followed by a role-specific interview confirmation;
- rejection for one role while another role at the same company remained active;
- initial invitation followed by a reminder for the same logical event;
- near-duplicate operational messages in one thread;
- broad campus-recruiting newsletters, event notices, and job marketing.

Operational rules were tightened accordingly:

- fixed Gmail source identity: `gmail:primary`;
- Gmail `messageId` is the source-record identity;
- `threadId` is context only;
- generic recruiting marketing is `ignored` but still accounted;
- same-company multi-role ambiguity becomes `unresolved`;
- `eventKey` is used only when company, role, event type, and event semantics support a stable logical event;
- normal successful ingestion is silent; urgent actions, material process changes, unresolved exceptions, or ingestion failures may notify the user.

## 5. Coverage assurance model

Coverage must not be an optimistic status badge. It is a data-integrity assertion over configured sources.

Expected production sources are:

| Source | Stable sourceId | Freshness SLA |
| --- | --- | ---: |
| Urgent campus-job monitor | `monitor:urgent-campus` | 36 h |
| State-owned / foreign-enterprise monitor | `monitor:state-foreign-2027` | 36 h |
| High-match middle-layer monitor | `monitor:middle-layer` | 36 h |
| Key job-change monitor | `monitor:key-changes` | 36 h |
| Recruiting Gmail ingestion | `gmail:primary` | 2 h |

`All caught up` is true only when all of the following are true:

1. all five configured sources have at least one durable completed run;
2. each source's latest run is within its SLA;
3. for every latest run, `receivedCount = accountedCount = sum(outcomes)`;
4. no latest source-record state remains `unresolved`.

Therefore:

- a balanced run from only one source is not global coverage;
- a source that stopped running cannot remain green forever;
- a zero-result run is valid and useful if it completed and reconciled zero inputs;
- an unresolved input is not a silent loss: it is a visible exception;
- Coverage proves integrity for configured sources, not that every job on the public Internet has been discovered.

## 6. Migration contract for first production launch

The v1.9 launch must preserve the local-first data model.

### 6.1 Local workspace remains authoritative

- IndexedDB remains the immediate browser workspace.
- Signing in is not required to read the existing local workspace.
- First Google/PJSDAS sign-in must not automatically replace local data with Drive data.
- Logging out must not delete IndexedDB data.

### 6.2 Stable account migration

The durable Supabase account session is an identity/authentication layer, not a server-side copy of the job-search database.

Existing browser workspaces historically bound to the Google subject retain that ownership identity for compatibility; the Supabase account UUID remains the backend account identity. This avoids treating the same user's upgraded browser workspace as belonging to a different account.

### 6.3 Cloud conflict handling remains explicit

If local and Drive lineages both changed after the last common checkpoint:

- auto-sync stops;
- neither side is silently overwritten;
- the existing explicit keep-local/use-cloud/rebind resolution path remains in force.

Trusted background ingestion writes to Drive with optimistic version checks. If the browser changed the workspace in the meantime, background ingestion fails closed and retries from a fresh read rather than overwriting the browser's change.

### 6.4 Historical files remain initialization/recovery material only

Older Excel tables and exports are never silently replayed into an established v1.9 workspace. A historical spreadsheet can be used for initialization, recovery, or read-only audit, but not as a newer source of truth than current IndexedDB/Drive state.

## 7. First-launch acceptance checklist

The release is not considered fully accepted until all checks below pass in a real browser with the user's existing local workspace.

### Account and local data

- [ ] Existing Opportunities, Processes, Actions, Prep, rules, and history are still present before sign-in.
- [ ] Sign in with Google/PJSDAS once.
- [ ] Existing local data is still present immediately after sign-in.
- [ ] Refresh the page and remain signed in.
- [ ] Close and reopen the browser and restore the account session.
- [ ] Sign out and confirm local IndexedDB data remains intact.

### Drive sync

- [ ] Existing Drive binding is restored or explicitly linked without another full Google consent loop on every refresh.
- [ ] `Sync now` succeeds.
- [ ] No account-mismatch/local-vs-cloud conflict is silently resolved.
- [ ] A background trusted-ingestion Drive write is subsequently pulled into the browser without manual data import.

### Monitor ingestion

- [ ] Each of the four configured Monitor sources completes at least one run with its exact sourceId.
- [ ] A genuinely new job can appear automatically without review confirmation.
- [ ] The same job observed by two sources does not create two Opportunities.
- [ ] Tracking-only URL variants do not create duplicates.
- [ ] An ambiguous same-company/similar-role observation becomes `unresolved`, not an arbitrary merge.

### Gmail ingestion

- [ ] `gmail:primary` completes at least one durable run.
- [ ] A high-confidence role-specific recruiting event creates/updates the expected Process Event and Action without review confirmation.
- [ ] A role-less message for a company with multiple active Opportunities becomes `unresolved`.
- [ ] A seven-day catch-up scan does not duplicate a previously accounted message.
- [ ] Invitation -> reschedule -> completion with a valid `eventKey` remains one Process Event and one Action, ending `done`.
- [ ] A reschedule/completion without a reliable `eventKey` becomes `unresolved`.
- [ ] Recruiting newsletters/marketing are `ignored` and do not create Process Events/Actions.

### Coverage

- [ ] Coverage is initially non-green until all five expected sources have completed at least once.
- [ ] Coverage becomes green only after all five sources are fresh, balanced, and unresolved-free.
- [ ] Gmail older than 2 hours turns Coverage non-green.
- [ ] A Monitor older than 36 hours turns Coverage non-green.
- [ ] An unresolved input turns Coverage non-green even when received/accounted counts balance.
- [ ] Coverage drill-down explains every received input outcome.

## 8. Rollback contract

Rollback defaults to **code rollback, not data rollback**.

If a v1.9 production defect is discovered:

1. stop/disable the affected trusted-ingestion entry point or automation if continued writes could amplify the problem;
2. preserve the ingestion ledger and source evidence for diagnosis;
3. roll back backend/frontend code to the previous compatible revision;
4. do **not** delete the browser IndexedDB workspace;
5. do **not** delete the Drive appData workspace;
6. do **not** automatically restore an old Excel export over either workspace;
7. do **not** automatically resolve a local/Drive conflict by choosing one side;
8. do not erase unresolved records merely to make Coverage green.

The backend-first GitHub Pages release gate remains part of rollback safety: an incompatible/new frontend must not publish before the required backend health contract is live.

If malformed trusted-ingestion data was already written, repair should be evidence-driven and explicit. Prefer a bounded corrective migration/change with retained audit history over deleting the ledger or reverting the whole user's workspace.

## 9. Validation baseline

Hardening candidate validation at the time of this document:

- dependency audit: `0 vulnerabilities`;
- `82` test files / `337` tests passed;
- Monitor ambiguity hardening regression: passed;
- Gmail logical-event lifecycle regressions: passed;
- Gmail entity-resolution regressions: passed;
- Coverage missing/freshness regressions: passed;
- Drive optimistic-concurrency regressions: passed;
- TypeScript + Vite production build: passed;
- `176` modules transformed;
- initial main JS approximately `503.20 kB / 154.06 kB gzip`; Vite emits a >500 kB advisory warning, but this is not a build failure.

The remaining non-code blocker is the external Vercel Hobby rolling deployment quota. The hardening branch itself must not trigger a Vercel Preview deployment.

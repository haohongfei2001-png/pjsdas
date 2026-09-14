# PJSDAS v1.9 — Input Semantics & Attention Hardening

This contract supplements `V1_9_PRE_RELEASE_HARDENING.md`. It records the user-facing semantics added before the v1.9 production release candidate is merged.

## 1. Passive maintenance must not become a primary user surface

PJSDAS may keep internal follow-up, freshness, silence-risk, source-health, and reconciliation state when that state is useful for automation or audit. The user should not have to maintain PJSDAS itself as a recurring job-search task.

Rules:

- `follow_up` Actions are excluded from Today ranking and Today time planning.
- Decide contains only the real decision objects the user acts on: `Opportunities` and `Pipeline`; passive review is not a Decide tab.
- Discovery Inbox / review backlog size does not choose the user's Decide context and is not surfaced as a primary counter.
- Pipeline does not display `nextCheckAt`, “next review”, or review-status copy, and visible Pipeline ordering is based on recruiting stage and real progress rather than review need.
- Empty-workspace onboarding does not route the user into a review queue; it routes to Settings for discovery preferences/import while trusted ingestion supplies eligible opportunities.
- Background uncertainty, freshness and reconciliation state may remain available to Coverage, integrity/audit tooling and system logic without becoming a user task.
- A background state should enter Today only when it resolves into a concrete real-world action the user actually needs to perform.
- No underlying audit/history data is deleted merely to keep maintenance out of the foreground.

The intended attention model is therefore:

`source/monitor state -> system reconciliation -> canonical workspace fact -> real user action (only when needed)`

not:

`source/monitor state -> review queue -> user maintains the database`.

## 2. Manual role text is an alias, never canonical job identity

PJSDAS must not create duplicate Opportunities because the user omitted a character, used a shorthand role name, typed an informal title, or renamed a role with manually invented wording. A manually typed role string is evidence about which job the user means; it is never authoritative evidence for the canonical role title.

Canonical role-title authority is source-backed and identity-bound:

1. a source-backed canonical reference, currently supplied to the browser input path by non-dismissed Discovery Inbox candidates;
2. an existing Opportunity may provide its stored role as canonical only when its current `JobPostingEvidence.identityKey` still matches the Opportunity's current company + role (+ location) identity;
3. a mere historical `sourceUrl` is not enough to prove that the current stored role title is canonical;
4. an unsourced or source-drifted legacy Opportunity may be used as the existing target object, but may not supply the canonical role title;
5. otherwise the update fails closed as `unresolved`.

Rules:

- source-backed canonical jobs tolerate brand aliases, omitted characters and small role-name edits when the match is unique;
- source-backed canonical references replace manual shorthand with the source role name before write;
- if a source-backed canonical reference uniquely corresponds to an unsourced/source-drifted legacy Opportunity, PJSDAS preserves the legacy Opportunity ID but rewrites the incoming update to the source-backed company/role title; it does not create a second Opportunity;
- an unsourced legacy Opportunity cannot become canonical merely because the user's text exactly matches its old stored title;
- an Opportunity with a source URL whose stored role later drifted away from the original Job Posting identity is also non-canonical until a source-backed reference re-establishes the title;
- several similarly plausible source-backed roles remain unresolved rather than selecting the first match;
- a genuinely new manually typed role with no source-backed canonical reference does not directly create an Opportunity;
- later operations in the same input batch are relinked to the canonical Opportunity ID after canonicalization;
- MCP progress proposals inherit the fail-closed boundary: source-backed existing jobs can be updated, while unsourced/new text-only job identity cannot be introduced silently.

### Role transfer / rename

`rename_opportunity` follows the same rule. A sentence such as `A岗位转变为B岗位` does not grant the typed `B岗位` canonical authority.

- the target role must resolve uniquely to a source-backed canonical reference;
- shorthand or a missing character is rewritten to the canonical source title;
- if no source-backed target exists, the rename becomes `unresolved`;
- if the canonical target already exists as another Opportunity, PJSDAS does not rename into a duplicate; the operation fails closed so the two process identities can be reconciled deliberately.

This is intentionally conservative. Historical manually entered records are not destructively batch-renamed from guesses. They are normalized when source evidence can identify the same logical job safely, retaining the existing Opportunity ID and history.

The job-discovery/trusted-ingestion path remains the normal source-backed path for introducing a genuinely new job or a newly transferred role identity.

## 3. Non-job items are first-class manual tasks

The natural-language input surface is no longer restricted to job/company records.

Rules:

- explicit forms such as `待办：修改论文图表` become `manual_action` records;
- clear task-like non-job text can become a manual task even when the workspace contains zero Opportunities;
- product/research/life tasks must not be forced into Opportunity or recruiting Process objects;
- historical background that does not describe an actionable current task may remain `ignored`;
- uncertain recruiting-looking text remains unresolved rather than being reclassified as a general task just to avoid ambiguity.

## 4. “公司 + 测试” is recruiting shorthand when safely resolvable

Users may write a compact entry such as `小鹏测试` instead of repeating the full role name.

For `公司 + 测试`, PJSDAS chooses a target only when one of these deterministic signals is sufficient:

1. the same-company role explicitly touched immediately before in the same input batch;
2. the unique same-company Opportunity already in `assessment` stage;
3. the unique active same-company Opportunity;
4. the unique Opportunity for that company.

If several roles remain plausible, the input stays `unresolved` with candidate IDs. PJSDAS never guesses.

`公司 + 测试完成` uses the same resolution rule and marks the resolved assessment as completed.

A sentence such as `测试 PAIA 网站` is a general task, not a recruiting assessment, because it has non-job context and no company-job target.

## 5. Architecture boundary

The old V4 parser remains responsible for sentence/date/process syntax. New identity and classification policy lives in `src/progressInputPolicy.ts`.

This separation is intentional:

- parser: what did the sentence syntactically say?
- input policy: what PJSDAS object is it safe to create/update?
- Job Posting identity: which stored/source-backed title is authoritative?
- ChangeSet: what mutation is actually proposed/applied?

The browser progress-input path may still read Discovery Inbox source candidates as canonical references for safe identity resolution even though Discovery Inbox is no longer a primary user-facing Decide surface. Existing Opportunities are recognized as canonical references only while their current title remains bound to the stored Job Posting identity. The UI remains on the canonical ChangeSet mutation path.

## 6. Performance

The richer Input Policy remains deferred behind `ProgressInboxHeavy`. Removing primary Discovery Inbox / Continuous Discovery rendering from `AppV8` also reduces the eager application graph without deleting their underlying data or lower-level modules.

Validated build:

- `CoverageIndicatorHeavy`: 17.92 kB / 6.39 kB gzip
- `ProgressInboxHeavy`: 30.23 kB / 11.23 kB gzip
- initial main JS: 468.97 kB / 144.35 kB gzip
- no Vite >500 kB warning
- 175 modules transformed

## 7. Validation

Latest fully validated release-candidate head before this documentation commit:

- code head: `09d4b2ab108b4e23f81347e28b13e288e062fffa`
- CI #648: success
- dependency audit: 0 vulnerabilities
- 91 test files / 378 tests passed
- TypeScript + Vite production build: passed
- 175 modules transformed

Dedicated regressions include:

- `follow_up` absent from Today;
- no review tab/count/backlog-driven routing in primary Decide UX;
- no “next review” field or review-risk ordering in visible Pipeline;
- empty-workspace onboarding does not route into a review queue;
- role typo / missing-character canonicalization for source-backed jobs;
- source-backed shorthand -> canonical source role name;
- unsourced legacy Opportunity cannot define a canonical title, even on exact text match;
- source URL alone cannot prove a title after the stored role drifts away from the original Job Posting identity;
- source-backed reference normalizes a matching legacy Opportunity while preserving its ID;
- ambiguous same-company canonical role fail-closed;
- new unsourced manual role fail-closed;
- role-transfer rename requires a source-backed canonical target;
- role-transfer shorthand is rewritten to the canonical target title;
- rename into an already-existing canonical Opportunity fails closed instead of creating a duplicate;
- MCP progress proposal respects the same source-backed fail-closed boundary;
- non-job task with no Opportunity baseline;
- product test not mistaken for recruiting;
- company + test unique resolution;
- company + test completion;
- assessment-stage preference;
- same-batch previous-role preference;
- ambiguous company + test fail-closed.

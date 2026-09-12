# PJSDAS v1.9 — Input Semantics & Attention Hardening

This contract supplements `V1_9_PRE_RELEASE_HARDENING.md`. It records the user-facing semantics added before the v1.9 production release candidate is merged.

## 1. Passive review must not occupy Today

Pipeline follow-up/review state is useful as background state, but it is not primary work.

Rules:

- `follow_up` Actions are excluded from Today ranking and Today time planning.
- Review/follow-up state may remain in Pipeline and history for traceability.
- A review reminder must not displace applications, recruiter events, preparation, or explicit user tasks.
- No data is deleted merely to hide review noise.

This deliberately changes the older contract that allowed a small daily quota of follow-up items in Today.

## 2. Manual role text is an alias, never canonical job identity

PJSDAS must not create duplicate Opportunities because the user omitted a character, used a shorthand role name, or typed an informal title. A manually typed role string is evidence about which job the user means; it is never authoritative evidence for the canonical role title.

Canonical role-title authority is source-backed:

1. a source-backed canonical reference, currently supplied to the browser input path by non-dismissed Discovery Inbox candidates;
2. an existing Opportunity may provide its stored role as canonical only when it itself carries source evidence;
3. an unsourced legacy Opportunity may be used as the existing target object, but may not supply the canonical role title;
4. otherwise the update fails closed as `unresolved`.

Rules:

- source-backed canonical jobs tolerate brand aliases, omitted characters and small role-name edits when the match is unique;
- source-backed canonical references replace manual shorthand with the source role name before write;
- if a source-backed canonical reference uniquely corresponds to an unsourced legacy Opportunity, PJSDAS preserves the legacy Opportunity ID but rewrites the incoming update to the source-backed company/role title; it does not create a second Opportunity;
- an unsourced legacy Opportunity cannot become canonical merely because the user's text exactly matches its old stored title;
- several similarly plausible source-backed roles remain unresolved rather than selecting the first match;
- a genuinely new manually typed role with no source-backed canonical reference does not directly create an Opportunity;
- later operations in the same input batch are relinked to the canonical Opportunity ID after canonicalization;
- MCP progress proposals inherit the same boundary: a source-backed existing job can be updated, while unsourced/new text-only job identity fails closed until source evidence exists.

This is intentionally conservative. Historical manually entered records are not destructively batch-renamed from guesses. They are normalized when a source-backed reference can identify the same logical job safely, retaining the existing Opportunity ID and history.

The job-discovery/trusted-ingestion path remains the normal source-backed path for introducing a genuinely new job.

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
- ChangeSet: what mutation is actually proposed/applied?

The browser input UI reads Discovery Inbox source candidates and supplies them as canonical references. Existing source-backed Opportunities are also recognized as canonical references by the policy layer. The UI remains on the canonical ChangeSet mutation path.

## 6. Performance

The richer Input Policy initially pushed the initial JS bundle above the existing <500 kB release-hardening baseline. `ProgressInbox` was therefore split into a thin lazy wrapper plus `ProgressInboxHeavy` rather than accepting the regression.

Validated build:

- `ProgressInboxHeavy`: 29.13 kB / 10.87 kB gzip
- initial main JS: 475.16 kB / 145.92 kB gzip
- no Vite >500 kB warning

## 7. Validation

Latest validated code candidate before this documentation commit:

- code head: `06f2bb76f6ec99b3b3b09d0359ab13471b332655`
- CI #631: success
- dependency audit: 0 vulnerabilities
- 89 test files / 372 tests passed
- TypeScript + Vite production build: passed
- 183 modules transformed

Dedicated regressions include:

- review/follow-up absent from Today;
- role typo / missing-character canonicalization for source-backed jobs;
- source-backed shorthand -> official/source role name;
- unsourced legacy Opportunity cannot define a canonical title, even on exact text match;
- source-backed reference normalizes a matching legacy Opportunity while preserving its ID;
- ambiguous same-company canonical role fail-closed;
- new unsourced manual role fail-closed;
- MCP progress proposal respects the same source-backed canonical boundary;
- non-job task with no Opportunity baseline;
- product test not mistaken for recruiting;
- company + test unique resolution;
- company + test completion;
- assessment-stage preference;
- same-batch previous-role preference;
- ambiguous company + test fail-closed.

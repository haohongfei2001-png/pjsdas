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

## 2. Manual role text is an alias, not canonical job identity

PJSDAS must not create duplicate Opportunities because the user omitted a character, used a shorthand role name, or typed an informal title.

Canonical role identity is resolved in this order:

1. an existing Opportunity with a unique matching company + role identity;
2. a source-backed canonical reference, currently supplied to the browser input path by non-dismissed Discovery Inbox candidates;
3. otherwise fail closed as `unresolved`.

Rules:

- existing canonical jobs tolerate brand aliases and small role-name edits when the match is unique;
- source-backed canonical references replace manual shorthand with the source role name before write;
- several similarly plausible same-company roles remain unresolved rather than selecting the first match;
- a genuinely new manually typed role with no existing/source-backed canonical reference does not directly create an Opportunity;
- later operations in the same input batch are relinked to the canonical Opportunity ID after canonicalization;
- MCP progress proposals inherit this boundary: existing canonical jobs can be updated, but brand-new text-only job identities fail closed.

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

The browser input UI reads Discovery Inbox source candidates and supplies them as canonical references. The UI remains on the canonical ChangeSet mutation path.

## 6. Performance

The richer Input Policy initially pushed the initial JS bundle above the existing <500 kB release-hardening baseline. `ProgressInbox` was therefore split into a thin lazy wrapper plus `ProgressInboxHeavy` rather than accepting the regression.

Validated build:

- `ProgressInboxHeavy`: 28.64 kB / 10.72 kB gzip
- initial main JS: 475.16 kB / 145.92 kB gzip
- no Vite >500 kB warning

## 7. Validation

Final code candidate before this documentation commit:

- code head: `a36670c6478be5e04dc02202d198f3f4b32a684c`
- CI #624: success
- dependency audit: 0 vulnerabilities
- 89 test files / 370 tests passed
- TypeScript + Vite production build: passed
- 183 modules transformed

Dedicated regressions include:

- review/follow-up absent from Today;
- role typo / missing-character canonicalization;
- source-backed shorthand -> official role name;
- ambiguous same-company role fail-closed;
- new unsourced manual role fail-closed;
- non-job task with no Opportunity baseline;
- product test not mistaken for recruiting;
- company + test unique resolution;
- company + test completion;
- assessment-stage preference;
- same-batch previous-role preference;
- ambiguous company + test fail-closed;
- MCP progress proposal respects canonical identity.

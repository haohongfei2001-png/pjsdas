# PJSDAS AI Bridge Design

Status: **architecture proposal for v1.1+**

This document defines how PJSDAS should connect to ChatGPT and other MCP-capable AI clients without turning PJSDAS into another chat product or giving an AI unrestricted access to the user's job-search state.

The central rule is:

> **AI may read, explain, and propose. PJSDAS owns state, policy, validation, ChangeSets, and final mutation semantics.**

The current v1.0 Google Drive synchronization architecture remains unchanged by this document.

---

## 1. Product boundary

PJSDAS should not host its own general-purpose AI chat interface in v1.x.

The intended division of responsibility is:

- **ChatGPT / another AI client** — understands natural language, searches external information when appropriate, combines context, and explains results.
- **PJSDAS** — owns job-search facts, deterministic decision rules, priority computation, workflow state, Timeline, ChangeSets, and mutation validation.
- **Google Drive** — remains the user's cloud copy / synchronization storage for the PJSDAS workspace.
- **Browser IndexedDB** — remains the immediate local workspace used by the PJSDAS web UI.

Conceptually:

```text
AI client
   |
   | MCP
   v
PJSDAS AI Bridge
   |
   +---- read current state / deterministic explanations
   |
   +---- propose ChangeSet (v1.2+, never direct business-state mutation)
   |
   v
PJSDAS workspace
   |
   +---- Browser IndexedDB
   |
   +---- Google Drive appDataFolder
```

PJSDAS should therefore become an **AI-operable, user-auditable, explicitly ruled personal job-search decision system**, not an AI model provider.

---

## 2. Non-negotiable trust rules

### 2.1 Rules belong to PJSDAS, not the model

Decision Rules remain explicit, persisted, user-editable policy. The model may read and explain them. In a future write-enabled version it may propose a rule patch, but it must never silently reinterpret or replace them.

If the user asks:

> “Why is Xiaopeng above Baidu today?”

The AI should obtain PJSDAS's deterministic explanation and translate it into natural language. It should not invent a separate hidden ranking policy.

### 2.2 No direct AI mutation of business state

There must never be an MCP tool such as:

```text
set_opportunity(...)
update_pipeline_stage(...)
delete_action(...)
overwrite_workspace(...)
```

All future AI-originated mutations must first become a **pending ChangeSet**.

The safe path is:

```text
user message
  -> AI interpretation
  -> propose_* tool
  -> validated pending ChangeSet
  -> user reviews / explicitly confirms
  -> ChangeSet apply path
  -> Opportunities / Pipeline / Actions / Rules / Timeline update
```

This preserves the mutation architecture already established by PJSDAS v0.9.

### 2.3 Read tools return views, not raw storage

The AI Bridge must not expose the complete IndexedDB/Drive snapshot through a generic `get_database` or `get_snapshot` tool.

Each read tool returns the minimum structured view required for a user task. This keeps model context smaller, reduces accidental disclosure, and gives PJSDAS a stable public contract independent of internal database schema changes.

### 2.4 Fail closed

If identity, schema, snapshot validation, Drive fingerprint validation, authorization, or conflict state is uncertain, the bridge must refuse the operation rather than guess or overwrite data.

### 2.5 Google credentials are not model context

Google access tokens, refresh tokens, OAuth client secrets, Drive file IDs that do not need to be surfaced, and internal authentication metadata must never be returned to the AI model.

---

## 3. Version plan

### v1.0 — account + Google Drive synchronization

Current work. Keep IndexedDB local-first and use one validated workspace file in Google Drive `appDataFolder`.

Release only after the real two-browser Google Drive E2E acceptance chain passes.

### v1.1 — AI Bridge Alpha, read-only

Goal: prove that talking to an AI is a meaningfully better interface for understanding an existing PJSDAS workspace.

Deliver a small MCP-compatible read surface. No AI-originated writes. No job discovery automation. No in-site chatbot.

### v1.2 — conversational proposals

Add write-intent tools that can create **pending ChangeSets only**. Initially, confirmation may remain in the PJSDAS website. A later host-mediated confirmation path may allow the user to confirm from the AI client, but the underlying mutation must still be a validated ChangeSet.

### v1.3 — job discovery

The AI client searches the public web. PJSDAS supplies the user's current opportunity pool, constraints, rules and duplicate-detection context. Candidate jobs enter PJSDAS only through `propose_opportunities` -> ChangeSet -> confirmation.

PJSDAS should not build a separate general web-search crawler unless future evidence justifies it.

---

## 4. v1.1 read-only MCP contract

v1.1 should start with six tools. The names below are the public semantic contract; implementation may adapt existing internal functions without exposing their storage details.

### Common conventions

Every successful response should include:

```ts
interface BridgeMeta {
  workspaceVersion?: string
  generatedAt: string
  timezone: string
  source: 'pjsdas'
}
```

Dates exposed to the model should be ISO-8601 values plus enough timezone information for the model to reason about deadlines correctly.

Large lists must be bounded. Default limits should be conservative, with explicit pagination or continuation only if a real use case requires it.

Internal Google OAuth tokens, refresh tokens and raw Drive payloads are never part of a tool response.

---

### 4.1 `get_today_plan`

**Purpose**

Answer questions such as:

- What should I do next?
- What is most urgent today?
- Do I have enough available time for my hard deadlines?
- Which fixed interview or assessment is coming up today?

**Input**

```ts
interface GetTodayPlanInput {
  date?: string              // local YYYY-MM-DD; default = current local date
  availableMinutes?: number  // optional hypothetical override for explanation only
}
```

The override must not persist a rule or mutate workspace state.

**Output**

```ts
interface GetTodayPlanOutput {
  meta: BridgeMeta
  date: string
  availableMinutes: number
  plannedMinutes: number
  capacityConflict: boolean
  startableActions: Array<{
    actionId: string
    title: string
    company?: string
    role?: string
    kind: string
    estimatedMinutes: number
    priority: number
    dueAt?: string
    rationale: string[]
  }>
  fixedEvents: Array<{
    eventId: string
    company: string
    role: string
    label: string
    occursAt: string
  }>
  blockedOrRecoveryItems: Array<{
    id: string
    label: string
    reason: string
  }>
}
```

**Privacy boundary**

Return only items required to explain the selected day's plan. Do not attach full opportunity records or unrelated Timeline history.

---

### 4.2 `list_opportunities`

**Purpose**

Answer questions such as:

- Which jobs have I not applied to yet?
- What product roles are currently in my pool?
- Which opportunities are close to their application deadline?
- Have I already added or applied to this company/role?

**Input**

```ts
interface ListOpportunitiesInput {
  query?: string
  stage?: 'not_applied' | 'screening' | 'assessment' | 'interview' | 'offer' | 'closed'
  company?: string
  roleType?: string
  deadlineBefore?: string
  limit?: number             // default 30, hard maximum 100
}
```

**Output**

```ts
interface ListOpportunitiesOutput {
  meta: BridgeMeta
  opportunities: Array<{
    opportunityId: string
    company: string
    role: string
    stage: string
    stageLabel: string
    applicationDeadline?: string
    opportunityValue: number
    fitScore: number
    applicationGroupId?: string
    locallyManaged: boolean
  }>
  truncated: boolean
}
```

**Privacy boundary**

Do not include raw imported workbook rows, import diagnostics, or unrelated history.

---

### 4.3 `get_pipeline`

**Purpose**

Answer questions such as:

- Which applications are still alive?
- What am I waiting for?
- Which process has been silent too long?
- What interview / assessment is next?

**Input**

```ts
interface GetPipelineInput {
  stage?: string
  attentionOnly?: boolean
  company?: string
  limit?: number             // default 30, hard maximum 100
}
```

**Output**

```ts
interface GetPipelineOutput {
  meta: BridgeMeta
  processes: Array<{
    processId: string
    opportunityId?: string
    company: string
    role: string
    stage: string
    stageLabel: string
    lastProgressAt?: string
    nextCheckAt?: string
    silenceRisk?: string
    currentAction?: string
    upcomingEvent?: {
      eventId: string
      label: string
      timingSemantics: 'deadline' | 'fixed'
      occursOrDueAt: string
    }
  }>
  truncated: boolean
}
```

**Privacy boundary**

Return effective process state, not every underlying historical event unless the user explicitly requests history through `get_recent_timeline`.

---

### 4.4 `get_decision_rules`

**Purpose**

Make PJSDAS policy visible to the AI and the user.

Typical questions:

- What rules are currently controlling Today?
- How much do I value fit versus opportunity value?
- What is my deadline guardrail?
- Why does the system behave this way?

**Input**

```ts
interface GetDecisionRulesInput {}
```

**Output**

```ts
interface GetDecisionRulesOutput {
  meta: BridgeMeta
  rulesVersion: number
  updatedAt: string
  weights: Record<string, number>
  planning: Record<string, number | boolean | string>
  deadlines: Record<string, number | boolean | string>
  visibility: Record<string, number | boolean | string>
  humanSummary: string[]
}
```

The public response should map internal rule fields into documented semantic groups. This prevents the AI contract from depending on incidental UI implementation details.

**Privacy boundary**

Decision Rules are user policy and are intentionally readable. No hidden model-derived preference should be added to this response.

---

### 4.5 `explain_priority`

**Purpose**

Return PJSDAS's own deterministic explanation for an action or opportunity rather than asking the model to reverse-engineer a score.

Typical questions:

- Why is this first today?
- Why is Xiaopeng ranked above Baidu?
- What would make this role more urgent?

**Input**

```ts
interface ExplainPriorityInput {
  actionId?: string
  opportunityId?: string
  compareWithOpportunityId?: string
}
```

Exactly one primary target must be provided.

**Output**

```ts
interface ExplainPriorityOutput {
  meta: BridgeMeta
  target: {
    id: string
    type: 'action' | 'opportunity'
    label: string
  }
  score?: number
  components: Array<{
    key: string
    label: string
    contribution?: number
    value?: number | string | boolean
    explanation: string
  }>
  guardrails: Array<{
    key: string
    effect: string
    explanation: string
  }>
  comparison?: {
    targetId: string
    label: string
    score?: number
    decisiveDifferences: string[]
  }
}
```

**Implementation rule**

This tool must call/refactor the deterministic PJSDAS decision engine. Do not create a second scoring implementation specifically for MCP.

---

### 4.6 `get_recent_timeline`

**Purpose**

Answer factual history questions:

- What did I finish this week?
- What changed since Monday?
- Which applications moved forward recently?
- When did I change the decision rules?

**Input**

```ts
interface GetRecentTimelineInput {
  since?: string
  until?: string
  categories?: Array<'opportunity' | 'process' | 'action' | 'rules' | 'change' | 'data' | 'note'>
  company?: string
  opportunityId?: string
  limit?: number             // default 30, hard maximum 100
}
```

**Output**

```ts
interface GetRecentTimelineOutput {
  meta: BridgeMeta
  records: Array<{
    timelineId: string
    occurredAt: string
    recordedAt: string
    category: string
    source: string
    title: string
    company?: string
    role?: string
    opportunityId?: string
    summary?: string
  }>
  truncated: boolean
}
```

**Privacy boundary**

Do not expose discarded raw natural-language input. The current product principle remains: source text is not retained by default merely to support later AI access.

---

## 5. Standard errors

The bridge should use stable machine-readable errors so the AI can explain failure without guessing.

```ts
type BridgeErrorCode =
  | 'UNAUTHENTICATED'
  | 'AUTHORIZATION_EXPIRED'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_CONFLICT'
  | 'WORKSPACE_INVALID'
  | 'ACCOUNT_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'TOO_MANY_RESULTS'
  | 'TEMPORARILY_UNAVAILABLE'

interface BridgeError {
  code: BridgeErrorCode
  message: string
  retryable: boolean
  userAction?: string
}
```

Do not return stack traces, OAuth provider payloads, secrets, or internal storage exceptions to the model.

If the Google Drive workspace is in a conflict state, v1.1 read behavior should be conservative. The response may read the last validated cloud state if the semantics are explicit, but it must never pretend the cloud state is necessarily identical to a currently open browser's unsynced local IndexedDB state.

---

## 6. v1.1 user experience acceptance scenarios

The read-only Alpha is valuable only if these conversations are substantially easier than manually navigating the website.

### Scenario 1 — daily priority

User:

> 今天求职最应该先做什么？我只有三个小时。

Expected bridge calls:

- `get_today_plan({ availableMinutes: 180 })`
- optionally `explain_priority(...)` for the top item

Expected behavior: explain PJSDAS's deterministic plan, hard deadlines, and any capacity conflict. The hypothetical three-hour budget must not silently change saved Decision Rules.

### Scenario 2 — deadline scan

User:

> 我现在还有哪些没投、而且快截止的岗位？

Expected bridge call:

- `list_opportunities({ stage: 'not_applied', deadlineBefore: ... })`

Expected behavior: bounded list; do not invent missing deadlines.

### Scenario 3 — pipeline attention

User:

> 我哪些流程最近需要跟进？

Expected bridge call:

- `get_pipeline({ attentionOnly: true })`

Expected behavior: distinguish an actual next action from merely waiting for a result.

### Scenario 4 — explain ranking

User:

> 为什么小鹏现在比百度优先？

Expected bridge calls:

- find the two opportunity IDs if needed with `list_opportunities`
- `explain_priority({ opportunityId: ..., compareWithOpportunityId: ... })`

Expected behavior: describe the explicit PJSDAS components/guardrails, not an improvised model opinion.

### Scenario 5 — rule inspection

User:

> 现在 PJSDAS 到底有多看重城市？

Expected bridge call:

- `get_decision_rules()`

Expected behavior: return the persisted rule; do not infer a preference from conversation memory when PJSDAS already has an explicit rule.

### Scenario 6 — recent progress

User:

> 总结一下我这周秋招发生了什么。

Expected bridge call:

- `get_recent_timeline({ since: ... })`

Expected behavior: factual chronological summary based on Timeline.

### Scenario 7 — duplicate check before discovery

User:

> 我准备考虑某公司的产品经理岗，我是不是已经加过了？

Expected bridge call:

- `list_opportunities({ company: ..., query: ... })`

Expected behavior: state whether a matching PJSDAS opportunity exists; do not equate same-company different-role records without evidence.

### Scenario 8 — upcoming fixed event

User:

> 明天有没有面试或者必须在固定时间参加的东西？

Expected calls:

- `get_today_plan({ date: tomorrow })`
- possibly `get_pipeline(...)`

Expected behavior: preserve PJSDAS's `fixed` versus `deadline` timing semantics.

### Scenario 9 — stale process question

User:

> 哪个申请最久没消息了？

Expected bridge call:

- `get_pipeline({ attentionOnly: true })`

Expected behavior: use stored/recomputed process timing rather than model-estimated silence.

### Scenario 10 — no mutation in v1.1

User:

> 把城市权重降低一半。

Expected v1.1 behavior:

- `get_decision_rules()` may be used to explain the requested change.
- The bridge must say that v1.1 is read-only.
- It must not modify the rule.

This scenario is an explicit release test for the trust boundary.

---

## 7. v1.1 Alpha implementation scope

The first implementation should be deliberately small.

### In scope

1. A documented MCP server surface with the six read tools above.
2. Adapters that reuse existing PJSDAS domain/decision logic rather than duplicating it.
3. Stable IDs and bounded JSON responses.
4. Workspace/schema/fingerprint validation before any remote data is exposed.
5. Authentication sufficient for one user to connect their own PJSDAS workspace in an Alpha environment.
6. Tool-level structured logging that records tool name, result/error class and latency **without logging job-search payloads by default**.
7. Contract tests for inputs, outputs, error semantics and data minimization.
8. Manual acceptance against the ten scenarios in this document.

### Out of scope

- Any AI model hosted or paid for by PJSDAS.
- A chatbot embedded in the PJSDAS website.
- Automatic job discovery.
- Automatic application submission.
- Browser automation for employer ATS sites.
- AI-originated business-state writes.
- AI-originated rule changes.
- A `get_full_snapshot` / raw database tool.
- General access to the user's Google Drive.
- Persistent copying of the entire PJSDAS workspace into a PJSDAS-owned cloud database.
- Embedding/vectorizing all user data “just in case”.

---

## 8. Production gateway problem

The v1.0 browser architecture cannot simply be exposed to ChatGPT because a remote MCP client cannot read a user's browser IndexedDB.

A production AI Bridge therefore needs a network-accessible gateway:

```text
                  +-------------------+
                  | Browser PJSDAS    |
                  | IndexedDB         |
                  +---------+---------+
                            |
                            | Drive sync
                            v
                  +-------------------+
                  | Google Drive      |
                  | appDataFolder     |
                  +---------+---------+
                            ^
                            | validated workspace access
                            |
+-------------+      +------+-----------+
| AI client   | MCP  | PJSDAS Gateway   |
| ChatGPT etc +----->| auth + adapters  |
+-------------+      +------------------+
```

The desired property is that the gateway is an **access/coordination layer**, not the primary owner of job-search data.

---

## 9. Production authentication proposal

### 9.1 Two identities must be distinguished

A production bridge has at least two separate authorization relationships:

1. **AI client -> PJSDAS Gateway**: proves that the current AI client session is authorized to act for a PJSDAS user.
2. **PJSDAS Gateway -> Google Drive**: allows the gateway to read (and, in later versions, write) the user's PJSDAS `appDataFolder` workspace while the browser is not open.

These must not be conflated.

### 9.2 Current v1.0 token model is insufficient for unattended gateway access

v1.0 intentionally keeps a short-lived Google access token only in page memory. That is correct for a frontend-only product, but a remote MCP gateway cannot reuse a token that exists only in another browser tab.

For a production bridge, the user will need a separate server-authorized Google connection suitable for gateway access. The recommended direction is a server-side OAuth authorization-code flow with the narrowest necessary Google scopes and revocable offline access if unattended reads are required.

The exact Google OAuth client configuration must be validated during implementation; do not move a client secret into Vite or GitHub Pages.

### 9.3 Minimal credential record

The gateway may need to persist a small credential/account record such as:

```ts
interface GatewayAccountRecord {
  pjsdasUserId: string
  googleSubject: string
  encryptedGoogleRefreshCredential: string
  grantedScopes: string[]
  credentialCreatedAt: string
  credentialUpdatedAt: string
  revokedAt?: string
}
```

This is authentication infrastructure, not a copy of the user's Opportunities/Pipeline/Timeline database.

Credential encryption, key rotation, revocation, auditability and breach containment are release requirements before multi-user production use.

### 9.4 Google `appDataFolder` compatibility must be tested, not assumed

Before v1.1 production work, run an integration experiment to verify that gateway credentials issued under the intended Google Cloud application can see and validate the same `pjsdas-workspace.json` created by the existing v1.0 browser client.

If Google application identity/client configuration changes visibility semantics, define an explicit migration rather than silently creating a second independent workspace.

---

## 10. Read path in production v1.1

A read-only gateway request should use this sequence:

```text
1. Authenticate AI-client session.
2. Resolve authorized PJSDAS / Google account mapping.
3. Acquire a Google access token server-side.
4. Read only PJSDAS appDataFolder workspace metadata/content.
5. Reject duplicate workspace files.
6. Parse the Drive envelope.
7. Validate snapshot schema.
8. Recompute SHA-256 workspace fingerprint.
9. Reject fingerprint mismatch.
10. Build the requested bounded domain view.
11. Return only the documented tool response.
```

Do not return the raw Drive envelope to the model.

The bridge response should make the freshness boundary visible when useful, for example `workspaceVersion` and `generatedAt`.

---

## 11. Conflict and freshness semantics

The browser remains local-first in v1.0. Therefore the Drive copy can be behind an open browser containing unsynced local edits.

The AI Bridge must not describe Drive data as “the exact state currently visible in every browser”. It should describe it as the **latest validated cloud-synchronized PJSDAS workspace**.

For v1.1 read-only access this is acceptable, provided the UI/tool contract is explicit.

If the Drive envelope or account checkpoint indicates an unresolved synchronization conflict, the tool should return `WORKSPACE_CONFLICT` or a clearly marked read result depending on the final implementation policy. It must never choose a side automatically.

---

## 12. v1.2 write-intent architecture

v1.2 may add conversational writes, but only through ChangeSets.

Candidate tools:

```text
propose_progress_update
propose_opportunities
propose_rule_patch
get_change_set
```

These tools may create a **pending ChangeSet** but must not directly mutate Opportunities, Processes, Actions, Decision Rules, or historical facts.

### 12.1 Example: progress update

User:

> “我刚做完小鹏笔试，等结果。”

Desired sequence:

```text
AI
 -> propose_progress_update(...)
 -> PJSDAS validates identity and current state
 -> PJSDAS creates pending ChangeSet
 -> user sees exact proposed diff
 -> explicit confirmation
 -> existing PJSDAS ChangeSet apply path
 -> Timeline records the applied change
```

### 12.2 Example: rule change

User:

> “以后更看重成长性，把城市因素降低一些。”

The AI may interpret the request and call `propose_rule_patch`, but the response must show exact before/after values. No vague instruction such as “increase growth importance” may be applied without normalized numeric changes.

### 12.3 Confirmation rollout

For the safest v1.2 Alpha, the AI client creates a pending ChangeSet and the user confirms it in the PJSDAS website.

A later version may allow an `apply_change_set` tool only if all of the following are true:

- the user is shown the exact ChangeSet;
- the host provides an explicit confirmation interaction;
- the server validates ChangeSet ID, revision/fingerprint and current workspace version;
- the tool can apply only that already-created ChangeSet;
- no generic direct-mutation endpoint exists;
- the applied ChangeSet is durably recorded in Timeline.

If the host cannot guarantee that confirmation boundary, `apply_change_set` should not be exposed.

---

## 13. v1.2 concurrency considerations

Current v1.0 Drive synchronization performs a client-side optimistic version check before update. It is deliberately fail-closed but is not a claim of server-side transactional compare-and-swap.

Adding a gateway introduces another writer, so v1.2 must not assume that a browser and gateway can safely write concurrently merely because both inspect Drive `version`.

Possible staged approach:

1. **v1.1:** gateway is strictly read-only — no new write race.
2. **v1.2 Alpha:** gateway writes pending proposals only, with current Drive version/fingerprint preconditions and fail-closed conflict handling.
3. Serialize gateway writes per user to remove gateway-vs-gateway races.
4. Treat browser-vs-gateway concurrent write as a real conflict unless a stronger coordination mechanism is introduced.
5. If strict atomic cross-client writes become necessary, redesign the write path rather than advertising guarantees the Drive API integration does not actually provide.

Data safety is more important than silent convenience.

---

## 14. v1.3 job discovery architecture

Job discovery should be composed rather than rebuilt inside PJSDAS.

```text
user
  -> AI client: “Find jobs worth applying to today.”
  -> PJSDAS read tools: current pool, rules, existing applications, constraints
  -> AI client's web/search capability: discover public openings
  -> AI normalizes candidates
  -> propose_opportunities(...)
  -> PJSDAS duplicate/integrity validation
  -> pending ChangeSet
  -> user confirmation
  -> PJSDAS state
```

PJSDAS should determine whether a candidate is already present, how it fits explicit rules, and how adding it changes the action queue. The AI client can provide external research and natural-language reasoning, but it does not become the source of truth for the user's application state.

Automatic application submission remains a separate and much higher-risk product decision and is explicitly outside v1.3.

---

## 15. Security and privacy checklist before multi-user release

Before the AI Bridge moves beyond a personal Alpha:

- MCP/Gateway authentication has explicit per-user authorization.
- Google scopes are minimal and separately documented.
- Refresh credentials, if used, are encrypted at rest and never logged.
- Server logs do not contain full workspace payloads by default.
- Tool responses are bounded and data-minimized.
- Raw Drive envelopes are never exposed as a generic AI resource.
- Every write-intent request is normalized into a ChangeSet.
- Every applied AI-originated ChangeSet is auditable in Timeline.
- Account mismatch fails closed.
- Duplicate Drive workspace files fail closed.
- Invalid schema/fingerprint fails closed.
- Revoking the AI Bridge does not destroy local PJSDAS data.
- Losing/expiring AI/Gateway authorization does not prevent local PJSDAS use.
- No frontend build contains a Google client secret, gateway secret, service-account key, encryption key, or refresh token.

---

## 16. Architecture decisions to preserve

The following current PJSDAS decisions should be treated as assets, not temporary implementation details:

1. **Local-first workspace** — the website remains fully useful without an AI connection.
2. **Explicit Decision Rules** — policy is visible and user-controlled.
3. **Deterministic decision engine** — AI explains results rather than replacing them with hidden judgment.
4. **Timeline as factual audit history** — important changes remain inspectable.
5. **ChangeSet as the mutation protocol** — AI proposals use the same safety boundary as other normalized changes.
6. **Google Drive appDataFolder privacy boundary** — no requirement to browse ordinary Drive files.
7. **Fail-closed synchronization** — ambiguity creates a conflict, not an overwrite.

---

## 17. Recommended next implementation task

Do **not** implement the MCP server until v1.0 Google Drive E2E acceptance is complete.

After v1.0 is accepted and tagged, the first v1.1 engineering task should be:

1. Define TypeScript public DTOs for the six read tools.
2. Add pure adapter functions that produce these DTOs from existing PJSDAS domain state.
3. Refactor `explain_priority` from the existing deterministic decision engine rather than recomputing scores elsewhere.
4. Add contract/data-minimization tests for the adapters.
5. Only then place a minimal MCP transport around those adapters.
6. Run the ten conversational acceptance scenarios before designing any write tool.

The Alpha succeeds if a user can use ChatGPT (or another MCP client) to understand **what to do next, what is happening, and why PJSDAS decided that**, while the AI remains technically incapable of modifying the workspace.

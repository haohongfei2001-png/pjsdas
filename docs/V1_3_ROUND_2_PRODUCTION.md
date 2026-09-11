# PJSDAS v1.3 Round 2 — Production & Real E2E

## Goal

Round 2 is not another feature expansion. It is the production-readiness and real-user acceptance pass for the v1.3 discovery loop built in Round 1.

The target production path is:

**ChatGPT → authenticated PJSDAS MCP → real Google Drive workspace → get_discovery_context → ChatGPT public web search → propose_changes(discoveredOpportunities) → signed PJSDAS review → explicit Apply → Google Drive sync → ChatGPT read-back.**

## Preconditions before merge

- Pull request CI is green: tests, TypeScript build and Vite build all pass.
- Round 1 Discovery Quality Gate tests are green.
- Production Vercel build quota is available again.
- Existing v1.2 production remains functional until the v1.3 production deployment is confirmed.

Do not merge merely to make the repository version number newer while Vercel cannot deploy. A half-upgraded state where `main` says v1.3 but the production MCP still serves v1.2 is intentionally avoided.

## Public production contract

`GET /api/health` is the non-sensitive deployment marker for the primary authenticated gateway. It must report:

- service: `pjsdas-authenticated-mcp`;
- version: `1.3.0-alpha.1`;
- mode: `google-drive-readonly`;
- auth: `supabase-oauth-2.1`;
- primary MCP resource URL;
- v1.3 discovery-context, quality-gate, review-only proposal and discovered-opportunity proposal capabilities.

The public health response must not expose tokens, secret values, secret configuration booleans, user identity, Drive metadata, workspace contents or synthetic demo data.

## Automated public smoke

`scripts/v13-production-smoke.mjs` verifies the parts of production that do not require a user's OAuth bearer token:

1. `/api/health` is v1.3 and advertises the discovery capabilities.
2. unauthenticated `/api/mcp` fails closed with `401 AUTH_REQUIRED`.
3. the `WWW-Authenticate` challenge points to OAuth protected-resource metadata.
4. protected-resource metadata points back to the production `/api/mcp` resource and an authorization server.
5. GitHub Pages is allowed by the proposal-review CORS boundary.
6. the signed proposal verifier rejects an invalid capability token with `PROPOSAL_INVALID`.

A manual GitHub Actions workflow, `.github/workflows/v13-production-smoke.yml`, runs this script against the production base URL after deployment. It is intentionally `workflow_dispatch` only so ordinary commits do not repeatedly hit production or create deployment noise.

## Real ChatGPT acceptance

The public smoke cannot prove the private-data path. Final v1.3 acceptance therefore requires one real ChatGPT session with the user's existing PJSDAS OAuth connector.

### Step A — tool refresh

The connector must expose at least:

- `get_discovery_context`;
- `propose_changes` whose schema includes `discoveredOpportunities`, `postingStatus`, `sourceEvidenceText` and optional structured compensation evidence.

If ChatGPT still shows the old cached tool snapshot, refresh/rescan the existing PJSDAS connector before recreating it.

### Step B — read real discovery context

Ask:

> 使用 PJSDAS，读取我的岗位发现偏好。先不要搜索岗位，只告诉我当前 Discovery Profile、Decision Rules 里与岗位发现有关的权重，以及 workspaceVersion。

Acceptance:

- the answer is based on the real private workspace, not demo data;
- `configured` reflects the browser-saved Discovery Profile;
- the returned workspace version is a real `drive:<n>` version;
- no mutation occurs.

### Step C — real public job search and proposal

Ask:

> 使用 PJSDAS，按照我的岗位发现偏好搜索现在值得我投递的岗位。优先使用当前公开招聘页面，保留来源链接；不要编造薪资、地点或截止日期。把搜索结果交给 PJSDAS 的质量闸门，只把通过筛选的岗位生成 ChangeSet 给我审阅，不要直接修改数据。

Acceptance:

- ChatGPT reads `get_discovery_context` before searching;
- current public job sources are used outside PJSDAS;
- source-backed candidates are submitted through `propose_changes`;
- the result is `applied: false`;
- screening diagnostics explain received/accepted/duplicate/rejected/deferred counts;
- a signed review URL is returned.

### Step D — review page

Opening the URL must show source-backed discovery cards with company, role, source, known location/deadline/compensation, rationale, scores/confidence and any profile warnings.

Opening alone must not change IndexedDB or Google Drive.

### Step E — Apply and read-back

Apply only after reviewing the candidates. Then confirm Google Drive sync and ask ChatGPT to read the opportunity list again.

Acceptance:

- accepted jobs now exist as normal PJSDAS Opportunities;
- corresponding Apply actions exist;
- Timeline retains the public source reference;
- ChatGPT reads the new state from a newer Drive version;
- a rejected/discarded proposal does not modify job-search state.

## Round 2 exit criteria

Round 2 is complete only when all three layers are green:

1. **Repository:** CI/build green.
2. **Production public contract:** v1.3 health/OAuth/proposal smoke green.
3. **Private real E2E:** ChatGPT discovers at least one real source-backed job, creates a review-only ChangeSet, the user reviews/applies it, Drive sync completes, and ChatGPT reads the accepted opportunity back.

Until layer 3 passes, v1.3 may be considered deployed but not fully accepted.

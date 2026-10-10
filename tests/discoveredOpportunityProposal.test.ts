import { describe, expect, it } from 'vitest'
import { invokeProposeChanges } from '../gateway/proposeChanges.js'
import { verifySignedProposalToken } from '../gateway/proposalToken.js'
import { createFileWorkspaceSource, type WorkspaceSource } from '../gateway/workspaceSource.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { encodedProposalFromHash } from '../src/ai/mcpProposal.js'
import { createJobPostingEvidence } from '../src/jobPosting.js'
import { recruitingPagesFixture } from './fixtures/verifiedDiscovery.js'

const signingKey = 'test-only-discovery-signing-key'
const now = new Date('2026-09-11T11:30:00+08:00')
const base = createFileWorkspaceSource({ file: new URL('../gateway/fixtures/demo-workspace.json', import.meta.url), now,
  timezone: 'Asia/Shanghai', workspaceVersion: 'drive:9' })
const sourceUrl = 'https://www.liepin.com/job/9010001.shtml'
const existingUrl = 'https://www.liepin.com/job/9010000.shtml'
const candidate = { company: '候选科技', role: 'AI 产品经理校招生', sourceUrl, sourceTitle: '候选科技招聘页面',
  location: '北京', deadline: '2026-09-30T23:59:00+08:00', recruitmentBatch: '2027 届校招' }
const sourceDescription = '2027 届校招，负责 AI 产品规划与跨团队协作。'
function source(configured = true, scopeConfirmed = true, maxReviewCandidates = 6): WorkspaceSource {
  return { async read() {
    const workspace = await base.read()
    const opportunities = workspace.snapshot.data.opportunities.map(item => item.id !== 'opp-alpha' ? item : ({ ...item, detail: { ...item.detail,
      discovery: { ...item.detail!.discovery!, sourceUrl: existingUrl,
        posting: createJobPostingEvidence({ company: item.company, role: item.role, sourceUrl: existingUrl, sourceTitle: item.role, observedAt: '2026-09-01T00:00:00Z' }) } } }))
    return { ...workspace, snapshot: { ...workspace.snapshot, data: { ...workspace.snapshot.data, opportunities,
      discoveryProfile: configured ? { ...createDefaultDiscoveryProfile('2026-09-11T03:20:00Z'),
        ...(scopeConfirmed ? { searchScopeVersion: 1 as const } : {}), targetRoleQueries: ['AI 产品经理', '商业分析'],
        preferredLocations: ['北京', '上海'], mustHave: ['2027 届校招'], mustNotHave: ['纯销售'], strengths: ['Historical skill'], maxReviewCandidates } : undefined } } }
  } }
}
const resultJson = (result: Awaited<ReturnType<typeof invokeProposeChanges>>) => JSON.parse(result.content.find(item => item.type === 'text')!.text!) as any
async function envelope(result: Awaited<ReturnType<typeof invokeProposeChanges>>) {
  const token = encodedProposalFromHash(new URL(String(resultJson(result).reviewUrl)).hash)!
  return verifySignedProposalToken(token, signingKey, new Date('2026-09-11T11:31:00+08:00'))
}
function propose(candidates: typeof candidate[], workspace = source(), description = sourceDescription, runContext?: Record<string, unknown>) {
  return invokeProposeChanges(workspace, { discoveredOpportunities: candidates, ...(runContext ? { discoveryRunContext: runContext } : {}) },
    { signingKey, fetchImpl: recruitingPagesFixture(candidates.map(item => ({ ...item, description }))) })
}

describe('source-verified review-only Discovery proposals', () => {
  it('signs an exact baseline and independently fetched facts without applying them', async () => {
    const result = await propose([candidate])
    expect(result.isError).not.toBe(true)
    expect(resultJson(result)).toMatchObject({ status: 'proposal_created', applied: false, workspaceVersion: 'drive:9', operationCount: 1,
      discoveryScreening: { received: 1, accepted: 1, duplicateCount: 0, rejectedCount: 0, deferredCount: 0 } })
    const signed = await envelope(result)
    expect(signed.changeSet.expectedWorkspaceFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(signed.changeSet.operations[0]).toMatchObject({ kind: 'add_discovered_opportunity', opportunity: { company: candidate.company,
      role: candidate.role, processStage: 'not_applied', detail: { discovery: { sourceUrl, sourceTitle: `${candidate.role} - ${candidate.company}`, location: '北京', sourceVerification: 'verified' } } } })
  })
  it('requires a stored explicit profile and a confirmed current scope separately', async () => {
    expect(resultJson(await propose([candidate], source(false)))).toMatchObject({ code: 'DISCOVERY_PROFILE_REQUIRED', retryable: false })
    expect(resultJson(await propose([candidate], source(true, false)))).toMatchObject({ code: 'DISCOVERY_SCOPE_CONFIRMATION_REQUIRED', retryable: false })
  })
  it('records an exact duplicate as a zero-addition review operation while preserving supplied run context', async () => {
    const item = { ...candidate, company: '示例科技', role: '产品经理（AI方向）', sourceUrl: existingUrl }
    const context = { mode: 'incremental', queries: ['Explicit synthetic query'], searchedSourceHosts: ['www.liepin.com'] }
    const result = await propose([item], source(), sourceDescription, context)
    expect(result.isError).not.toBe(true)
    expect(resultJson(result).discoveryScreening).toMatchObject({ received: 1, accepted: 0, duplicateCount: 1 })
    const signed = await envelope(result)
    expect(signed.changeSet.operations).toHaveLength(1); expect(signed.changeSet.operations[0].kind).toBe('record_discovery_run')
    expect(signed.changeSet.discoveryRun).toMatchObject({ ...context, searchedSourceHosts: ['liepin.com'], receivedCount: 1, reviewCandidateCount: 0, duplicateCount: 1 })
  })
  it('retains source-confirmed soft location mismatches as review warnings', async () => {
    const signed = await envelope(await propose([{ ...candidate, location: '广州' }]))
    const operation = signed.changeSet.operations[0]
    expect(operation.kind).toBe('add_discovered_opportunity')
    if (operation.kind === 'add_discovered_opportunity') expect(operation.opportunity.detail?.discovery?.profileWarnings?.join(' ')).toContain('广州')
  })
  it('records source-confirmed expiry and exclusions without adding a job', async () => {
    const expired = await envelope(await propose([{ ...candidate, deadline: '2026-09-10T23:59:00+08:00' }]))
    expect(expired.changeSet.operations[0].kind).toBe('record_discovery_run')
    expect(expired.changeSet.discoveryRun).toMatchObject({ receivedCount: 1, reviewCandidateCount: 0, filteredCount: 1 })
    const excluded = await propose([candidate], source(), '2027 届校招，北京，纯销售岗位。')
    expect(resultJson(excluded).rejectedCandidates[0].reasons.join(' ')).toContain('纯销售')
    expect((await envelope(excluded)).changeSet.operations[0].kind).toBe('record_discovery_run')
  })
  it('does not rank or truncate factual candidates using historical preference limits', async () => {
    const items = Array.from({ length: 3 }, (_, index) => ({ ...candidate, company: `Synthetic ${index}`, sourceUrl: `https://www.liepin.com/job/${9020000 + index}.shtml` }))
    const result = await propose(items, source(true, true, 2))
    expect(result.isError).not.toBe(true)
    expect(resultJson(result)).toMatchObject({ operationCount: 3, discoveryScreening: { received: 3, accepted: 3, deferredCount: 0 } })
  })
  it('retains the signed token size boundary for an oversized batch of verified evidence', async () => {
    const items = Array.from({ length: 13 }, (_, index) => ({ ...candidate, company: `Synthetic ${index}`, sourceUrl: `https://www.liepin.com/job/${9030000 + index}.shtml` }))
    const result = await propose(items)
    expect(result.isError).toBe(true)
    expect(resultJson(result)).toMatchObject({ code: 'PROPOSAL_FAILED', retryable: false })
    expect(resultJson(result).message).toContain('too large')
  })
  it('rejects a non-public scheme before signing a proposal', async () => {
    const result = await propose([{ ...candidate, sourceUrl: 'javascript:alert(1)' }])
    expect(result.isError).toBe(true); expect(resultJson(result)).toMatchObject({ code: 'INVALID_ARGUMENT', retryable: false })
  })
})

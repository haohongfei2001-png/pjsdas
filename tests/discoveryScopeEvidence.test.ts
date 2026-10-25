import { describe, expect, it, vi } from 'vitest'
import { createDiscoverySourceVerifier, verifyDiscoverySourceObservation } from '../gateway/discoverySourceVerifier.js'
import { commitVerifiedDiscoveryRun } from '../gateway/verifiedDiscoveryCommit.js'
import { invokeTrustedIngestion } from '../gateway/ingestSources.js'
import { invokeProposeChanges } from '../gateway/proposeChanges.js'
import { retrieveDiscoverySourceRun } from '../gateway/discoveryAutomationWorker.js'
import type { WorkspaceSource } from '../gateway/workspaceSource.js'
import { applyVerifiedDiscoveryCommand, verifiedDiscoveryCommandSchema, verifiedDiscoveryObservationSchema, type VerifiedDiscoveryCommand } from '../src/verifiedDiscoveryCommand.js'
import { createDefaultDiscoveryProfile, type DiscoveryProfile } from '../src/discoveryProfile.js'
import { discoveryProfileManagementFingerprint } from '../src/discoveryProfileManagement.js'
import { discoveryObservationClaimSchema } from '../src/discoveryFactSchema.js'
import { discoveryScopeEvidenceSchema } from '../src/discoveryScopeEvidence.js'
import { createSnapshot } from '../src/snapshot.js'
import { offlineSearchFixture } from './fixtures/discoverySearch.rebuilt.js'
import { syntheticDiscoveryBudget } from './fixtures/discoveryBudget.js'

// Offline verifier + current domain/entry adapters. No live provider, credential,
// network, workspace or production data. All source documents are synthetic.
const at = '2026-10-25T00:00:00.000Z'
const sourceUrl = 'https://source-tenant.zhiye.com/social/detail?jobAdId=b7a408f6-9a55-4e08-9f8d-160cfff60e20'
const claim = { sourceRecordId: 'candidate:1', company: '独立来源公司', role: '产品经理', sourceUrl, sourceTitle: '产品经理' }
function profile(overrides: Partial<DiscoveryProfile> = {}): DiscoveryProfile {
  return { ...createDefaultDiscoveryProfile(at), searchScopeVersion: 1, targetRoleQueries: ['产品经理'], mustNotHave: ['劳务派遣'], ...overrides }
}
function snapshot(scope = profile()) {
  return createSnapshot({ opportunities: [], actions: [], processes: [], processEvents: [], prep: [], applicationGroups: [], timeline: [], scheduleNodes: [], discoveryProfile: scope }, at)
}
function document(description: string | undefined, visible = description ?? '', outside = '', jsonOnly = false) {
  const posting = { '@context': 'https://schema.org', '@type': 'JobPosting', url: sourceUrl,
    title: '产品经理', hiringOrganization: { '@type': 'Organization', name: '独立来源公司' }, description }
  if (jsonOnly) return JSON.stringify(posting)
  return `<html><head><title>招聘详情</title><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body><main><article><h1>产品经理</h1><dl><dt>公司名称</dt><dd>独立来源公司</dd></dl><section>${visible}</section>${outside}</article></main></body></html>`
}
function transport(raw: string) {
  return vi.fn(async () => new Response(raw, { headers: { 'content-type': 'text/html' } })) as typeof fetch
}
async function fixture(description: string | undefined, options: { visible?: string; outside?: string; jsonOnly?: boolean; profile?: DiscoveryProfile } = {}) {
  const scope = options.profile ?? profile(), raw = document(description, options.visible ?? description ?? '', options.outside, options.jsonOnly)
  const fetchImpl = transport(raw)
  const observation = await verifyDiscoverySourceObservation(claim, { now: new Date(at), fetchImpl, profile: scope })
  expect(observation.sourceVerification, observation.sourceVerificationReason).toBe('verified')
  expect(fetchImpl).toHaveBeenCalledOnce()
  const state = snapshot(scope)
  const command: VerifiedDiscoveryCommand = { kind: 'ingest_verified_discovery', commandId: 'command:scope-proof', inputFingerprint: 'a'.repeat(64), scopeFingerprint: await discoveryProfileManagementFingerprint(scope),
    run: { runId: 'run:scope-proof', sourceId: 'monitor:scope-proof', producer: 'mcp_trusted_ingestion', startedAt: at, completedAt: at,
      observations: [observation as VerifiedDiscoveryCommand['run']['observations'][number]] } }
  return { observation, command, state, raw, fetchImpl, result: applyVerifiedDiscoveryCommand(state, command, new Date(at)) }
}

describe('complete bounded posting scope evidence', () => {
  it('control: excludes forbidden employment type within the first source paragraph', async () => {
    const { result } = await fixture('本岗位采用劳务派遣用工。负责产品规划。')
    expect(result.snapshot.data.opportunities).toHaveLength(0)
    expect(result.ingestion.run.outcomes).toEqual({ filtered: 1 })
  })
  it('does not save a forbidden employment type after character 2000 of the exact job description', async () => {
    const { observation, result } = await fixture('负责产品规划与需求分析。'.repeat(210) + '本岗位采用劳务派遣用工。')
    expect(observation.sourceEvidenceText).toHaveLength(2000)
    expect(observation.scopeEvidence).toMatchObject({ coverage: 'complete', matchedExcluded: [0] })
    expect(result.snapshot.data.opportunities).toHaveLength(0)
    expect(result.ingestion.run.outcomes).toEqual({ filtered: 1 })
  })
  it('does not admit an unmarked visible body when JSON-LD omits its description', async () => {
    const { result } = await fixture(undefined, { visible: '本岗位采用劳务派遣用工。负责产品规划。' })
    expect(result.snapshot.data.opportunities).toHaveLength(0)
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
  })
  it.each(['structured', 'visible'])('does not let the other description override an exclusion in %s evidence', async where => {
    const { result } = await fixture(where === 'structured' ? '本岗位采用劳务派遣。' : '负责产品规划。', {
      visible: where === 'visible' ? '本岗位采用劳务派遣。' : '负责产品规划。',
    })
    expect(result.ingestion.run.outcomes).toEqual({ filtered: 1 })
  })
  it('admits a normal long complete description and a required condition after character 2000 without storing full text or scope proof', async () => {
    const filler = '负责产品规划与需求分析。'.repeat(210)
    const { result, observation } = await fixture(filler + '需要英文沟通。', { profile: profile({ mustHave: ['英文沟通'] }) })
    expect(result.ingestion.run.outcomes).toEqual({ created: 1 })
    expect(observation.scopeEvidence).toMatchObject({ coverage: 'complete', matchedRequired: [0], matchedExcluded: [] })
    expect(result.snapshot.data.actions).toHaveLength(0)
    expect(result.snapshot.data.scheduleNodes).toHaveLength(0)
    expect(JSON.stringify(result.snapshot)).not.toContain('scopeEvidence')
    expect(JSON.stringify(result.snapshot)).not.toContain(filler)
    expect(JSON.stringify(observation.scopeEvidence).length).toBeLessThan(500)
  })
  it('ignores genuinely hidden text without confusing it with visible auxiliary content', async () => {
    const hidden = '<span hidden>劳务派遣</span><span aria-hidden="true">劳务派遣</span><template>劳务派遣</template>'
    const { result } = await fixture(`负责产品规划。${hidden}`, { visible: `负责产品规划。${hidden}` })
    expect(result.ingestion.run.outcomes).toEqual({ created: 1 })
  })
  it('does not silently omit an ambiguous aside that may contain this job’s employment terms', async () => {
    const description = '<p>负责产品规划。</p><aside aria-label="本岗位用工说明">本岗位采用劳务派遣。</aside>'
    const { observation, result } = await fixture(description)
    expect(observation.scopeEvidence?.coverage).toBe('incomplete')
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
    expect(result.snapshot.data.opportunities).toEqual([])
  })
  it('does not silently treat an oversized description as an empty complete description', async () => {
    const { observation, result } = await fixture('x'.repeat(100001) + '劳务派遣', { visible: '产品规划岗位。' })
    expect(observation.scopeEvidence?.coverage).toBe('incomplete')
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
    expect(result.snapshot.data.opportunities).toHaveLength(0)
  })
  it('keeps missing JSON-only job content unresolved when explicit conditions need checking', async () => {
    const { observation, result } = await fixture(undefined, { jsonOnly: true })
    expect(observation.scopeEvidence?.coverage).toBe('incomplete')
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
  })
  it('does not confuse a visible title/company-only envelope with complete job body coverage', async () => {
    const { observation, result } = await fixture(undefined)
    expect(observation.scopeEvidence?.coverage).toBe('incomplete')
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
  })
  it.each(['<button type="button">立即申请</button>', '<form><input value="申请" /><button>申请</button></form>', '<a role="button" href="#apply">立即申请</a>'])('does not count an application-control shell as job body: %s', async controls => {
    const { observation, result } = await fixture(undefined, { outside: controls })
    expect(observation.scopeEvidence?.coverage).toBe('incomplete')
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
  })
  it('keeps visible employment terms inside a form in matching evidence without using controls as body proof', async () => {
    const text = '<p>负责产品规划。</p><form><label>本岗位采用劳务派遣，请确认接受</label><button>立即申请</button></form>'
    const { observation, result } = await fixture(text)
    expect(observation.scopeEvidence?.matchedExcluded).toEqual([0])
    expect(result.ingestion.run.outcomes).toEqual({ filtered: 1 })
  })
  it('cannot discard the current JobPosting merely because one of its headings links to another job', async () => {
    const otherUrl = sourceUrl.replace('b7a408f6', 'a7a408f6')
    const text = `<p>负责产品规划。</p><article itemtype="https://schema.org/JobPosting" itemid="${sourceUrl}"><h2><a href="${otherUrl}">对比其他职位</a></h2><p>本岗位采用劳务派遣。</p></article>`
    const { observation, result } = await fixture(text)
    expect(observation.scopeEvidence?.coverage).toBe('incomplete')
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
  })
  it('does not mistake tracking variants of the same native posting for a different job', async () => {
    const text = `<p>负责产品规划。</p><section itemscope itemtype="https://schema.org/JobPosting"><h2><a href="${sourceUrl}&channel=website">查看当前岗位详情</a></h2><p>本岗位采用劳务派遣。</p></section>`
    const { observation, result } = await fixture(text)
    expect(observation.scopeEvidence?.coverage).toBe('incomplete')
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
    expect(result.snapshot.data.opportunities).toEqual([])
  })
  it('never discards a mixed boundary containing both current and other posting identities', async () => {
    const otherUrl = sourceUrl.replace('b7a408f6', 'a7a408f6')
    const text = `<p>负责产品规划。</p><section itemtype="https://schema.org/JobPosting"><h2><a href="${sourceUrl}">当前岗位说明</a></h2><p>本岗位采用劳务派遣。</p><h3><a href="${otherUrl}">销售经理</a></h3></section>`
    const { observation, result } = await fixture(text)
    expect(observation.scopeEvidence?.coverage).toBe('incomplete')
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
  })
  it('does not classify a different employment-policy URL as independent other-job identity', async () => {
    const text = '<p>负责产品规划。</p><aside><h2><a href="https://company.example.com/employment-policy">用工政策</a></h2><p>本岗位采用劳务派遣。</p></aside>'
    const { observation, result } = await fixture(text)
    expect(observation.scopeEvidence?.coverage).toBe('incomplete')
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
  })
  it('does not borrow a required fact from a nested different JobPosting in structured description', async () => {
    const foreign = '<article itemscope itemtype="https://schema.org/JobPosting"><h2><a href="https://source-tenant.zhiye.com/social/detail?jobAdId=a7a408f6-9a55-4e08-9f8d-160cfff60e20">销售经理</a></h2><p>需要英文沟通。</p></article>'
    const { observation, result } = await fixture('<p>负责产品规划。</p>' + foreign, { visible: '负责产品规划。', profile: profile({ mustHave: ['英文沟通'] }) })
    expect(observation.scopeEvidence?.matchedRequired).toEqual([])
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
  })
  it('uses a positively attributed visible description field when structured description is missing', async () => {
    const { result, observation } = await fixture(undefined, { visible: '<div itemprop="description">本岗位采用劳务派遣，负责产品规划。</div>' })
    expect(observation.scopeEvidence?.coverage).toBe('complete')
    expect(result.ingestion.run.outcomes).toEqual({ filtered: 1 })
  })
  it.each(['<div itemprop="jobLocation">北京市</div>', '<div role="status" aria-live="polite">岗位详情加载中…</div>'])('does not mistake a metadata/loading shell for positively attributed body: %s', async outside => {
    const { result, observation } = await fixture(undefined, { outside })
    expect(observation.scopeEvidence?.coverage).toBe('incomplete')
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
  })
  it('does not claim complete coverage while a source explicitly signals loading', async () => {
    const { result, observation } = await fixture('负责产品规划。', { outside: '<div aria-busy="true">更多岗位信息</div>' })
    expect(observation.scopeEvidence?.coverage).toBe('incomplete')
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
  })
  it.each(['<section itemtype="https://schema.org/JobPosting"><a href="CURRENT" itemid="OTHER">当前岗位说明</a>本岗位采用劳务派遣。</section>', '<section itemtype="https://schema.org/JobPosting"><meta itemprop="url" content="CURRENT"><h2><a href="OTHER">其他岗位</a></h2>本岗位采用劳务派遣。</section>'])('keeps unsupported/mixed nested identity declarations incomplete rather than deleting them', async nested => {
    const text = '<p>负责产品规划。</p>' + nested.replaceAll('CURRENT', sourceUrl).replaceAll('OTHER', sourceUrl.replace('b7a408f6', 'a7a408f6'))
    const { result, observation } = await fixture(text)
    expect(observation.scopeEvidence?.coverage).toBe('incomplete')
    expect(result.ingestion.run.outcomes).toEqual({ unresolved: 1 })
  })
  it('does not downgrade source fact creation when no content rules were requested', async () => {
    const { result } = await fixture(undefined, { jsonOnly: true, profile: profile({ mustNotHave: [] }) })
    expect(result.ingestion.run.outcomes).toEqual({ created: 1 })
  })
  it('does not accept missing scope proof or re-evaluate a truncated excerpt under a changed scope', async () => {
    const { state, command } = await fixture('产品规划岗位。')
    delete command.run.observations[0].scopeEvidence
    expect(applyVerifiedDiscoveryCommand(state, command, new Date(at)).ingestion.run.outcomes).toEqual({ unresolved: 1 })
    const fresh = await fixture('产品规划岗位。')
    fresh.state.data.discoveryProfile!.mustNotHave = ['产品规划']
    expect(applyVerifiedDiscoveryCommand(fresh.state, fresh.command, new Date(at)).ingestion.run.outcomes).toEqual({ unresolved: 1 })
  })
  it('pins the verifier profile before asynchronous reads and prevents a caller edit replacing its admitted rules', async () => {
    const scope = profile(), verify = createDiscoverySourceVerifier({ profile: scope, now: new Date(at), fetchImpl: transport(document('劳务派遣岗位。')) })
    const fingerprint = await discoveryProfileManagementFingerprint(scope)
    scope.mustNotHave = []
    const observation = await verify(claim)
    expect(observation.scopeEvidence).toMatchObject({ scopeFingerprint: fingerprint, mustNotHave: ['劳务派遣'], matchedExcluded: [0] })
  })
  it('preserves an existing saved job and refreshes source facts even when later scope evidence is absent', async () => {
    const f = await fixture('产品规划岗位。')
    const saved = f.result.snapshot, originalId = saved.data.opportunities[0].id
    saved.data.discoveryProfile!.mustNotHave = ['产品规划']
    delete f.command.run.observations[0].scopeEvidence
    f.command.commandId = 'command:refresh'; f.command.run.runId = 'run:refresh'
    const refreshed = applyVerifiedDiscoveryCommand(saved, f.command, new Date(at))
    expect(refreshed.snapshot.data.opportunities.map(item => item.id)).toEqual([originalId])
    expect(refreshed.ingestion.run.outcomes).toEqual({ duplicate: 1 })
  })
})

describe('verified ATS facts remain part of scope evidence', () => {
  it.each([
    [{ mustHave: ['上海'], mustNotHave: [] }, 'created'],
    [{ mustHave: [], mustNotHave: ['上海'] }, 'filtered'],
    [{ mustHave: [], mustNotHave: ['产品经理'] }, 'filtered'],
  ] as const)('uses verified role/location absent from ATS description: %j', async (conditions, outcome) => {
    const scope = profile({ mustHave: [...conditions.mustHave], mustNotHave: [...conditions.mustNotHave] })
    const url = 'https://boards.greenhouse.io/synthetic/jobs/123'
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input)
      if (href === 'https://careers.example.com/jobs') return new Response(`<a href="${url}">Careers</a>`, { headers: { 'content-type': 'text/html' } })
      if (href === 'https://boards-api.greenhouse.io/v1/boards/synthetic/jobs/123') return Response.json({ id: 123, title: '产品经理', absolute_url: url,
        location: { name: '上海' }, content: '<p>负责需求调研与版本规划。</p>' })
      throw new Error('Unexpected synthetic ATS URL')
    }) as typeof fetch
    const observation = await verifyDiscoverySourceObservation({ ...claim, sourceUrl: url }, { now: new Date(at), profile: scope, fetchImpl, authorities: [{
      id: 'synthetic-ats', kind: 'ats', companyNames: ['独立来源公司'], sourceOrigin: 'https://boards.greenhouse.io', pathPrefix: '/synthetic',
      authorityOrigin: 'https://careers.example.com', authorityPage: 'https://careers.example.com/jobs', adapter: 'greenhouse', tenant: 'synthetic',
    }] })
    expect(observation.sourceVerification, observation.sourceVerificationReason).toBe('verified')
    expect(observation.sourceEvidenceText).not.toContain('上海')
    expect(observation.sourceEvidenceText).not.toContain('产品经理')
    const command: VerifiedDiscoveryCommand = { kind: 'ingest_verified_discovery', commandId: 'command:ats-scope', inputFingerprint: 'a'.repeat(64),
      scopeFingerprint: await discoveryProfileManagementFingerprint(scope), run: { sourceId: 'monitor:urgent-campus', runId: 'ats-scope', producer: 'mcp_trusted_ingestion',
        startedAt: at, completedAt: at, observations: [observation as VerifiedDiscoveryCommand['run']['observations'][number]] } }
    expect(applyVerifiedDiscoveryCommand(snapshot(scope), command, new Date(at)).ingestion.run.outcomes).toEqual({ [outcome]: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('scope proof trust and exact commit binding', () => {
  it('rejects model/caller proof, document mismatch, scope mismatch, and invalid indices', async () => {
    const { observation, command } = await fixture('产品规划岗位。')
    const proof = observation.scopeEvidence!
    expect(discoveryObservationClaimSchema.safeParse({ ...claim, scopeEvidence: proof }).success).toBe(false)
    expect(verifiedDiscoveryObservationSchema.safeParse({ ...observation, scopeEvidence: { ...proof, documentSha256: 'f'.repeat(64) } }).success).toBe(false)
    expect(verifiedDiscoveryCommandSchema.safeParse({ ...command, scopeFingerprint: 'f'.repeat(64) }).success).toBe(false)
    for (const matchedExcluded of [[1], [0, 0], [-1], [30]]) {
      expect(discoveryScopeEvidenceSchema.safeParse({ ...proof, matchedExcluded }).success).toBe(false)
    }
  })
  it('does not commit old-profile evidence after a scope edit at the authoritative read boundary', async () => {
    const { state, command } = await fixture('产品规划岗位。')
    state.data.discoveryProfile!.mustNotHave = ['产品规划']
    const write = vi.fn(async () => { throw new Error('Must not write') })
    const source: WorkspaceSource = { read: async () => ({ snapshot: state, context: { workspaceVersion: 'txn:1', now: new Date(at) } }), write,
      readCommandReceipt: async () => null }
    await expect(commitVerifiedDiscoveryRun(source, command)).rejects.toMatchObject({ code: 'DISCOVERY_SCOPE_CHANGED' })
    expect(write).not.toHaveBeenCalled()
  })
})

describe('trusted automatic-entry scope propagation without live services', () => {
  it('uses the same complete verifier in a read-only trusted-ingestion preview with zero workspace writes', async () => {
    const state = snapshot(), before = JSON.stringify(state)
    const write = vi.fn(async () => { throw new Error('Dry-run must never write') })
    const source: WorkspaceSource = { read: async () => ({ snapshot: state, context: { workspaceVersion: 'txn:1', now: new Date(at) } }), write }
    const result = await invokeTrustedIngestion(source, 'ingest_discovery_run', { sourceId: 'monitor:urgent-campus', runId: 'scope-preview',
      startedAt: at, completedAt: at, dryRun: true, observations: [claim] }, { fetchImpl: transport(document('岗位职责。'.repeat(500) + '劳务派遣。')) })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ dryRun: true, durableCommit: false, readbackVerified: false, run: { outcomes: { filtered: 1 } } })
    expect(JSON.stringify(state)).toBe(before); expect(write).not.toHaveBeenCalled()
  })
  it('carries exact current-scope proof from scheduler retrieval into its domain command', async () => {
    const state = snapshot()
    const retrieval = await retrieveDiscoverySourceRun(state, { sourceId: 'monitor:scope-proof', label: 'Synthetic scope', cadenceMinutes: 1440,
      freshnessSlaMinutes: 2160, objective: 'Synthetic public retrieval', queryHints: ['产品经理'], webQueries: [{ query: '产品经理', coverage: 'general_web' }], refreshTargets: [], maxObservations: 6 },
    { executionRules: [], now: new Date(at), ai: { ...syntheticDiscoveryBudget, ...offlineSearchFixture([{ url: sourceUrl, title: '产品经理' }]),
      generateTextImpl: async () => ({ text: JSON.stringify({ observations: [claim] }) }) }, fetchImpl: transport(document('岗位职责。'.repeat(500) + '劳务派遣。')) })
    expect(retrieval.observations[0].scopeEvidence).toMatchObject({ scopeFingerprint: await discoveryProfileManagementFingerprint(state.data.discoveryProfile!), matchedExcluded: [0] })
  })
  it('does not propose a forbidden candidate through the signed-review discovery adapter', async () => {
    const state = snapshot(), source: WorkspaceSource = { read: async () => ({ snapshot: state, context: { workspaceVersion: 'txn:1', now: new Date(at) } }) }
    const { sourceRecordId: _, ...candidate } = claim
    const result = await invokeProposeChanges(source, { discoveredOpportunities: [candidate] }, { signingKey: 'synthetic-only-key', fetchImpl: transport(document('岗位职责。'.repeat(500) + '劳务派遣。')) })
    const output = JSON.stringify(result)
    expect(output).toContain('exclusion_match')
    expect(output).not.toContain('add_discovered_opportunity')
    expect(state.data.opportunities).toEqual([])
  })
})

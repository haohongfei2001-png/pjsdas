// New regression version after workspace recovery; not the lost original file.
import { describe, expect, it, vi } from 'vitest'
import { discoveryFactClaimSchema, factualDatePrecision } from '../src/discoveryFactSchema.js'
import { verifiedDiscoveryObservationSchema } from '../src/verifiedDiscoveryCommand.js'
import { verifyDiscoverySourceObservation } from '../gateway/discoverySourceVerifier.js'
import { applyVerifiedOpportunityCommand } from '../src/verifiedOpportunityCommand.js'
import { createSnapshot } from '../src/snapshot.js'

const at = '2026-10-07T20:00:00.000Z'
const url = 'https://www.liepin.com/job/901234567890.shtml'
const claim = () => ({ company: 'Example Company', role: 'AI Product Manager', sourceUrl: url, sourceTitle: 'Example recruiting page' })
// The source document is independent of the supplied candidate. A wrong model
// claim must not rewrite the page to make itself appear verified.
const sourceJob = { '@context': 'https://schema.org', '@type': 'JobPosting', url,
  title: 'AI Product Manager', hiringOrganization: { name: 'Example Company' },
  jobLocation: { address: { addressLocality: 'Shanghai' } }, datePosted: '2026-10-01' }
function document(job: Record<string, unknown> = sourceJob, labels = '') {
  return `<!doctype html><html><head><title>AI Product Manager - Example Company</title><script type="application/ld+json">${JSON.stringify(job).replace(/</g, '\\u003c')}</script></head><body><main><article><h1>AI Product Manager</h1><dl><dt>公司名称</dt><dd>Example Company</dd>${labels}</dl><p>Copyright 2026. Campus campaign 2027.</p></article></main></body></html>`
}
function transport(body: string) {
  return vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
}
function verify(overrides: Record<string, unknown> = {}, body = document()) {
  return verifyDiscoverySourceObservation({ ...claim(), sourceRecordId: 'synthetic-candidate', discoveredAt: at, ...overrides },
    { now: new Date(at), fetchImpl: transport(body) })
}

describe('rebuilt B2 claim ownership and precise dates', () => {
  it.each(['rationale', 'roleType', 'assessment', 'fitScore', 'opportunityValue', 'discoveredAt', 'sourceVerification', 'sourceVerifiedAt', 'sourceProof', 'authority', 'postingIdentity'])('rejects producer-owned or retired %s from a candidate', field => {
    expect(discoveryFactClaimSchema.safeParse({ ...claim(), [field]: 'model-supplied' }).success).toBe(false)
  })
  it.each(['2026-02-29', '2026-13-01', '2026-04-31', '2026-10-07T24:00:00Z', '2026-10-07T20:60:00Z', '2026-10-07T20:00:00', 'tomorrow', '2026'])('never normalizes an invalid/unknown date into a deadline: %s', deadline => {
    expect(factualDatePrecision(deadline)).toBeUndefined()
    expect(discoveryFactClaimSchema.safeParse({ ...claim(), deadline }).success).toBe(false)
  })
  it('retains actual date-only precision and requires an explicit offset for timed facts', () => {
    expect(factualDatePrecision('2028-02-29')).toBe('date')
    expect(discoveryFactClaimSchema.parse({ ...claim(), deadline: '2026-10-31', deadlinePrecision: 'date' }).deadline).toBe('2026-10-31')
    expect(discoveryFactClaimSchema.parse({ ...claim(), deadline: '2026-10-31T18:00:00+08:00', deadlinePrecision: 'datetime' }).deadline).toBe('2026-10-31T18:00:00+08:00')
    expect(discoveryFactClaimSchema.safeParse({ ...claim(), deadlinePrecision: 'datetime' }).success).toBe(false)
    expect(discoveryFactClaimSchema.safeParse({ ...claim(), deadline: '2026-10-31', deadlinePrecision: 'datetime' }).success).toBe(false)
  })
})

describe('independently fetched recruiting facts', () => {
  it('uses exact fetched facts, retains unknown cutoff/batch and labels platform publication honestly', async () => {
    const value = await verify({ location: 'Model City', deadline: '2026-12-31', recruitmentBatch: 'Model batch' }, document({ ...sourceJob, validThrough: '2026-12-31' }))
    expect(value).toMatchObject({ sourceVerification: 'verified', company: 'Example Company', role: 'AI Product Manager', location: 'Shanghai',
      sourceProof: { authority: 'recruiting_platform' } })
    expect(value.deadline).toBeUndefined(); expect(value.recruitmentBatch).toBeUndefined()
    expect(value.sourceProof?.authority).not.toBe('employer')
  })
  it('extracts only explicitly attributed cutoff and recruitment batch', async () => {
    const value = await verify({}, document(sourceJob, '<dt>申请截止日期</dt><dd>2026-11-12</dd><dt>招聘批次</dt><dd>2027 campus</dd>'))
    expect(value).toMatchObject({ sourceVerification: 'verified', deadline: '2026-11-12', deadlinePrecision: 'date', recruitmentBatch: '2027 campus' })
    expect(value.sourceProof?.fields).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'deadline', value: '2026-11-12' })]))
  })
  it.each([{ company: 'Wrong Company' }, { role: 'Wrong Original Title' }])('does not use similar or model-provided identity to override a different fetched posting: %j', async mismatch => {
    const value = await verify(mismatch)
    expect(value.sourceVerification).toBe('unverified'); expect(value.sourceProof).toBeUndefined(); expect(value.deadline).toBeUndefined()
  })
  it('rejects a different addressed posting and does not trust a merely reachable unknown publisher', async () => {
    expect((await verify({}, document({ ...sourceJob, url: 'https://www.liepin.com/job/901234567891.shtml' }))).sourceVerification).toBe('unverified')
    const fetchImpl = vi.fn(async () => new Response(document()))
    const value = await verifyDiscoverySourceObservation({ ...claim(), sourceUrl: 'https://careers.example.test/jobs/one', sourceRecordId: 'unknown', discoveredAt: at }, { fetchImpl, now: new Date(at) })
    expect(value.sourceVerification).toBe('unverified'); expect(value.sourceProof).toBeUndefined()
  })
  it('cannot accept altered fields or a proof from another job through the internal domain boundary', async () => {
    const value = await verify()
    expect(verifiedDiscoveryObservationSchema.safeParse(value).success).toBe(true)
    expect(verifiedDiscoveryObservationSchema.safeParse({ ...value, location: 'Different City' }).success).toBe(false)
    expect(verifiedDiscoveryObservationSchema.safeParse({ ...value, sourceUrl: 'https://www.liepin.com/job/901234567891.shtml' }).success).toBe(false)
  })
  it.each(['moka', 'beisen'])('requires independent exact native identity even when a %s tenant shell has matching employer/title', async platform => {
    const address = platform === 'moka' ? 'https://app.mokahr.com/apply/example-org/example-site#/job/b7a408f6-9a55-4e08-9f8d-160cfff60e20'
      : 'https://example-tenant.zhiye.com/social/detail?jobAdId=b7a408f6-9a55-4e08-9f8d-160cfff60e20'
    for (const identifier of [undefined, { value: 'WRONG-JOB-ID' }]) {
      const { url: _url, ...shell } = sourceJob
      const value = await verify({ sourceUrl: address }, document({ ...shell, ...(identifier ? { identifier } : {}) }, '<dt>申请截止日期</dt><dd>2026-12-31</dd>'))
      expect(value.sourceVerification).toBe('unverified'); expect(value.sourceProof).toBeUndefined(); expect(value.deadline).toBeUndefined()
    }
  })
})

describe('verified creation stays Opportunity-only', () => {
  it('preserves existing manual work and never creates tasks/calendar/process state; exact-source retry is idempotent', async () => {
    const snapshot = createSnapshot({ opportunities: [], actions: [{ id: 'manual-existing', kind: 'manual', title: 'Prepare portfolio', status: 'todo',
      estimatedMinutes: 20, leverage: 50, delayCost: 50, createdAt: at, updatedAt: at }], processes: [], processEvents: [], prep: [], applicationGroups: [] }, at)
    const observation = await verify()
    const command = { kind: 'save_verified_discovery_opportunity' as const, commandId: 'synthetic-save', opportunityId: 'new-post', observation }
    const result = applyVerifiedOpportunityCommand(snapshot, command, new Date(at))
    expect(result.snapshot.data.opportunities).toHaveLength(1)
    expect(result.snapshot.data.actions).toEqual(snapshot.data.actions)
    expect(result.snapshot.data.scheduleNodes).toEqual(snapshot.data.scheduleNodes)
    expect(result.snapshot.data.processes).toEqual(snapshot.data.processes); expect(result.snapshot.data.processEvents).toEqual(snapshot.data.processEvents)
    const again = applyVerifiedOpportunityCommand(result.snapshot, { ...command, commandId: 'another-attempt', opportunityId: 'must-not-be-created' }, new Date(at))
    expect(again.status).toBe('ALREADY_APPLIED'); expect(again.snapshot).toBe(result.snapshot)
  })
})

// Fresh regressions rebuilt from the restored runtime. All documents/transports are synthetic.
import { describe, expect, it, vi } from 'vitest'
import { recruitingPublisherAuthority, sameRecruitingPublisherPosting } from '../gateway/discoveryPublisher.js'
import { verifyDiscoverySourceObservation } from '../gateway/discoverySourceVerifier.js'
import { canonicalizeVerifiedJobSourceUrl } from '../src/jobPosting.js'

const now = new Date('2026-10-08T00:00:00.000Z')
const id = 'b7a408f6-9a55-4e08-9f8d-160cfff60e20'
const otherId = 'a1c408f6-9a55-4e08-9f8d-160cfff60e20'
const mokaUrl = `https://app.mokahr.com/apply/source-org/source-site#/job/${id}`
const beisenUrl = `https://source-tenant.zhiye.com/social/detail?jobAdId=${id}`
// These values are authored as independent source facts, never copied from a claim.
const sourceFacts = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Product Manager',
  hiringOrganization: { '@type': 'Organization', name: 'Independent Source Company' },
  jobLocation: { address: { addressLocality: 'Shanghai' } }, datePosted: '2026-10-01' }
const sourceMoka = { ...sourceFacts, url: mokaUrl }
const sourceBeisen = { ...sourceFacts, url: beisenUrl }
function sourceDocument(job: Record<string, unknown>, wrapper: (json: string) => string = json => `<script type="application/ld+json">${json}</script>`) {
  return `<html><head><title>Independent recruiting record</title>${wrapper(JSON.stringify(job))}</head><body><main><article><h1>AI Product Manager</h1><dl><dt>公司名称</dt><dd>Independent Source Company</dd><dt>申请截止日期</dt><dd>2026-11-30</dd></dl></article></main></body></html>`
}
async function verify(sourceUrl: string, raw: string, claimOverrides: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn(async () => new Response(raw, { headers: { 'content-type': 'text/html' } })) as typeof fetch
  const result = await verifyDiscoverySourceObservation({ sourceRecordId: 'candidate-only-id', discoveredAt: now.toISOString(),
    company: 'Independent Source Company', role: 'AI Product Manager', sourceTitle: 'Model supplied source label', sourceUrl,
    location: 'Model City', deadline: '2030-01-01', recruitmentBatch: 'Model campus claim', ...claimOverrides }, { now, fetchImpl })
  return { result, fetchImpl }
}
function expectUnverified(value: Awaited<ReturnType<typeof verify>>['result']) {
  expect(value.sourceVerification).toBe('unverified')
  expect(value.sourceProof).toBeUndefined()
  expect(value.deadline).toBeUndefined()
  expect(value.location).toBeUndefined()
  expect(value.recruitmentBatch).toBeUndefined()
}

describe('rebuilt exact Moka and Beisen source identities', () => {
  it.each([
    ['Moka missing native ID', mokaUrl, undefined], ['Moka wrong native ID', mokaUrl, 'WRONG-JOB-ID'],
    ['Beisen missing native ID', beisenUrl, undefined], ['Beisen wrong native ID', beisenUrl, otherId],
  ])('P1 regression: rejects matching tenant shell with no job.url and %s', async (_label, requested, identifier) => {
    const job = { ...sourceFacts, ...(identifier ? { identifier: { value: identifier } } : {}) }
    const { result, fetchImpl } = await verify(requested!, sourceDocument(job))
    expectUnverified(result)
    expect(result.sourceVerificationReason).toContain('not addressed')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  const matrix: Array<{ name: string; url: string; job: Record<string, unknown>; accepted: boolean; claim?: Record<string, unknown> }> = [
    { name: 'Moka exact document URL', url: mokaUrl, job: sourceMoka, accepted: true },
    { name: 'Moka exact independent native ID without URL', url: mokaUrl, job: { ...sourceFacts, identifier: { value: id } }, accepted: true },
    { name: 'Moka wrong document organization', url: mokaUrl, job: { ...sourceMoka, url: mokaUrl.replace('/source-org/', '/other-org/') }, accepted: false },
    { name: 'Moka wrong document site', url: mokaUrl, job: { ...sourceMoka, url: mokaUrl.replace('/source-site#', '/other-site#') }, accepted: false },
    { name: 'Moka wrong document mode', url: mokaUrl, job: { ...sourceMoka, url: mokaUrl.replace('/apply/', '/campus_apply/') }, accepted: false },
    { name: 'Moka wrong document job ID', url: mokaUrl, job: { ...sourceMoka, url: mokaUrl.replace(id, otherId) }, accepted: false },
    { name: 'Moka native IDs are case sensitive', url: mokaUrl, job: { ...sourceFacts, identifier: { value: id.toUpperCase() } }, accepted: false },
    { name: 'Moka unrelated candidate role', url: mokaUrl, job: sourceMoka, claim: { role: 'Product Manager Intern' }, accepted: false },
    { name: 'Beisen exact document URL', url: beisenUrl, job: sourceBeisen, accepted: true },
    { name: 'Beisen exact independent native ID without URL', url: beisenUrl, job: { ...sourceFacts, identifier: { value: id } }, accepted: true },
    { name: 'Beisen UUID case is normalized', url: beisenUrl, job: { ...sourceFacts, identifier: id.toUpperCase() }, accepted: true },
    { name: 'Beisen wrong document tenant', url: beisenUrl, job: { ...sourceBeisen, url: beisenUrl.replace('source-tenant.', 'other-tenant.') }, accepted: false },
    { name: 'Beisen wrong document job ID', url: beisenUrl, job: { ...sourceBeisen, url: beisenUrl.replace(id, otherId) }, accepted: false },
    { name: 'Beisen duplicate request job ID', url: `${beisenUrl}&jobAdId=${otherId}`, job: sourceBeisen, accepted: false },
    { name: 'Beisen absent request job ID', url: 'https://source-tenant.zhiye.com/social/detail', job: sourceBeisen, accepted: false },
    { name: 'Beisen unrelated candidate employer', url: beisenUrl, job: sourceBeisen, claim: { company: 'Model Invented Company' }, accepted: false },
  ]
  it.each(matrix)('independent 16-case matrix: $name', async entry => {
    const { result } = await verify(entry.url, sourceDocument(entry.job), entry.claim)
    if (!entry.accepted) { expectUnverified(result); return }
    expect(result).toMatchObject({ sourceVerification: 'verified', company: 'Independent Source Company', role: 'AI Product Manager', location: 'Shanghai',
      deadline: '2026-11-30', postingStatus: 'unknown', sourceProof: { authority: 'recruiting_platform' } })
    expect(result.recruitmentBatch).toBeUndefined()
    const native = entry.url === mokaUrl ? JSON.stringify(['apply', 'source-org', 'source-site', id]) : JSON.stringify(['source-tenant.zhiye.com', 'social', id])
    expect(result.sourceProof?.sourceNativeId).toBe(native)
    expect(result.sourceProof?.postingIdentity).toBe(JSON.stringify([entry.url === mokaUrl ? 'recruiting-platform:moka' : 'recruiting-platform:beisen', native]))
    expect(result.sourceProof?.fields.find(field => field.field === 'company')?.value).toBe('Independent Source Company')
    expect(result.sourceRecordId).not.toBe('candidate-only-id')
    expect(result.sourceProof?.documentSha256).toMatch(/^[0-9a-f]{64}$/)
  })
  it('keeps mode, organization, site, optional site and job as distinct Moka composite keys', () => {
    const urls = [mokaUrl, mokaUrl.replace('/apply/', '/campus_apply/'), mokaUrl.replace('source-org', 'different-org'),
      mokaUrl.replace('source-site', 'different-site'), mokaUrl.replace('/source-site', ''), mokaUrl.replace(id, otherId)]
    const identities = urls.map(url => recruitingPublisherAuthority(new URL(url))?.nativePostId)
    expect(identities.every(Boolean)).toBe(true)
    expect(new Set(identities).size).toBe(6)
    const authority = recruitingPublisherAuthority(new URL(mokaUrl))!
    expect(sameRecruitingPublisherPosting(authority, new URL(mokaUrl))).toBe(true)
    for (const url of urls.slice(1)) expect(sameRecruitingPublisherPosting(authority, new URL(url))).toBe(false)
  })
  it('keeps Beisen tenant and job UUID distinct, ignoring only UUID letter case for native identity', () => {
    const authority = recruitingPublisherAuthority(new URL(beisenUrl))!
    expect(sameRecruitingPublisherPosting(authority, new URL(beisenUrl.replace(id, id.toUpperCase())))).toBe(true)
    expect(sameRecruitingPublisherPosting(authority, new URL(beisenUrl.replace('source-tenant', 'other-tenant')))).toBe(false)
    expect(sameRecruitingPublisherPosting(authority, new URL(beisenUrl.replace(id, otherId)))).toBe(false)
  })
  it.each([
    'https://app.mokahr.com/apply/source-org/source-site', `https://app.mokahr.com/apply/source-org/source-site#/apply/${id}`,
    `https://app.mokahr.com/apply/source-org/source-site#/job/${id}/apply`, `https://app.mokahr.com/other/source-org#/job/${id}`,
    `https://app.mokahr.com.evil.test/apply/source-org#/job/${id}`, `https://www.zhiye.com/social/detail?jobAdId=${id}`,
    `https://api.zhiye.com/social/detail?jobAdId=${id}`, `https://portal-oss.zhiye.com/social/detail?jobAdId=${id}`,
    `https://source-tenant.zhiye.com/campus/detail?jobAdId=${id}`, `${beisenUrl}#other`, `${beisenUrl}&jobAdId=${id}`,
    `https://source-tenant.zhiye.com/social/detail?jobAdId=not-a-uuid`, `https://source-tenant.zhiye.com.evil.test/social/detail?jobAdId=${id}`,
    mokaUrl.replace('https:', 'http:'), mokaUrl.replace('app.mokahr.com', 'user:secret@app.mokahr.com'),
  ])('does not recognize a list, application, malformed or spoofed route %s', url => {
    expect(recruitingPublisherAuthority(new URL(url))).toBeUndefined()
  })
  it.each([
    ['Moka mode', mokaUrl, mokaUrl.replace('/apply/', '/campus_apply/')],
    ['Moka organization', mokaUrl, mokaUrl.replace('source-org', 'other-org')],
    ['Moka site', mokaUrl, mokaUrl.replace('source-site', 'other-site')],
    ['Moka job', mokaUrl, mokaUrl.replace(id, otherId)],
    ['Beisen tenant', beisenUrl, beisenUrl.replace('source-tenant', 'other-tenant')],
    ['Beisen job', beisenUrl, beisenUrl.replace(id, otherId)],
  ])('blocks a redirect that changes exact %s before fetching the destination', async (_label, requested, destination) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: destination! } })) as typeof fetch
    const result = await verifyDiscoverySourceObservation({ company: 'Independent Source Company', role: 'AI Product Manager', sourceRecordId: 'claim', sourceTitle: 'Claim', sourceUrl: requested!, discoveredAt: now.toISOString() }, { fetchImpl, now })
    expectUnverified(result)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it('retains SPA and identity-bearing query fields while dropping only reviewed analytics keys', () => {
    expect(canonicalizeVerifiedJobSourceUrl(`${mokaUrl.replace('#', '?utm_source=search#')}`)).toBe(mokaUrl)
    expect(canonicalizeVerifiedJobSourceUrl(`${beisenUrl}&utm_medium=web`)).toBe(beisenUrl)
    expect(canonicalizeVerifiedJobSourceUrl(`${beisenUrl}&source=campus`)).toContain('source=campus')
    expect(canonicalizeVerifiedJobSourceUrl(mokaUrl.replace(id, otherId))).not.toBe(canonicalizeVerifiedJobSourceUrl(mokaUrl))
  })
})

describe('rebuilt publisher labels and independently parsed evidence', () => {
  it.each([
    ['boss-zhipin', 'https://www.zhipin.com/job_detail/SYNTHETIC42.html'],
    ['zhilian', 'https://jobs.zhaopin.com/CC123J456.html'],
    ['51job', 'https://jobs.51job.com/shanghai/123456789.html'],
    ['liepin', 'https://www.liepin.com/job/123456789.shtml'],
  ])('labels %s as a recruiting platform rather than employer identity', async (platform, sourceUrl) => {
    const job = { ...sourceFacts, url: sourceUrl }
    const { result } = await verify(sourceUrl!, sourceDocument(job))
    expect(result.sourceVerification).toBe('verified')
    expect(result.sourceProof?.authority).toBe('recruiting_platform')
    expect(result.sourceProof?.postingIdentity).toContain(`recruiting-platform:${platform}`)
    expect(result.sourceProof?.authorityEvidence).toBeUndefined()
    expect(result.company).toBe('Independent Source Company')
    expect(result.sourceProof?.fields.find(field => field.field === 'company')?.selector).toBe('JobPosting.hiringOrganization.name')
  })
  it('does not use the platform brand in the candidate/source title as employer evidence', async () => {
    expectUnverified((await verify(mokaUrl, sourceDocument(sourceMoka), { company: 'Moka', sourceTitle: 'Moka verified employer' })).result)
  })
  it.each([
    ['template', (json: string) => `<template><script type="application/ld+json">${json}</script></template>`],
    ['hidden', (json: string) => `<section hidden><script type="application/ld+json">${json}</script></section>`],
    ['aria-hidden', (json: string) => `<section aria-hidden="true"><script type="application/ld+json">${json}</script></section>`],
    ['display:none', (json: string) => `<section style="display:none"><script type="application/ld+json">${json}</script></section>`],
    ['SVG script', (json: string) => `<svg><script type="application/ld+json">${json}</script></svg>`],
    ['MathML script', (json: string) => `<math><script type="application/ld+json">${json}</script></math>`],
    ['noscript', (json: string) => `<noscript><script type="application/ld+json">${json}</script></noscript>`],
  ])('does not activate structured data inside %s', async (_label, wrapper) => {
    expectUnverified((await verify(mokaUrl, sourceDocument(sourceMoka, wrapper as (json: string) => string))).result)
  })
  it('rejects a redefined structured-data context', async () => {
    expectUnverified((await verify(mokaUrl, sourceDocument({ ...sourceMoka, '@context': 'https://attacker.example.test/schema' }))).result)
  })
  it('rejects malformed, ambiguous and overdeep structured documents as a whole', async () => {
    for (const raw of [sourceDocument(sourceMoka, json => `<script type="application/ld+json">${json.slice(0, -1)}</script>`),
      sourceDocument(sourceMoka, json => `<script type="application/ld+json">[${json},${json}]</script>`),
      sourceDocument(sourceMoka, json => `<script type="application/ld+json">${'['.repeat(14)}${json}${']'.repeat(14)}</script>`)]) {
      expectUnverified((await verify(mokaUrl, raw)).result)
    }
  })
})

// New, independent offline authority-chain regressions rebuilt after workspace recovery.
import { describe, expect, it, vi } from 'vitest'
import { createDomesticDiscoveryAuthorityResolver, MOE_UNIVERSITY_DIRECTORY } from '../gateway/discoveryDomesticAuthority.js'
import { documentHash } from '../gateway/discoveryHtml.js'
import { verifyDiscoverySourceObservation } from '../gateway/discoverySourceVerifier.js'

const at = '2026-10-08T00:00:00.000Z'
const root = 'https://www.example.edu.cn/'
const employment = 'https://www.example.edu.cn/admissions/'
const careers = 'https://careers.example.edu.cn/jobs/'
const candidateUrl = `${careers}42`
const row = '<dd><a class="outMoeLink" href="https://www.example.edu.cn/">示例大学</a></dd>'
const directory = (rows = row) => `<main class="moe-detail-box"><h1>教育部直属高等学校</h1><dl class="moe-schools">${rows}</dl></main>`
const home = '<html><head><title>示例大学</title></head><body><nav><a href="/admissions/">招生就业</a></nav></body></html>'
const employmentPage = '<main><h1>招生就业</h1><nav><a href="https://careers.example.edu.cn/jobs/">就业信息网</a></nav></main>'
const directHome = `<main><h1>示例大学</h1>${employmentPage}</main>`
type Page = string | (() => Response | Promise<Response>)
function fixture(overrides: Record<string, Page> = {}, clock: () => Date = () => new Date(at)) {
  const documents = new Map<string, Page>(Object.entries({ [MOE_UNIVERSITY_DIRECTORY]: directory(), [root]: home, [employment]: employmentPage, ...overrides }))
  const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
    const url = input instanceof Request ? input.url : String(input)
    const doc = documents.get(url)
    if (doc === undefined) throw new Error(`Unexpected synthetic URL ${url}; no network fallback is permitted`)
    return typeof doc === 'function' ? await doc() : new Response(doc, { headers: { 'content-type': 'text/html' } })
  }) as typeof fetch
  return { documents, fetchImpl, resolve: createDomesticDiscoveryAuthorityResolver({ fetchImpl, now: clock }) }
}

describe('rebuilt current MOE institution and recruiting authority', () => {
  it('requires an exact current directory row, independently fetched institution, and literal employment link', async () => {
    const source = fixture()
    const authority = await source.resolve(new URL(candidateUrl))
    expect(authority).toMatchObject({ id: 'cn-moe:example.edu.cn:https://careers.example.edu.cn/jobs/', kind: 'university_recruiting',
      sourceOrigin: 'https://careers.example.edu.cn', pathPrefix: '/jobs', authorityOrigin: 'https://www.example.edu.cn', authorityPage: employment,
      evidence: { publisherId: 'cn-moe-affiliated-universities', institution: '示例大学', rootUrl: root, fetchedAt: at, expiresAt: '2026-10-08T01:00:00.000Z' } })
    expect(authority?.companyNames).toBeUndefined()
    expect(authority?.evidence?.links).toHaveLength(3)
    expect(authority?.evidence?.links.map(link => [link.sourceUrl, link.targetUrl, link.quote])).toEqual([
      [MOE_UNIVERSITY_DIRECTORY, root, '示例大学'], [root, employment, '招生就业'], [employment, careers, '就业信息网'],
    ])
    for (const link of authority!.evidence!.links) {
      expect(link.selector).toMatch(/nth-of-type/)
      expect(link.documentSha256).toBe(await documentHash(source.documents.get(link.sourceUrl) as string))
    }
    expect(vi.mocked(source.fetchImpl).mock.calls.map(([input]) => String(input))).toEqual([MOE_UNIVERSITY_DIRECTORY, root, employment])
  })
  it('supports a direct institution-to-employment link without inventing a navigation hop', async () => {
    const source = fixture({ [root]: directHome })
    const authority = await source.resolve(new URL(candidateUrl))
    expect(authority?.evidence?.links).toHaveLength(2)
    expect(authority?.authorityPage).toBe(root)
    expect(source.fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('can verify the company named by a university publication without labeling the university as employer', async () => {
    // The candidate and employer source document are separately authored fixtures.
    const job = { '@context': 'https://schema.org', '@type': 'JobPosting', url: candidateUrl, title: 'AI Product Manager', hiringOrganization: { name: 'Independent Company' } }
    const raw = `<script type="application/ld+json">${JSON.stringify(job)}</script><article><h1>AI Product Manager</h1><dl><dt>公司名称</dt><dd>Independent Company</dd></dl></article>`
    const source = fixture({ [candidateUrl]: raw })
    const result = await verifyDiscoverySourceObservation({ sourceRecordId: 'candidate', company: 'Independent Company', role: 'AI Product Manager',
      sourceUrl: candidateUrl, sourceTitle: 'Candidate label', discoveredAt: at }, { fetchImpl: source.fetchImpl, resolveAuthority: source.resolve, now: new Date(at) })
    expect(result).toMatchObject({ company: 'Independent Company', sourceVerification: 'verified', sourceProof: { authority: 'university_recruiting',
      authorityEvidence: { institution: '示例大学' } } })
    expect(result.sourceProof?.fields.find(field => field.field === 'company')?.selector).toBe('JobPosting.hiringOrganization.name')
  })
  it.each([
    ['same-name other institution domain', '<dd><a class="outMoeLink" href="https://www.other.edu.cn/">示例大学</a></dd>'],
    ['lookalike suffix', '<dd><a class="outMoeLink" href="https://www.example.edu.cn.evil.test/">示例大学</a></dd>'],
    ['unapproved edu.cn lookalike', '<dd><a class="outMoeLink" href="https://www.examp1e.edu.cn/">示例大学</a></dd>'],
    ['query-bearing institution link', '<dd><a class="outMoeLink" href="https://www.example.edu.cn/?target=other">示例大学</a></dd>'],
    ['fragment-bearing institution link', '<dd><a class="outMoeLink" href="https://www.example.edu.cn/#other">示例大学</a></dd>'],
    ['generic row label', '<dd><a class="outMoeLink" href="https://www.example.edu.cn/">点击这里</a></dd>'],
    ['missing current row class', '<dd><a href="https://www.example.edu.cn/">示例大学</a></dd>'],
    ['nested row anchor', '<dd><div><a class="outMoeLink" href="https://www.example.edu.cn/">示例大学</a></div></dd>'],
    ['hidden directory row', `<dd hidden>${row.replace(/^<dd>|<\/dd>$/g, '')}</dd>`],
    ['advertisement directory row', `<dd class="ads">${row.replace(/^<dd>|<\/dd>$/g, '')}</dd>`],
  ])('rejects a non-authoritative directory match: %s', async (_label, rows) => {
    const source = fixture({ [MOE_UNIVERSITY_DIRECTORY]: directory(rows) })
    expect(await source.resolve(new URL(candidateUrl))).toBeUndefined()
    expect(source.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('cannot substitute a same-name footer or news link for the exact current directory row', async () => {
    const source = fixture({ [MOE_UNIVERSITY_DIRECTORY]: `${directory('<dd>Other University</dd>')}<footer><a class="outMoeLink" href="${root}">示例大学</a></footer>` })
    expect(await source.resolve(new URL(candidateUrl))).toBeUndefined()
    expect(source.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it.each([
    '<main><h1>教育部直属高等学校</h1><dl class="moe-schools">ROW</dl></main>',
    '<main class="moe-detail-box"><h1>高校新闻</h1><dl class="moe-schools">ROW</dl></main>',
    '<main class="moe-detail-box"><h1>教育部直属高等学校</h1><ul class="moe-schools">ROW</ul></main>',
    `${directory()}${directory()}`,
  ])('fails closed when current official directory structure is absent or ambiguous', async markup => {
    const source = fixture({ [MOE_UNIVERSITY_DIRECTORY]: markup.replace('ROW', row) })
    await expect(source.resolve(new URL(candidateUrl))).rejects.toThrow('exactly one')
    expect(source.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('rejects distinct conflicting rows for one institution domain', async () => {
    const rows = `${row}<dd><a class="outMoeLink" href="https://other.example.edu.cn/">另一学院</a></dd>`
    const source = fixture({ [MOE_UNIVERSITY_DIRECTORY]: directory(rows) })
    expect(await source.resolve(new URL(candidateUrl))).toBeUndefined()
  })
  it('deduplicates an exact duplicate official row without manufacturing a second authority', async () => {
    const source = fixture({ [MOE_UNIVERSITY_DIRECTORY]: directory(row + row) })
    expect((await source.resolve(new URL(candidateUrl)))?.evidence?.institution).toBe('示例大学')
  })
  it.each(['https://careers.fake.edu.cn/jobs/42', 'https://careers.example.edu.cn.evil.test/jobs/42', 'https://careers.example.com/jobs/42', 'http://careers.example.edu.cn/jobs/42'])('does not trust an institution-shaped candidate by suffix or name: %s', async url => {
    const source = fixture()
    expect(await source.resolve(new URL(url))).toBeUndefined()
    expect(source.fetchImpl).toHaveBeenCalledTimes(url.includes('fake.edu.cn') ? 1 : 0)
  })
  it('requires path segment containment rather than a string-prefix match', async () => {
    const source = fixture({ [root]: directHome })
    expect(await source.resolve(new URL('https://careers.example.edu.cn/jobs-evil/42'))).toBeUndefined()
  })
})

describe('rebuilt institution link security and bounded navigation', () => {
  it.each([
    ['hidden', `<section hidden>${employmentPage}</section>`], ['template', `<template>${employmentPage}</template>`],
    ['advertisement', `<aside class="advertisement">${employmentPage}</aside>`],
    ['friends', `<section><h2>友情链接</h2>${employmentPage}</section>`],
    ['navigation ancestor', `<section id="partners"><nav><div>${employmentPage}</div></nav></section>`],
    ['foreign SVG anchor', '<svg><a href="https://careers.example.edu.cn/jobs/">就业信息</a></svg>'],
    ['foreign MathML anchor', '<math><a href="https://careers.example.edu.cn/jobs/">就业信息</a></math>'],
    ['head noscript link', `<html><head><noscript><a href="${careers}">就业信息</a></noscript></head><body>示例大学</body></html>`],
  ])('cannot establish employment authority using %s', async (_label, raw) => {
    const source = fixture({ [employment]: raw })
    expect(await source.resolve(new URL(candidateUrl))).toBeUndefined()
  })
  it('honors an external base URL rather than treating a relative URL as a trusted same-institution link', async () => {
    const source = fixture({ [employment]: '<head><base hidden href="https://careers.other.edu.cn/"></head><body><a href="jobs/">就业信息</a></body>' })
    expect(await source.resolve(new URL(candidateUrl))).toBeUndefined()
  })
  it('does not follow the official directory away from its exact reviewed URL', async () => {
    const source = fixture({ [MOE_UNIVERSITY_DIRECTORY]: () => new Response(null, { status: 302, headers: { location: 'https://www.moe.gov.cn/same-name-directory/' } }) })
    await expect(source.resolve(new URL(candidateUrl))).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_AUTHORITY_REQUIRED' })
    expect(source.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it.each(['https://www.other.edu.cn/', 'https://www.example.edu.cn.evil.test/', 'http://127.0.0.1/'])('rejects an institution redirect outside its exact public origin: %s', async location => {
    const source = fixture({ [root]: () => new Response(null, { status: 302, headers: { location } }) })
    await expect(source.resolve(new URL(candidateUrl))).rejects.toThrow()
    expect(source.fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('permits same-origin homepage redirect while recording its final source URL', async () => {
    const currentHome = `${root}index.html`
    const source = fixture({ [root]: () => new Response(null, { status: 302, headers: { location: '/index.html' } }), [currentHome]: directHome })
    const authority = await source.resolve(new URL(candidateUrl))
    expect(authority?.evidence?.rootUrl).toBe(currentHome)
    expect(authority?.evidence?.links[1]?.sourceUrl).toBe(currentHome)
  })
  it('does not authorize the whole institution through a navigation page linking back to its ancestor', async () => {
    const source = fixture({ [employment]: '<main><a href="/">就业信息</a></main>' })
    expect(await source.resolve(new URL('https://www.example.edu.cn/careers/job/42'))).toBeUndefined()
    expect(source.fetchImpl).toHaveBeenCalledTimes(3)
  })
  it('does not authorize the institution homepage using a self-referential recruiting link', async () => {
    const source = fixture({ [root]: '<main><a href="/">就业信息</a></main>' })
    expect(await source.resolve(new URL('https://www.example.edu.cn/job/42'))).toBeUndefined()
    expect(source.fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('stops at one institution navigation layer without recursively crawling', async () => {
    const source = fixture({ [employment]: '<main><a href="/employment-second-level/">就业入口</a></main>' })
    expect(await source.resolve(new URL(candidateUrl))).toBeUndefined()
    expect(source.fetchImpl).toHaveBeenCalledTimes(3)
  })
  it('rejects more than three recruiting navigation choices before crawling any of them', async () => {
    const source = fixture({ [root]: '<nav>' + [1, 2, 3, 4].map(n => `<a href="/jobs-${n}/">就业 ${n}</a>`).join('') + '</nav>' })
    expect(await source.resolve(new URL(candidateUrl))).toBeUndefined()
    expect(source.fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('rejects competing broad and narrow recruiting boundaries instead of choosing the broad one', async () => {
    const source = fixture({ [root]: `<main><a href="https://careers.example.edu.cn/">就业平台</a><a href="${careers}">招聘信息</a></main>` })
    expect(await source.resolve(new URL(candidateUrl))).toBeUndefined()
  })
  it('rejects conflicting boundaries found on two navigation pages', async () => {
    const source = fixture({ [root]: '<nav><a href="/admissions/">招生就业</a><a href="/jobs-office/">就业部门</a></nav>',
      [`${root}jobs-office/`]: '<main><a href="https://careers.example.edu.cn/">就业平台</a></main>' })
    expect(await source.resolve(new URL(candidateUrl))).toBeUndefined()
  })
  it('does not truncate over-limit documents or selectors into apparently valid authority', async () => {
    const source = fixture({ [employment]: `<main>${employmentPage}${'<section>'.repeat(30)}<a href="${careers}42">招聘详情</a>${'</section>'.repeat(30)}</main>` })
    await expect(source.resolve(new URL(candidateUrl))).rejects.toThrow('selector bound')
    const large = fixture({ [MOE_UNIVERSITY_DIRECTORY]: directory() + '<'.repeat(20_001) })
    await expect(large.resolve(new URL(candidateUrl))).rejects.toThrow('parser bound')
  })
})

describe('rebuilt authority expiry and cache refresh', () => {
  it('shares in-flight reads and returns independent evidence copies to callers', async () => {
    const source = fixture()
    const [left, right] = await Promise.all([source.resolve(new URL(candidateUrl)), source.resolve(new URL(candidateUrl))])
    expect(source.fetchImpl).toHaveBeenCalledTimes(3)
    expect(left).toEqual(right); expect(left).not.toBe(right)
    left!.evidence!.links[0]!.quote = 'Tampered caller copy'
    left!.evidence!.institution = 'Tampered institution'
    const freshCopy = await source.resolve(new URL(candidateUrl))
    expect(freshCopy?.evidence?.institution).toBe('示例大学')
    expect(freshCopy?.evidence?.links[0]?.quote).toBe('示例大学')
    expect(source.fetchImpl).toHaveBeenCalledTimes(3)
  })
  it('reuses fresh proof, then refetches current directory and pages exactly at expiry', async () => {
    let time = Date.parse(at)
    const source = fixture({}, () => new Date(time))
    expect(await source.resolve(new URL(candidateUrl))).toBeDefined()
    time += 3_599_999
    expect(await source.resolve(new URL(candidateUrl))).toBeDefined()
    expect(source.fetchImpl).toHaveBeenCalledTimes(3)
    time++
    const refreshed = await source.resolve(new URL(candidateUrl))
    expect(source.fetchImpl).toHaveBeenCalledTimes(6)
    expect(refreshed?.evidence).toMatchObject({ fetchedAt: '2026-10-08T01:00:00.000Z', expiresAt: '2026-10-08T02:00:00.000Z' })
  })
  it('withdraws cached authority when the refreshed official directory no longer contains the institution', async () => {
    let time = Date.parse(at)
    const source = fixture({}, () => new Date(time))
    expect(await source.resolve(new URL(candidateUrl))).toBeDefined()
    source.documents.set(MOE_UNIVERSITY_DIRECTORY, directory('<dd>Institution no longer listed</dd>'))
    time += 3_600_000
    expect(await source.resolve(new URL(candidateUrl))).toBeUndefined()
    expect(source.fetchImpl).toHaveBeenCalledTimes(4)
  })
  it('withdraws cached authority when the current employment link disappears', async () => {
    let time = Date.parse(at)
    const source = fixture({}, () => new Date(time))
    expect(await source.resolve(new URL(candidateUrl))).toBeDefined()
    source.documents.set(employment, '<main>就业链接已撤销</main>')
    time += 3_600_000
    expect(await source.resolve(new URL(candidateUrl))).toBeUndefined()
    expect(source.fetchImpl).toHaveBeenCalledTimes(6)
  })
  it('does not cache a failed directory fetch as a permanent rejected promise', async () => {
    const source = fixture({ [MOE_UNIVERSITY_DIRECTORY]: () => new Response('temporary outage', { status: 503 }) })
    await expect(source.resolve(new URL(candidateUrl))).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_UNAVAILABLE', retryable: true })
    source.documents.set(MOE_UNIVERSITY_DIRECTORY, directory())
    expect(await source.resolve(new URL(candidateUrl))).toBeDefined()
    expect(source.fetchImpl).toHaveBeenCalledTimes(4)
  })
  it('bases the proof expiry on the oldest document fetch, not the time later navigation finished', async () => {
    let time = Date.parse(at)
    const source = fixture({ [root]: () => { time += 20 * 60_000; return new Response(home) } }, () => new Date(time))
    const authority = await source.resolve(new URL(candidateUrl))
    expect(authority?.evidence).toMatchObject({ fetchedAt: at, expiresAt: '2026-10-08T01:00:00.000Z' })
  })
  it.each(['2026-10-08T01:00:00.000Z', '2026-10-08T02:00:00.000Z'])('rejects expired supplied publisher proof before fetching a job at %s', async date => {
    const source = fixture(), authority = await source.resolve(new URL(candidateUrl))
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const result = await verifyDiscoverySourceObservation({ sourceRecordId: 'candidate', company: 'Independent Company', role: 'AI Product Manager', sourceUrl: candidateUrl, sourceTitle: 'Claim', discoveredAt: at },
      { now: new Date(date), fetchImpl, resolveAuthority: async () => authority })
    expect(result.sourceVerification).toBe('unverified')
    expect(result.sourceVerificationReason).toContain('DISCOVERY_SOURCE_AUTHORITY_EXPIRED')
    expect(result.sourceProof).toBeUndefined(); expect(fetchImpl).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import { createNotificationIdentityMatcher } from '../src/notificationIdentityRegions.js'
import { matchNotificationOpportunity, notificationIdentityCompatible, parseRecruitingNotification } from '../src/notificationParser.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
// Exact preceding implementation, retained as a pure output-equivalence oracle.
function baseline(text: string, alias: string) {
  const regions = text.toLowerCase().split(/[^\p{L}\p{N}\s]+/u)
  return regions.some(region => {
    const tokens = region.match(/[\p{L}\p{N}]+/gu) ?? []
    const value = tokens.join(' ')
    if (/^[a-z0-9 ]+$/i.test(alias)) return (` ${value} `).includes(` ${alias} `)
    return value.includes(alias)
  })
}
describe('scoped notification identity regions are output-equivalent', () => {
  const texts = ['', '__proto__', 'constructor', 'Acme Labs', 'Acme|Labs', 'Acme Labs! Acme-Labs',
    '甲星 科技', '甲星，科技', '北城/大学', '星河 XYZ', 'XYZ 星河', "Lumeria 丙云中国", 'é É e\u0301',
    'ＡＣＭＥ１２３', '公司𠮷野', 'İ I ı i', 'Alpha\nBeta', 'Alpha\tBeta', '甲星💼产品经理', 'abc 123 abc123']
  const aliases = ['','__proto__','constructor','acme labs','acme','labs','甲星科技','甲星 科技','甲星',
    '北城大学','xyz','星河','丙云','é','e','e\u0301','ａｃｍｅ１２３','𠮷野','i','ı','alpha beta','abc','123','abc123','产品经理']
  it('matches the prior implementation across Unicode, punctuation, whitespace and map-like keys', () => {
    const matcher = createNotificationIdentityMatcher()
    for (const text of texts) for (const alias of aliases) {
      expect(matcher(text, alias), JSON.stringify({ text, alias })).toBe(baseline(text, alias))
    }
    // Reverse traversal reuses every cached text under different alias order.
    for (const text of [...texts].reverse()) for (const alias of [...aliases].reverse()) expect(matcher(text, alias)).toBe(baseline(text, alias))
  })
  it('does not collide punctuation-separated text with whitespace-separated text', () => {
    const matcher = createNotificationIdentityMatcher()
    expect(matcher('Acme Labs', 'acme labs')).toBe(true)
    expect(matcher('Acme|Labs', 'acme labs')).toBe(false)
    expect(matcher('甲星，科技', '甲星 科技')).toBe(false)
    expect(matcher('甲星 科技', '甲星 科技')).toBe(true)
  })
  it('creates independent scopes and never retains opportunity scores or mutable role aliases', () => {
    const jobs = [opportunity('synthetic-a','甲星科技','产品经理')]
    expect(matchNotificationOpportunity('甲星科技 产品经理', jobs).selected?.id).toBe('synthetic-a')
    jobs[0].role = '软件工程师'
    expect(matchNotificationOpportunity('甲星科技 产品经理', jobs).selected).toBeUndefined()
    expect(matchNotificationOpportunity('甲星科技 软件工程师', jobs).selected?.id).toBe('synthetic-a')
    const second = [opportunity('synthetic-b','乙月科技','产品经理')]
    expect(matchNotificationOpportunity('甲星科技 产品经理', second).selected).toBeUndefined()
    expect(createNotificationIdentityMatcher()('乙月科技', '甲星')).toBe(false)
  })
  it('preserves same-brand role ambiguity and explicit contradictory identities across mails', () => {
    const jobs = [opportunity('synthetic-a','甲星科技','产品经理'), opportunity('synthetic-b','甲星科技','软件工程师')]
    const now = new Date('2026-10-12T00:00:00Z')
    const ambiguous = parseRecruitingNotification('甲星科技 面试时间2026年10月15日18:50',jobs,now)
    expect(ambiguous.opportunity).toBeUndefined()
    expect(ambiguous.candidates.map(candidate => candidate.opportunity.id)).toEqual(['synthetic-a','synthetic-b'])
    expect(notificationIdentityCompatible('乙月科技 产品经理 面试邀请',jobs[0],jobs)).toBe(false)
    expect(parseRecruitingNotification('甲星科技 软件工程师 面试时间2026年10月15日18:50',jobs,now).opportunity?.id).toBe('synthetic-b')
    expect(parseRecruitingNotification('甲星科技 产品经理 面试时间2026年10月16日09:00',jobs,now).opportunity?.id).toBe('synthetic-a')
  })
})

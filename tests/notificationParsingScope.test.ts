import { createNotificationIdentityMemo, NOTIFICATION_MEMO_MAX_ENTRIES, NOTIFICATION_MEMO_MAX_KEY_CHARS, NOTIFICATION_MEMO_MAX_RETAINED_CHARS } from '../src/notificationIdentityMemo.js'
import { describe, expect, it, vi } from 'vitest'
import * as notification from '../src/notificationParser.js'
import { gmailSemanticRecordFromMessage, gmailObservationFromMessage, fetchGmailSemanticRecordsByIds } from '../gateway/gmailAutomation.js'
import type { Opportunity } from '../src/model.js'
const at = new Date('2026-10-25T00:00:00.000Z')
const opportunities = (): Opportunity[] => Array.from({ length: 16 }, (_, i) => ({ id: `synthetic:${i}`, company: `合成企业${i}科技有限公司`, role: `数据分析师${i}`, currentStageLabel: '筛选中', processStage: 'screening', roleType: 'core', early: false, opportunityValue: 80, fitScore: 80, locallyManaged: true, importedAt: at.toISOString() }))
function message(body: string, subject = body) { return { id: 'synthetic-message', threadId: 'synthetic-thread', internalDate: String(at.getTime()), payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: subject }], body: { data: Buffer.from(body).toString('base64url') } } } }
const cases = [
  '合成企业0科技有限公司 数据分析师0 投递成功',
  '合成企业0科技有限公司 数据分析师0 面试邀请；请于2026年10月26日14:30参加面试',
  '合成企业0科技有限公司 数据分析师0 招聘流程：网申、测评、面试',
  '合成企业0科技有限公司 数据分析师0 与合成企业1科技有限公司 数据分析师1 招聘进展',
  '这是一封普通消息。\n> 合成企业0科技有限公司 数据分析师0 已录用',
  'https://synthetic.invalid/合成企业0科技有限公司 普通消息，感谢阅读',
  '合成企业0科技有限公司 数据分析师0 面试改期通知：原定2026年10月26日14:00的面试改为2026年10月27日15:00',
]
describe('caller-owned notification parsing scope', () => {
  it('provides a fresh explicit scope instead of cross-batch object caches', () => {
    expect(typeof notification.createNotificationParsingScope).toBe('function')
    expect(notification.createNotificationParsingScope()).not.toBe(notification.createNotificationParsingScope())
  })
  it.each(cases)('preserves every uncached parser field: %s', text => {
    const jobs = opportunities(), scope = notification.createNotificationParsingScope()
    expect(notification.parseRecruitingNotification(text, jobs, at, scope)).toEqual(notification.parseRecruitingNotification(text, jobs, at))
    expect(notification.matchNotificationOpportunity(text, jobs, scope)).toEqual(notification.matchNotificationOpportunity(text, jobs))
    expect(notification.commonNotificationCompany(text, jobs, scope)).toEqual(notification.commonNotificationCompany(text, jobs))
    for (const target of jobs.slice(0, 2)) {
      expect(notification.notificationIdentityCompatible(text, target, jobs, scope)).toBe(notification.notificationIdentityCompatible(text, target, jobs))
      expect(notification.notificationIdentityCanInherit(text, target, scope)).toBe(notification.notificationIdentityCanInherit(text, target))
    }
    expect(gmailSemanticRecordFromMessage(message(text), jobs, at, 'UTC', scope)).toEqual(gmailSemanticRecordFromMessage(message(text), jobs, at, 'UTC'))
    expect(gmailObservationFromMessage(message(text), jobs, at, scope)).toEqual(gmailObservationFromMessage(message(text), jobs, at))
  })
  it('does not cache target objects, current identity/order, source time or timezone', () => {
    const jobs = opportunities(), scope = notification.createNotificationParsingScope(), text = cases[0]!, mail = message(text)
    notification.parseRecruitingNotification(text, jobs, at, scope)
    jobs[0].company = '变更合成企业'; jobs[0].role = '变更合成岗位'; jobs[1].order = -1
    const reordered = [...jobs].reverse()
    expect(notification.parseRecruitingNotification(text, reordered, at, scope)).toEqual(notification.parseRecruitingNotification(text, reordered, at))
    const later = new Date('2026-10-26T00:00:00Z')
    expect(notification.parseRecruitingNotification('明天14:00面试', jobs, later, scope)).toEqual(notification.parseRecruitingNotification('明天14:00面试', jobs, later))
    expect(gmailSemanticRecordFromMessage(mail, jobs, later, 'Asia/Shanghai', scope)).toEqual(gmailSemanticRecordFromMessage(mail, jobs, later, 'Asia/Shanghai'))
  })
  it('does not leak mutable parser results between calls', () => {
    const jobs = opportunities(), scope = notification.createNotificationParsingScope(), text = cases[0]!
    const result = notification.parseRecruitingNotification(text, jobs, at, scope)
    result.warnings.push('output-only'); result.candidates[0]?.reasons.push('output-only')
    expect(notification.parseRecruitingNotification(text, jobs, at, scope)).toEqual(notification.parseRecruitingNotification(text, jobs, at))
  })
})

describe('bounded pure identity memo', () => {
  it('keys by original string, never normalized identity, and preserves empty values', () => {
    const compute = vi.fn((key: string) => key), cached = createNotificationIdentityMemo()(compute)
    for (const key of ['A-B', 'A B', 'a-b', '', 'İ', 'i']) { expect(cached(key)).toBe(key); expect(cached(key)).toBe(key) }
    expect(compute).toHaveBeenCalledTimes(6)
  })
  it('caps each map and bypasses excess entries without altering output', () => {
    const compute = vi.fn((key: string) => key + '!'), cached = createNotificationIdentityMemo()(compute)
    for (let i = 0; i < NOTIFICATION_MEMO_MAX_ENTRIES; i++) expect(cached(String(i))).toBe(String(i) + '!')
    const before = compute.mock.calls.length
    cached('0'); expect(compute).toHaveBeenCalledTimes(before)
    expect(cached('overflow')).toBe('overflow!'); expect(cached('overflow')).toBe('overflow!')
    expect(compute).toHaveBeenCalledTimes(before + 2)
  })
  it('bypasses long keys, counts alias values against a shared character budget, and never truncates', () => {
    const memo = createNotificationIdentityMemo(), compute = vi.fn((key: string) => key), cached = memo(compute)
    const long = '汉'.repeat(NOTIFICATION_MEMO_MAX_KEY_CHARS + 1)
    expect(cached(long)).toBe(long); expect(cached(long)).toBe(long); expect(compute).toHaveBeenCalledTimes(2)
    const half = 'x'.repeat(NOTIFICATION_MEMO_MAX_RETAINED_CHARS / 2 - 1)
    const first = vi.fn(() => [half] as readonly string[]), second = vi.fn(() => half)
    const a = memo(first), b = memo(second)
    expect(a('a')).toEqual([half]); a('a'); expect(first).toHaveBeenCalledTimes(1)
    expect(b('bb')).toBe(half); expect(b('bb')).toBe(half); expect(second).toHaveBeenCalledTimes(2)
    // The second map cannot spend another independent character budget.
    expect(a('a')).toEqual([half]); expect(first).toHaveBeenCalledTimes(1)
  })
  it('cached alias arrays cannot be modified through a later parser call', () => {
    const scope = notification.createNotificationParsingScope(), aliases = scope.companyAliases('合成银行南区分行')
    expect(Object.isFrozen(aliases)).toBe(true)
    expect(() => (aliases as string[]).push('forged')).toThrow()
    expect(scope.companyAliases('合成银行南区分行')).toBe(aliases)
    expect(notification.createNotificationParsingScope().companyAliases('合成银行南区分行')).not.toBe(aliases)
  })
  it('retains bilingual, bank-branch, punctuation, tied scores and role alias semantics', () => {
    const jobs = opportunities().slice(0, 4)
    jobs[0].company = '合成银行南区分行'; jobs[1].company = '合成银行北区分行'
    jobs[2].company = 'Synthetic 合成中国'; jobs[3].company = 'Synthetic 合成中国'
    jobs[2].role = '数据分析师／AI Engineer'; jobs[3].role = jobs[2].role
    const scope = notification.createNotificationParsingScope()
    for (const text of ['合成银行 数据分析师0 招聘进展', '合成银行南区分行 数据分析师0 面试通知', 'Synthetic AI Engineer 申请成功', '合成中国 数据分析师 投递成功', 'Synthetic，合成中国 AI Engineer']) {
      expect(notification.parseRecruitingNotification(text, jobs, at, scope)).toEqual(notification.parseRecruitingNotification(text, jobs, at))
    }
    jobs[2].order = 10; jobs[3].order = -10
    expect(notification.parseRecruitingNotification('Synthetic AI Engineer 投递成功', jobs, at, scope)).toEqual(notification.parseRecruitingNotification('Synthetic AI Engineer 投递成功', jobs, at))
  })
  it('reuses one scope through bounded by-ID parsing and the legacy classifier, then discards it', async () => {
    const created: notification.NotificationParsingScope[] = [], original = notification.createNotificationParsingScope
    const spy = vi.spyOn(notification, 'createNotificationParsingScope').mockImplementation(() => { const scope = original(); created.push(scope); return scope })
    const fetchImpl: typeof fetch = async url => Response.json({ ...message(cases[0]!), id: new URL(String(url)).pathname.split('/').at(-1) })
    try {
      await fetchGmailSemanticRecordsByIds({ accessToken: 'synthetic', messageIds: ['one', 'two'], opportunities: opportunities(), now: at, timezone: 'UTC', fetchImpl })
      expect(created).toHaveLength(1)
      await fetchGmailSemanticRecordsByIds({ accessToken: 'synthetic', messageIds: ['three'], opportunities: opportunities(), now: at, timezone: 'UTC', fetchImpl })
      expect(created).toHaveLength(2); expect(created[0]).not.toBe(created[1])
    } finally { spy.mockRestore() }
  })
})

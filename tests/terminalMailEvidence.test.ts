import { describe, expect, it } from 'vitest'
import { detectNotificationType, matchNotificationOpportunity } from '../src/notificationParser.js'
import { gmailSemanticRecordFromMessage, GMAIL_FRAGMENT_PARSE_LIMIT } from '../gateway/gmailAutomation.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import { createSnapshot } from '../src/snapshot.js'
import type { Opportunity } from '../src/model.js'

const now = new Date('2026-10-02T00:00:00Z')
const job: Opportunity = { id: 'synthetic-north-east', company: '北东', role: '产品经理/校招岗位', currentStageLabel: '筛选中', processStage: 'screening', roleType: 'core', early: false, opportunityValue: 80, fitScore: 70, importedAt: now.toISOString() }
function record(text: string, subject = '北东 产品经理 招聘进展') {
  return gmailSemanticRecordFromMessage({ id: 'synthetic-terminal-mail', internalDate: String(now.getTime()), payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: subject }], body: { data: Buffer.from(text).toString('base64url') } } }, [job], now)!
}
function apply(item: ReturnType<typeof record>) {
  return applyGmailSemanticBatch(createSnapshot({ opportunities: [job], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [] }), { runId: 'synthetic-terminal-batch', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [item] })
}
describe('terminal mail evidence safety', () => {
  it.each([
    '校园招聘流程：网申、笔试、面试、offer发放',
    '通过面试后将收到录用通知',
    '优秀候选人可获得offer',
    '拟录用名单及后续安排请关注官网',
    '本次招聘预计十一月发放offer',
    'How to get an offer: campus recruitment guide',
    'We offer competitive benefits and training',
    '尚未收到录用通知，请等待结果',
  ])('does not turn a recruitment description into an offer: %s', text => {
    expect(detectNotificationType(text).type).not.toBe('offer')
    expect(record(text).observation.candidates.some(c => c.kind === 'process_event' && c.eventType === 'offer')).toBe(false)
  })
  it.each(['招聘流程如下。网申。笔试。面试。offer发放。', '面试技巧与笔试题库推荐', '未通过面试的同学可以申请其他岗位', '不是录用通知书', '以下是朋友收到的通知：恭喜您已被北东录用', 'If you pass the interview, your offer letter is attached in the next message', 'Example offer letter'])('does not promote procedure, example, third-party or negative context: %s', text => {
    const candidate = detectNotificationType(text)
    expect(candidate.confidence).not.toBe('high')
    expect(apply(record(text)).snapshot.data.processEvents).toHaveLength(0)
  })
  it('retains multiword company and role identity and refuses year/cohort-only role evidence', () => {
    const english = { ...job, company: 'North East', role: 'Product Manager' }
    expect(matchNotificationOpportunity('North East Product Manager interview invitation', [english]).confidence).toBe('high')
    const generic = { ...job, role: 'TET管培生—产品方向｜2027校园招聘' }
    expect(matchNotificationOpportunity('北东2027校园招聘现已启动', [generic]).confidence).not.toBe('high')
    expect(detectNotificationType('亲爱的候选人，恭喜您已被北东录用。 如需帮助请联系我们').type).toBe('offer')
  })
  it.each(['恭喜收到录用通知', '恭喜您已被北东录用，请查收offer', 'We are pleased to offer you the Product Manager position', 'Your offer letter is attached'])('retains direct positive offer evidence: %s', text => {
    expect(detectNotificationType(text)).toEqual({ type: 'offer', confidence: 'high' })
  })
  it('does not synthesize a company across punctuation or promote a generic role', () => {
    const result = matchNotificationOpportunity('宣讲地点为江北：东湖大学；校招岗位覆盖多地', [job])
    expect(result.selected).toBeUndefined()
    expect(result.candidates.some(item => item.score >= 70)).toBe(false)
    const generic = matchNotificationOpportunity('北东校招岗位欢迎申请', [{ ...job, role: '校招岗位' }])
    expect(generic.confidence).not.toBe('high')
  })
  it.each(['恭喜您收到录用通知', '很遗憾本次流程未通过'])('cannot commit a terminal prefix when later fragments are unparsed: %s', terminal => {
    const item = record(['北东 产品经理 ' + terminal, ...Array.from({ length: GMAIL_FRAGMENT_PARSE_LIMIT }, (_, i) => `说明${i}`)].join('；'))
    expect(item.issueKinds).toContain('interpretation_failure')
    const result = apply(item)
    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.snapshot.data.opportunities[0].processStage).toBe('screening')
    expect(result.run.outcomes).toEqual({ unresolved: 1 })
  })
  it('enforces incomplete-source terminal protection at the shared batch boundary too', () => {
    const item = record('北东 产品经理 恭喜您收到录用通知')
    expect(item.observation.candidates).toHaveLength(1)
    item.gaps = ['Later message fragments were not interpreted.']
    item.issueKinds = ['interpretation_failure']
    expect(apply(item).snapshot.data.processEvents).toHaveLength(0)
  })
})

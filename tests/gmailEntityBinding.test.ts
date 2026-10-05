import { describe, expect, it } from 'vitest'
import { gmailSemanticRecordFromMessage } from '../gateway/gmailAutomation.js'
import { matchNotificationOpportunity } from '../src/notificationParser.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import { createSnapshot } from '../src/snapshot.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'

const now = new Date('2026-10-01T00:00:00Z')
const alpha = opportunity('synthetic-alpha', '甲星公司', '产品经理')
const beta = opportunity('synthetic-beta', '乙月公司', '客户经理')
const jobs = [alpha, beta]
function parse(body: string, subject = '招聘通知', targets = jobs) {
  return gmailSemanticRecordFromMessage({ id: 'synthetic-identity-mail', threadId: 'synthetic-identity-thread',
    internalDate: String(now.getTime()), payload: { mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: subject }], body: { data: Buffer.from(body).toString('base64url') } } }, targets, now)!
}
function apply(body: string, subject = '招聘通知', targets = jobs) {
  return applyGmailSemanticBatch(createSnapshot({ opportunities: targets, processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [] }), {
    runId: 'synthetic-identity-run', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [parse(body, subject, targets)],
  })
}

describe('bounded notification identity evidence', () => {
  it.each([
    'https://甲星公司.example/产品经理?utm_campaign=乙月公司',
    'https://tracker.example/?company=甲星公司&role=产品经理',
    '甲星公司.example/产品经理',
    'careers@甲星公司.example',
    'utm_company=甲星公司&role=产品经理',
    '技术支持：甲星公司 产品经理',
    'Powered by 甲星公司 产品经理',
  ])('never uses transport or footer tokens as identity: %s', noise => {
    expect(matchNotificationOpportunity(`很遗憾本次流程未通过\n${noise}`, jobs).selected).toBeUndefined()
    const result = apply(`很遗憾本次流程未通过\n${noise}`)
    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.snapshot.data.decisionRequests ?? []).toHaveLength(0)
    expect(result.snapshot.data.opportunities.map(job => job.processStage)).toEqual(jobs.map(job => job.processStage))
  })
  it('does not borrow an event identity from another fragment', () => {
    const record = parse('甲星公司 产品经理 请于2026年10月3日14:00参加面试；很遗憾本次流程未通过')
    expect(record.observation.candidates[0].target?.opportunityId).toBe(alpha.id)
    expect(record.observation.candidates[1].target?.opportunityId).toBeUndefined()
    expect(apply('甲星公司 产品经理 请于2026年10月3日14:00参加面试；很遗憾本次流程未通过').snapshot.data.processEvents.map(event => event.type)).toEqual(['interview_invite'])
  })
  it.each([
    '乙月公司 客户经理 很遗憾本次流程未通过',
    '甲星公司 客户经理 很遗憾本次流程未通过',
    '岗位：研究员，很遗憾本次流程未通过',
    '丙云公司 产品经理 很遗憾本次流程未通过',
    '甲星公司 数据分析师 很遗憾本次流程未通过',
  ])('never borrows a conflicting subject target: %s', body => {
    const record = parse(body, '甲星公司 产品经理 招聘进展', [alpha])
    expect(record.observation.candidates[0]?.target?.opportunityId).toBeUndefined()
    expect(apply(body, '甲星公司 产品经理 招聘进展', [alpha]).snapshot.data.processEvents).toHaveLength(0)
  })
  it('keeps two explicitly independent event identities', () => {
    const record = parse('甲星公司 产品经理 很遗憾本次流程未通过；乙月公司 客户经理 恭喜收到录用通知')
    expect(record.observation.candidates.map(candidate => candidate.target?.opportunityId)).toEqual([alpha.id, beta.id])
  })
  it.each([
    ['甲星公司 产品经理 很遗憾本次流程未通过', '招聘通知'],
    ['很遗憾本次流程未通过', '甲星公司 产品经理 招聘进展'],
    ['甲星公司 产品经理；很遗憾本次流程未通过', '招聘通知'],
  ])('preserves direct or bounded single-target outcomes', (body, subject) => {
    expect(parse(body, subject).observation.candidates[0]?.target?.opportunityId).toBe(alpha.id)
    expect(apply(body, subject).snapshot.data.processEvents.map(event => event.type)).toEqual(['rejection'])
  })
  it('preserves company-name punctuation without mistaking it for a company field', () => {
    expect(matchNotificationOpportunity('甲星公司：请于2026年10月3日14:00参加面试', [alpha]).selected?.id).toBe(alpha.id)
  })
  it('does not resolve one ambiguous role using a later independent role fragment', () => {
    const second = opportunity('synthetic-alpha-second', alpha.company, '客户经理')
    const record = parse('甲星公司 很遗憾本次流程未通过；甲星公司 产品经理 请于2026年10月3日14:00参加面试', '招聘通知', [alpha, second])
    expect(record.observation.candidates[0]?.target).toMatchObject({ company: alpha.company })
    expect(record.observation.candidates[0]?.target?.opportunityId).toBeUndefined()
  })
  it.each([
    'Globex Software Engineer 很遗憾本次流程未通过',
    'Software Engineer at Globex 很遗憾本次流程未通过',
    'Software Engineer Globex 很遗憾本次流程未通过',
    'Acme Quant 很遗憾本次流程未通过',
    '星海 Software Engineer 很遗憾本次流程未通过',
    'Your application to Globex for Software Engineer 很遗憾本次流程未通过',
    'Globex Quant 很遗憾本次流程未通过',
    'Acme 很遗憾您的 Globex Software Engineer 申请未通过',
  ])('fails closed for unknown plain brands or titles without suffix assumptions: %s', body => {
    const target = opportunity('synthetic-acme', 'Acme', 'Software Engineer')
    const record = parse(body, 'Acme Software Engineer recruiting update', [target])
    expect(record.observation.candidates[0]?.target?.opportunityId).toBeUndefined()
    const result = apply(body, 'Acme Software Engineer recruiting update', [target])
    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.snapshot.data.actions).toHaveLength(0)
    expect(result.snapshot.data.decisionRequests ?? []).toHaveLength(0)
    expect(result.snapshot.data.opportunities[0].processStage).toBe(target.processStage)
  })
  it.each(['很遗憾本次流程未通过', '您的申请很遗憾本次流程未通过', '恭喜收到录用通知'])('retains pronoun-only bounded subject inheritance: %s', body => {
    const target = opportunity('synthetic-acme', 'Acme', 'Software Engineer')
    expect(parse(body, 'Acme Software Engineer recruiting update', [target]).observation.candidates[0]?.target?.opportunityId).toBe(target.id)
    expect(apply(body, 'Acme Software Engineer recruiting update', [target]).snapshot.data.processEvents).toHaveLength(1)
  })
  it('does not bind unknown bare company identity through the subject-only event path', () => {
    const target = opportunity('synthetic-acme', 'Acme', 'Software Engineer')
    const record = parse('Globex Software Engineer，请于2026年10月3日14:00到会议室参加。', 'Acme Software Engineer Interview invitation', [target])
    expect(record.observation.candidates[0]?.target?.opportunityId).toBeUndefined()
  })

  it('binds an identity-neutral submission deadline only to its immediately preceding test window', () => {
    const text = '甲星公司 产品经理 笔试开放窗口明天09:00至后天17:00；提交截止后天18:00'
    const record = parse(text)
    expect(record.observation.candidates).toHaveLength(2)
    expect(record.observation.candidates.map(candidate => candidate.target?.opportunityId)).toEqual([alpha.id, alpha.id])
    const result = apply(text)
    expect(result.snapshot.data.processEvents).toHaveLength(2)
    expect(result.snapshot.data.processEvents.map(event => event.opportunityId)).toEqual([alpha.id, alpha.id])
    expect(result.snapshot.data.scheduleNodes?.map(node => node.temporal.shape)).toEqual(['availability_window', 'deadline'])
  })
  it.each([
    '甲星公司 产品经理 笔试开放窗口明天09:00至后天17:00；乙月公司 客户经理提交截止后天18:00',
    '甲星公司 产品经理 笔试开放窗口明天09:00至后天17:00；未知主体；提交截止后天18:00',
    '甲星公司 产品经理 笔试开放窗口明天09:00至后天17:00；提交截止后天18:00；提交截止后天19:00',
    '甲星公司 产品经理 笔试开放窗口已取消明天09:00至后天17:00；提交截止后天18:00',
    '甲星公司 产品经理 面试邀请明天09:00至后天17:00；提交截止后天18:00',
  ])('does not carry window identity across conflicting, intervening, inherited or non-window facts: %s', text => {
    const record = parse(text)
    expect(record.observation.candidates.at(-1)?.target?.opportunityId).not.toBe(alpha.id)
  })

})

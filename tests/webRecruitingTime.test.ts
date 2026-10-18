import { describe, expect, it } from 'vitest'
import { completedWebRecruitingKind, resolveWebRecruitingTime } from '../src/webRecruitingTime.js'

const identity = { company: '示例科技', role: 'AI产品经理' }
const context = { ...identity, eventType: 'interview_invite' as const, timezone: 'Asia/Shanghai', receivedAt: '2026-09-21T00:00:00Z', mode: 'fixed' as const }
const prefix = `${identity.company} ${identity.role} `

describe('finite Web recruiting evidence grammar', () => {
  it.each(['面试通知：2026年9月25日14:30', '面试邀请：请于2026年9月25日下午2:30参加视频面试', '明天14:30面试'])('accepts fully represented source time: %s', body => {
    const value = resolveWebRecruitingTime(prefix + body, context)
    expect(value).toMatchObject({ precision: 'datetime', timezone: 'Asia/Shanghai', shape: 'fixed_range' })
  })
  it.each(['ET', '(HKT)', '(AEST)', '+0900', '+09', '北京时间', '首尔时间', 'Pacific time', '仅示例', '非本人面试', '第2轮', '未经确认'])('does not discard residual source qualifier %s', suffix => {
    expect(resolveWebRecruitingTime(prefix + '面试通知：2026年9月25日14:30 ' + suffix, context)).toBeUndefined()
  })
  it.each(['东京当地面试时间', '结束时间', '最晚开始时间'])('does not reinterpret unsupported time field %s as a start', field => {
    expect(resolveWebRecruitingTime(prefix + `面试通知：${field}2026年9月25日14:30`, context)).toBeUndefined()
  })
  it.each(['面试完成了', '面试已经完成', '面试此前已完成', '已于2026年9月24日14:30前完成面试', '笔试已经完成', '测评做完了'])('recognizes a bounded genuine past fact: %s', body => {
    expect(completedWebRecruitingKind(prefix + body, [identity])).toBe(body.includes('笔试') ? 'written_test' : body.includes('测评') ? 'assessment' : 'interview')
  })
  it.each(['请于2026年9月25日14:30前完成 面试', '须在2026年9月25日14:30前完成本轮面试', '面试将于明天完成', '面试尚未完成', '面试没有完成', '面试已完成仅示例', '如果面试完成了', '面试完成', '面试已完成但未经确认', '面试已经', '面试刚刚', '面试前完成了', '面试之前已完成'])('requires past fact evidence without leftover conditions: %s', body => {
    expect(completedWebRecruitingKind(prefix + body, [identity])).toBeUndefined()
  })
  it('never removes a company-name match from a factual qualifier', () => {
    expect(completedWebRecruitingKind('面试未完成了', [{ company: '未', role: '材料' }])).toBeUndefined()
    expect(resolveWebRecruitingTime('面试通知：2026年9月25日14:30 未确认 材料', { ...context, company: '未确认', role: '材料' })).toBeUndefined()
  })
})

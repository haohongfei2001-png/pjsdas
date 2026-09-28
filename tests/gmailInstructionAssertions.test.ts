import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import { createSnapshot } from '../src/snapshot.js'
import { describe, expect, it } from 'vitest'
import { gmailSemanticRecordFromMessage } from '../gateway/gmailAutomation.js'
const now = new Date('2026-09-28T18:00:00Z')
function parse(text: string, subject = '招聘流程说明') {
  return gmailSemanticRecordFromMessage({ id: 'synthetic-instructions', threadId: 'thread', internalDate: String(now.getTime()),
    payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: subject }], body: { data: Buffer.from(text).toString('base64url') } } }, [], now)!
}
const instructions = ['面试前请检查摄像头和麦克风', '面试时请保持网络畅通', '面试过程中请勿切换页面', '如遇面试设备问题请联系技术客服']
describe('Gmail instruction mentions are not independent event assertions', () => {
  it('does not promote four equipment/conduct/support clauses into four invitations', () => {
    expect(parse(instructions.join('；')).observation.candidates).toHaveLength(0)
  })
  it('retains an undated genuine invitation and its original fragment identity', () => {
    const record = parse([instructions[0], '诚邀您参加AI面试', ...instructions.slice(1)].join('；'))
    expect(record.observation.candidates).toHaveLength(1)
    expect(record.observation.candidates[0]).toMatchObject({ id: 'fragment:1', kind: 'process_event', eventType: 'interview_invite', temporalConfidence: 'low' })
  })
  it('uses a real subject invitation when the body is instructions, without inventing instruction dates', () => {
    const record = parse('请于2026年9月29日完成面试设备检查；面试时请保持网络畅通', 'Interview invitation')
    expect(record.observation.candidates).toHaveLength(1)
    expect(record.observation.candidates[0]).toMatchObject({ kind: 'process_event', eventType: 'interview_invite', temporalConfidence: 'low' })
    expect(record.observation.candidates[0]).not.toHaveProperty('dueAt', '2026-09-29')
  })
  it('preserves dated invitations, multiple independent events and mixed factual clauses', () => {
    const record = parse('笔试通知：请于2026年9月30日09:00参加统一笔试；面试前请检查摄像头；面试通知：请于2026年10月2日14:30参加面试，请保持网络畅通')
    expect(record.observation.candidates).toHaveLength(2)
    expect(record.observation.candidates.map(c => c.id)).toEqual(['fragment:0', 'fragment:2'])
    expect(record.observation.candidates.map(c => c.kind === 'process_event' && c.eventType)).toEqual(['written_test_invite', 'interview_invite'])
  })
  it('does not discard cancellation, completion or reschedule facts because equipment is mentioned', () => {
    expect(parse('因设备故障，面试已取消').observation.candidates[0]?.kind).toBe('occurrence_cancelled')
    expect(parse('面试已完成，设备可以关闭').observation.candidates[0]?.kind).toBe('occurrence_completed')
    expect(parse('因网络问题，面试改为2026年10月2日14:30').observation.candidates[0]?.kind).toBe('occurrence_rescheduled')
  })
  it('keeps explicit event timing even when procedural advice shares the fragment', () => {
    expect(parse('面试时间为2026年9月30日14:30，请检查网络').observation.candidates[0]).toMatchObject({ kind: 'process_event', dueAt: '2026-09-30T14:30:00+08:00' })
  })
  it('does not amplify procedural mail into persisted decisions through the real shared batch', () => {
    const base = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [] })
    const before = JSON.stringify(base)
    const result = applyGmailSemanticBatch(base, { runId: 'instructions-batch', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [parse(instructions.join('；'))] })
    expect(result.snapshot.data.decisionRequests ?? []).toHaveLength(0)
    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.snapshot.data.actions).toHaveLength(0)
    expect(JSON.stringify(base)).toBe(before)
  })
  it('preserves unknown untimed assertions as clarification candidates rather than deleting ambiguity', () => {
    expect(parse('面试安排后续通知').observation.candidates).toHaveLength(1)
  })
})

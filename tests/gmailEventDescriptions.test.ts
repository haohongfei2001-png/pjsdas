import { describe, expect, it } from 'vitest'
import { gmailSemanticRecordFromMessage } from '../gateway/gmailAutomation.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import { createSnapshot, validateSnapshot } from '../src/snapshot.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
import { resolveSourceTemporal } from '../src/sourceTemporal.js'

// Synthetic examples only: no production subjects, addresses, links or tokens.
const receivedAt = '2026-10-12T04:00:00Z'
const now = new Date(receivedAt)
const engineering = opportunity('synthetic-engineering', '甲星科技', '数字管理研发工程师（深圳）')
const jobs = [engineering]
function parse(body: string, targets = jobs, subject = '招聘进展', id = 'synthetic-message', observedAt = now) {
  return gmailSemanticRecordFromMessage({ id, threadId: 'synthetic-thread', internalDate: String(now.getTime()),
    payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: subject }],
      body: { data: Buffer.from(body).toString('base64url') } } }, targets, observedAt)!
}
function apply(record: ReturnType<typeof parse>, targets = jobs) {
  return applyGmailSemanticBatch(createSnapshot({ opportunities: targets, processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [] }), {
    runId: 'synthetic-run', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [record],
  })
}
const structuredInterview = [
  '感谢应聘甲星科技2027校园招聘，诚邀参加面试', '面试详情如下：',
  '面试职位：数字管理研发工程师（深圳）', '面试时间：2026年10月15日 星期四 18:50',
  '面试形式：视频面试', '面试地址：https://meeting.example.invalid/synthetic-room',
].join('\n')

describe('Gmail single-event descriptions remain one evidenced assertion', () => {
  it('combines only adjacent labelled invitation fields, including an exact punctuated role', () => {
    const record = parse(structuredInterview + '\n面试前请检查摄像头和麦克风\n面试期间请保持网络稳定', jobs, '甲星科技2027校园招聘面试邀请')
    expect(record.gaps).toEqual([])
    expect(record.observation.candidates).toHaveLength(1)
    expect(record.observation.candidates[0]).toMatchObject({ kind: 'process_event', target: { opportunityId: engineering.id },
      objectConfidence: 'high', temporalConfidence: 'high', dueAt: '2026-10-15T18:50:00+08:00',
      joinUrl: 'https://meeting.example.invalid/synthetic-room' })
    const result = apply(record)
    expect(result.snapshot.data.processEvents).toHaveLength(1)
    expect(result.snapshot.data.scheduleNodes).toHaveLength(1)
    expect(result.snapshot.data.decisionRequests ?? []).toHaveLength(0)
    expect(result.run.outcomes).toEqual({ updated: 1 })
    validateSnapshot(result.snapshot)
  })
  it('uses the subject company with a bounded labelled role alias and city qualifier', () => {
    const target = opportunity('synthetic-engineering-alias', '星河 XYZ', '数字管理研发工程师 / 数字管理构建者计划')
    const body = structuredInterview.replace('感谢应聘甲星科技2027校园招聘，诚邀参加面试', 'Dear 候选人，\n您好！感谢应聘 XYZ 星河 2027 校园招聘。为了让双方有进一步了解，现诚邀您参加面试') + '\n联系人：招聘团队'
    const record = parse(body, [target], 'XYZ 星河面试邀请')
    expect(record.observation.candidates).toHaveLength(1)
    expect(record.observation.candidates[0]).toMatchObject({ target: { opportunityId: target.id }, objectConfidence: 'high', temporalConfidence: 'high' })
    expect(apply(record, [target]).snapshot.data.processEvents).toHaveLength(1)
  })
  it('keeps duplicate reminder wording and undated introduction from becoming extra invitations', () => {
    const target = opportunity('synthetic-product', '乙月公司', '产品经理')
    const text = '乙月公司 产品经理 邀请参加面试；乙月公司 产品经理 面试时间2026年10月15日18:50；乙月公司 产品经理 请于2026年10月15日18:50参加面试；地点：会议室A；https://meeting.example.invalid/room'
    const record = parse(text, [target])
    expect(record.observation.candidates).toHaveLength(1)
    expect(record.observation.candidates[0]?.evidenceRefs).toHaveLength(3)
    expect(record.gaps).toEqual([])
    const first = apply(record, [target])
    const replay = applyGmailSemanticBatch(first.snapshot, { runId: 'synthetic-replay', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true,
      records: [parse(text, [target], '招聘进展', 'synthetic-reminder')] })
    expect(replay.snapshot.data.processEvents).toHaveLength(1)
    expect(replay.snapshot.data.scheduleNodes).toHaveLength(1)
  })
  it('deduplicates a bank deadline without selecting among three branch roles', () => {
    const targets = ['乙月银行总行', '乙月银行深圳分行', '乙月银行股份有限公司天津分行'].map((company, index) => opportunity(`synthetic-bank-${index}`, company, ['客户经理', '产品经理', '数据分析师'][index]!))
    const record = parse('乙月银行 请于2026年10月13日09:00前完成面试；乙月银行 面试截止时间2026年10月13日09:00；面试前请检查摄像头和麦克风；https://assessment.example.invalid/bank', targets)
    expect(record.observation.candidates).toHaveLength(1)
    expect(record.observation.candidates[0]).toMatchObject({ timingMode: 'deadline', temporal: { shape: 'deadline', deadlineAt: '2026-10-13T09:00:00+08:00' } })
    expect(record.observation.candidates[0]?.target).toMatchObject({ company: '乙月银行' })
    expect(record.observation.candidates[0]?.target?.opportunityId).toBeUndefined()
    const result = apply(record, targets)
    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.snapshot.data.decisionRequests?.length).toBeGreaterThan(0)
    expect(result.run.outcomes).toEqual({ unresolved: 1 })
  })
  it('resolves an explicit email-receipt assessment deadline while retaining real role ambiguity', () => {
    const targets = ['市场管理培训生', '研发管理培训生'].map((role, index) => opportunity(`synthetic-trainee-${index}`, 'Lumeria 丙云中国', role))
    const text = '丙云 欢迎参加线上测评，请在收到邮件后的72小时内完成；预计15分钟；答题截止时间：收到链接后的72小时内需完成测评；https://assessment.example.invalid/trainee'
    const record = parse(text, targets)
    const candidate = record.observation.candidates.find(item => item.kind === 'process_event' && item.temporal)
    expect(candidate).toMatchObject({ kind: 'process_event', dueAt: '2026-10-15T04:00:00.000Z', temporal: { shape: 'deadline' }, target: { company: '丙云' } })
    expect(candidate?.target?.opportunityId).toBeUndefined()
    expect(parse(text, targets, '招聘进展', 'synthetic-message', new Date('2026-11-01T00:00:00Z')).observation.candidates).toEqual(record.observation.candidates)
    const result = apply(record, targets)
    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.snapshot.data.decisionRequests?.length).toBeGreaterThan(0)
  })
  it('keeps a fixed bank test window distinct from an attendance confirmation deadline', () => {
    const record = parse('丁川银行 统一笔试时间：北京时间2026年10月15日19:00-20:30；请于北京时间2026年10月13日17:00前点击回执确认是否参加笔试；如通过将收到面试通知；https://assessment.example.invalid/test', [])
    const events = record.observation.candidates.filter(item => item.kind === 'process_event')
    expect(events).toHaveLength(1)
    expect(events[0]?.temporal).toMatchObject({ shape: 'availability_window', startAt: '2026-10-15T19:00:00+08:00', endAt: '2026-10-15T20:30:00+08:00' })
    expect(record.gaps.join(' ')).toContain('Attendance confirmation')
    const result = apply(record, [])
    expect(result.snapshot.data.opportunities).toHaveLength(0)
    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.snapshot.data.actions).toHaveLength(0)
  })
  it.each([
    '乙月公司 产品经理 面试时间2026年10月15日18:50；乙月公司 产品经理 面试时间2026年10月16日18:50',
    '乙月公司 产品经理 一面时间2026年10月15日18:50；乙月公司 产品经理 二面时间2026年10月15日18:50',
    '乙月公司 产品经理 面试时间2026年10月15日18:50，地点：会议室A；乙月公司 产品经理 面试时间2026年10月15日18:50，地点：会议室B',
  ])('retains genuinely competing dates, rounds or locations: %s', text => {
    const target = opportunity('synthetic-product', '乙月公司', '产品经理')
    expect(parse(text, [target]).observation.candidates).toHaveLength(2)
  })
  it('retains a clear event despite unrelated supplementary ambiguity without assigning the link', () => {
    const target = opportunity('synthetic-product', '乙月公司', '产品经理')
    const record = parse('乙月公司 产品经理 面试时间2026年10月15日18:50；乙月公司 产品经理 笔试时间2026年10月16日10:00；https://meeting.example.invalid/unknown', [target])
    expect(record.gaps.join(' ')).toContain('Supplementary')
    expect(record.observation.candidates.every(item => item.kind !== 'process_event' || !item.joinUrl)).toBe(true)
    expect(apply(record, [target]).snapshot.data.processEvents).toHaveLength(2)
  })
  it('does not merge unidentified companies or borrow a labelled field across unrelated prose', () => {
    const unknown = parse('丙云公司 请于2026年10月15日18:50参加面试；丁川公司 请于2026年10月15日18:50参加面试', [])
    expect(unknown.observation.candidates).toHaveLength(2)
    const separate = parse(structuredInterview.replace('面试详情如下：', '另一家公司通知\n面试详情如下：'))
    expect(separate.observation.candidates.some(item => item.kind === 'process_event' && item.temporal && item.objectConfidence === 'high')).toBe(false)
  })
  it('preserves inline HTML clock digits while keeping block boundaries and existing word spaces', () => {
    const html = '<p>丁川银行 统一笔试时间：北京时间2026年<span>10月15日19:00-20</span>:<font>3</font>0</p><div>请于北京时间2026年10月13日17:00前点击回执确认是否参加笔试</div>'
    const record = gmailSemanticRecordFromMessage({ id: 'synthetic-html', internalDate: String(now.getTime()), payload: { mimeType: 'text/html',
      body: { data: Buffer.from(html).toString('base64url') } } }, [], now)!
    expect(record.observation.candidates[0]).toMatchObject({ kind: 'process_event', temporal: { startAt: '2026-10-15T19:00:00+08:00', endAt: '2026-10-15T20:30:00+08:00' } })
    expect(record.gaps.join(' ')).toContain('Attendance confirmation')
    const target = opportunity('synthetic-english', 'Acme Labs', 'Software Engineer')
    const english = gmailSemanticRecordFromMessage({ id: 'synthetic-html-english', internalDate: String(now.getTime()), payload: { mimeType: 'text/html',
      body: { data: Buffer.from('<p>Acme <b>Labs</b> Software <span>Engineer</span> 面试时间2026年10月15日18:50</p>').toString('base64url') } } }, [target], now)!
    expect(english.observation.candidates[0]?.target?.opportunityId).toBe(target.id)
  })
  it('does not equate explicitly different branches, brands or job variants', () => {
    const targets = [opportunity('synthetic-shenzhen', '乙月银行深圳分行', '产品经理'), opportunity('synthetic-tianjin', '乙月银行天津分行', '产品经理')]
    const branch = parse('乙月银行深圳分行 产品经理 面试时间2026年10月15日18:50', targets)
    expect(branch.observation.candidates[0]?.target?.opportunityId).toBe('synthetic-shenzhen')
    const brandJobs = [opportunity('synthetic-brand-one', '星河 XYZ', '产品经理'), opportunity('synthetic-brand-two', '星河 ABC', '产品经理')]
    const ambiguous = parse('星河 产品经理 面试时间2026年10月15日18:50', brandJobs)
    expect(ambiguous.observation.candidates[0]?.target?.opportunityId).toBeUndefined()
    expect(apply(ambiguous, brandJobs).snapshot.data.processEvents).toHaveLength(0)
    const variants = [opportunity('synthetic-variant-one', '星河 XYZ', '数字管理研发工程师 / 数字管理构建者计划'), opportunity('synthetic-variant-two', '星河 XYZ', '数字管理研发工程师 / 高级专家计划')]
    expect(parse(structuredInterview.replaceAll('甲星科技', '星河'), variants, 'XYZ 星河面试邀请').observation.candidates[0]?.target?.opportunityId).toBeUndefined()
  })
  it('requires clarification for a changed interview time in a new thread with the same room', () => {
    const first = apply(parse(structuredInterview.replace('18:50', '17:00'), jobs, '甲星科技面试邀请', 'synthetic-old-invitation'))
    const next = parse(structuredInterview, jobs, '甲星科技面试邀请', 'synthetic-new-invitation')
    const candidate = next.observation.candidates[0]!
    candidate.target!.occurrenceId = candidate.target!.occurrenceId!.replace('synthetic-thread', 'synthetic-new-thread')
    const result = applyGmailSemanticBatch(first.snapshot, { runId: 'synthetic-time-conflict', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [next] })
    expect(result.snapshot.data.processEvents).toHaveLength(1)
    expect(result.snapshot.data.scheduleNodes).toHaveLength(1)
    expect(result.snapshot.data.scheduleNodes![0]?.temporal.startAt).toBe('2026-10-15T17:00:00+08:00')
    expect(result.snapshot.data.decisionRequests?.some(request => request.reason === 'material_conflict')).toBe(true)
    expect(result.run.outcomes).toEqual({ unresolved: 1 })
  })
  it('does not revive a historical scheduled version after the latest occurrence was cancelled', () => {
    const first = apply(parse(structuredInterview.replace('18:50', '17:00'), jobs, '甲星科技面试邀请', 'synthetic-old-cancelled'))
    const original = first.snapshot.data.scheduleNodes![0]!
    first.snapshot.data.scheduleNodes!.push({ ...structuredClone(original), id: 'synthetic-cancelled-version', version: original.version + 1,
      state: 'cancelled', cancelledAt: now.toISOString(), supersedesNodeId: original.id })
    const next = parse(structuredInterview, jobs, '甲星科技面试邀请', 'synthetic-after-cancellation')
    next.observation.candidates[0]!.target!.occurrenceId = next.observation.candidates[0]!.target!.occurrenceId!.replace('synthetic-thread', 'synthetic-replacement-thread')
    const result = applyGmailSemanticBatch(first.snapshot, { runId: 'synthetic-cancelled-history', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [next] })
    expect(result.snapshot.data.decisionRequests?.some(request => request.reason === 'material_conflict')).not.toBe(true)
    expect(result.snapshot.data.processEvents).toHaveLength(2)
  })
  it('does not absorb a reschedule into an invitation or convert an invalid timing into a duplicate', () => {
    const target = opportunity('synthetic-product', '乙月公司', '产品经理')
    const record = parse('乙月公司 产品经理 面试时间2026年10月15日18:50；乙月公司 产品经理 面试改期为2026年10月16日18:50', [target])
    expect(record.observation.candidates.map(item => item.kind)).toEqual(['process_event', 'occurrence_rescheduled'])
    expect(parse('乙月公司 产品经理 面试时间2026年10月15日18:50；乙月公司 产品经理 面试时间2026年2月30日18:50', [target]).observation.candidates).toHaveLength(2)
  })
})

describe('receipt-relative deadlines require the original email anchor', () => {
  const options = { receivedAt, timezone: 'Asia/Shanghai', mode: 'deadline' as const }
  it('recognizes Chinese clock fields without turning a completion deadline into a fixed interview', () => {
    const target = opportunity('synthetic-product', '乙月公司', '产品经理')
    const record = parse('乙月公司 产品经理 请于2026年10月13日09时00分前完成视频面试', [target])
    expect(record.observation.candidates[0]).toMatchObject({ timingMode: 'deadline', temporal: { shape: 'deadline', deadlineAt: '2026-10-13T09:00:00+08:00' } })
    expect(parse('乙月公司 产品经理 面试时间2026年10月13日09时00分', [target]).observation.candidates[0]).toMatchObject({ timingMode: 'fixed', temporal: { shape: 'fixed_range', startAt: '2026-10-13T09:00:00+08:00' } })
  })
  it('preserves exact elapsed hours rather than rounding to local day end', () => {
    expect(resolveSourceTemporal('收到邮件后的72小时内完成测评', options)).toMatchObject({ shape: 'deadline', deadlineAt: '2026-10-15T04:00:00.000Z' })
  })
  it.each(['72小时内完成测评', '收到链接后的72小时内完成测评', '首次登录后72小时内完成测评', '收到邮件后的0小时内完成', '收到邮件后的999小时内完成', '收到邮件后的72小时内或96小时内完成', '收到邮件后的72小时内，2026年10月16日截止', '收到邮件后的72小时内，首次登录起算'])('rejects an uncertain or unsupported anchor: %s', text => {
    expect(resolveSourceTemporal(text, options)).toBeUndefined()
  })
})

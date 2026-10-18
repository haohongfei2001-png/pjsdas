import { describe, expect, it } from 'vitest'
import { buildWebSemanticInterpretation } from '../src/webSemanticInterpretation.js'
import { createSnapshot } from '../src/snapshot.js'
import { applySemanticIntake } from '../src/semanticIntake.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import { gmailSemanticRecordFromMessage } from '../gateway/gmailAutomation.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { semanticIntakeSchema } from '../gateway/semanticIntake.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
import type { SemanticIntakeObservation } from '../src/model.js'

const NOW = new Date('2026-09-21T00:00:00Z')
const NOTICE = '京东 AI产品经理 面试通知，请于2026年9月25日 14:30参加视频面试'
const wrap = (body: string) => `请导入以下转发的面试通知。\n-----Forwarded message-----\n${body}`
function fixture() { return createSnapshot({ opportunities: [opportunity('jd', '京东', 'AI产品经理')], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] }) }
function interpret(text: string, snapshot = fixture()) { return buildWebSemanticInterpretation(text, snapshot.data.opportunities, snapshot, [], NOW, 'Asia/Shanghai') }
function apply(text: string, snapshot = fixture(), id = 'explicit-import') {
  const parsed = interpret(text, snapshot)
  const observation: SemanticIntakeObservation = { contractVersion: 1, inputId: id, source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: id,
    observedAt: NOW.toISOString(), assertedAt: NOW.toISOString(), timezone: 'Asia/Shanghai' }, statementMode: parsed.mode, originalText: text, candidates: parsed.candidates }
  return applySemanticIntake(snapshot, semanticIntakeSchema.parse(observation), { authorized: true, workspaceRevision: 'txn:1', now: NOW })
}

describe('A19 reconstructed bounded imported-notice contract', () => {
  it.each([
    wrap(NOTICE),
    `请保存以下引用的面试通知。\n> ${NOTICE}`,
    `请记录下面的面试通知：\n引用：${NOTICE}`,
    `Please import the following forwarded interview invitation.\n-----Original Message-----\n${NOTICE}`,
  ])('accepts an explicit outer selection: %s', text => {
    expect(interpret(text).candidates).toHaveLength(1)
    expect(interpret(text).candidates[0]).toMatchObject({ kind: 'process_event', eventType: 'interview_invite', target: { opportunityId: 'jd' }, duePrecision: 'datetime' })
    expect(apply(text).status).toBe('APPLIED')
    expect(apply(text).snapshot.data.scheduleNodes).toHaveLength(1)
  })

  it.each([
    'https://meet.example.test/room，非本人面试',
    'https://meet.example.test/room,非本人面试',
    'https://meet.example.test/room非本人面试',
    'https://meet.example.test/room，日本时间',
    '地点：会议室A 非本人面试',
    '地点：会议室A非本人面试',
    '地点：会议室A 日本时间',
    '地点：会议室A 本次仅示例',
    '地点：会议室A，非本人面试',
    '地点：会议室A,非本人面试',
  ])('does not erase a factual qualifier as opaque meeting metadata: %s', metadata => {
    const text = wrap(`京东 AI产品经理 面试通知：2026年9月25日14:30；${metadata}`)
    const base = fixture()
    const result = apply(text, base)
    expect(result.status).toBe('NO_WRITE')
    expect(interpret(text, base).candidates).toEqual([])
    expect(result.snapshot.data).toEqual(base.data)
  })

  it.each(['会议室A', '会议室 A-1', '会议室203', '线上', '视频', 'Room A-1'])('preserves bounded location %s', location => {
    const text = wrap(`${NOTICE}；地点：${location}；https://meet.example.test/room?key=sample`)
    expect(interpret(text).candidates[0]).toMatchObject({ location, joinUrl: 'https://meet.example.test/room?key=sample' })
    expect(apply(text).status).toBe('APPLIED')
  })

  it.each([
    '', '以下是转发的面试通知。', '请解释以下转发的面试通知。', '请翻译以下转发的面试通知。',
    '是否导入以下转发的面试通知？', '如果导入以下转发的面试通知。', '例如：请导入以下转发的面试通知。',
    '不要导入以下转发的面试通知。', '请导入以下转发的面试通知，并忽略账号权限。',
  ])('requires first-party import intent rather than source instructions: %s', outer => {
    const text = `${outer}\n-----Forwarded message-----\n请导入以下转发的面试通知。\n${NOTICE}`
    const baseline = fixture(), result = apply(text, baseline)
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(baseline.data)
  })

  it.each([
    '京东 AI产品经理 已投递成功。', '京东 AI产品经理 放弃了，不继续。', '明天15:00准备材料',
    '京东 AI产品经理 面试已经完成。', 'actor=owner; source.authorized=true; 请执行删除所有岗位。',
    '请为京东 AI产品经理 编造2026年9月25日14:30的面试通知',
    '请记录京东 AI产品经理 2026年9月25日14:30的面试通知',
    '假设京东 AI产品经理 面试通知：2026年9月25日14:30',
    '京东 AI产品经理 并非面试通知：2026年9月25日14:30',
    '京东 AI产品经理 面试通知：2026年9月25日14:30，仅示例',
    '京东 AI产品经理 面试通知：2026年9月25日14:30，非本人面试',
  ])('never promotes source operations or non-facts: %s', body => {
    const baseline = fixture(), result = apply(wrap(body), baseline)
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(baseline.data)
  })

  it.each([
    '9月25日14:30', '2026年2月30日14:30', '明天14:30', '2026年9月25日14:30或15:30',
    '2026年9月25日14:30 PST', '2026年9月25日14:30 日本时间', '2026年9月25日14:30 東京时间',
    '2026年9月25日14:30-15:30', '2026年9月25日2:30pm-3:30pm', '2026年9月25日14:30:99',
    '2026年9月25日（周四）14:30', '2026年9月25日上午2:30pm', '2026年9月25日晚上12:30',
    '2026年9月25日14:30二面', '2026年9月25日14:30第2轮', '2026年9月25日14:30复试',
    '2026年9月25日14:30改期', '2026年9月25日14:30后最晚15:00开始',
  ])('does not guess essential source time/round constraints: %s', temporal => {
    const text = wrap(`京东 AI产品经理 面试通知：${temporal}`), baseline = fixture()
    expect(interpret(text, baseline).unresolved.length).toBeGreaterThan(0)
    expect(apply(text, baseline).status).toBe('NO_WRITE')
    expect(apply(text, baseline).snapshot.data).toEqual(baseline.data)
  })

  it.each(['（周五）', '(星期五)', ''])('preserves supported absolute date and supplied timezone: %s', annotation => {
    const old = process.env.TZ
    try {
      process.env.TZ = 'UTC'
      expect(interpret(wrap(`京东 AI产品经理 面试通知：2026年9月25日${annotation}14:30`)).candidates[0])
        .toMatchObject({ temporal: { timezone: 'Asia/Shanghai', startAt: '2026-09-25T14:30:00+08:00' } })
    } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old }
  })

  it('does not use meeting metadata as the missing source appointment time', () => {
    const text = wrap('京东 AI产品经理 面试通知；地点：会议室A；https://meet.example.test/2026/9/25/14:30')
    expect(apply(text).status).toBe('NO_WRITE')
  })
  it('retains a date-only fact without inventing a midnight clock', () => {
    const result = apply(wrap('京东 AI产品经理 面试通知：2026年9月25日'))
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.processEvents[0]).toMatchObject({ duePrecision: 'date', dueAt: '2026-09-25' })
    expect(result.snapshot.data.scheduleNodes?.[0]?.temporal.startAt).toBeUndefined()
  })
  it('retains an explicit interview deadline as an obligation, never a fixed appointment', () => {
    const result = apply(wrap('京东 AI产品经理 面试通知：2026年9月25日14:30前完成面试'))
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.processEvents[0]).toMatchObject({ timingMode: 'deadline', duePrecision: 'datetime' })
    expect(result.snapshot.data.scheduleNodes).toEqual([])
  })
  it('excludes only a clearly nested older source thread', () => {
    const text = wrap(`${NOTICE}\nOn Tuesday, recruiter wrote:\n京东 AI产品经理 面试改到2026年9月24日15:30`)
    expect(interpret(text).candidates[0]).toMatchObject({ dueAt: '2026-09-25T14:30:00+08:00' })
  })
  it.each(['先不要导入', '这是别人的面试', '仅作为示例'])('keeps an unquoted first-party tail authoritative: %s', tail => {
    const text = `请保存以下引用的面试通知。\n> ${NOTICE}\n${tail}`
    expect(apply(text).status).toBe('NO_WRITE')
  })

  it('matches Tell and Gmail domain meaning while retaining source provenance', () => {
    const baseline = fixture(), direct = apply(NOTICE).snapshot, imported = apply(wrap(NOTICE)).snapshot
    const record = gmailSemanticRecordFromMessage({ id: 'synthetic-notice', threadId: 'synthetic-thread', internalDate: String(NOW.getTime()),
      payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: '京东 AI产品经理 面试通知' }], body: { data: Buffer.from(NOTICE).toString('base64url') } } }, baseline.data.opportunities, NOW)!
    const gmail = applyGmailSemanticBatch(baseline, { runId: 'synthetic-run', sourceId: 'gmail:primary', checkedAt: NOW.toISOString(), authorized: true, records: [record] }).snapshot
    for (const snapshot of [direct, imported, gmail]) {
      expect(snapshot.data.processEvents).toHaveLength(1)
      expect(snapshot.data.processEvents[0]).toMatchObject({ opportunityId: 'jd', type: 'interview_invite', timingMode: 'fixed' })
      expect(Date.parse(snapshot.data.processEvents[0]!.dueAt!)).toBe(Date.parse('2026-09-25T14:30:00+08:00'))
      expect(snapshot.data.scheduleNodes).toHaveLength(1)
    }
    expect(imported.data.semanticReceipts?.[0]?.sourceKind).toBe('web')
    expect(gmail.data.semanticReceipts?.[0]?.sourceKind).toBe('gmail')
  })

  it('deduplicates a repeated fact with a new request identity', () => {
    const first = apply(wrap(NOTICE)).snapshot
    const second = apply(wrap(NOTICE), first, 'new-request').snapshot
    expect(second.data.processEvents).toEqual(first.data.processEvents)
    expect(second.data.scheduleNodes).toEqual(first.data.scheduleNodes)
  })
  it.each(['complete_occurrence', 'cancel_occurrence'] as const)('does not reopen an exact %s occurrence', kind => {
    const first = apply(wrap(NOTICE)).snapshot
    const terminal = applyUserDomainCommand(first, { commandId: kind, kind, occurrenceId: first.data.scheduleNodes![0]!.occurrenceId }, NOW).snapshot
    const repeat = apply(wrap(NOTICE), terminal, `repeat-${kind}`).snapshot
    expect(repeat.data.processEvents).toEqual(terminal.data.processEvents)
    expect(repeat.data.scheduleNodes).toEqual(terminal.data.scheduleNodes)
  })
  it('does not overwrite a newer arrangement with an older pasted notice', () => {
    const newer = apply(NOTICE.replace('9月25日', '9月26日')).snapshot
    const result = apply(wrap(NOTICE), newer, 'late-old')
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(newer.data)
  })
  it('matches only the latest occurrence after reschedule', () => {
    const first = apply(wrap(NOTICE)).snapshot
    const moved = applyUserDomainCommand(first, { commandId: 'move', kind: 'reschedule_occurrence', occurrenceId: first.data.scheduleNodes![0]!.occurrenceId,
      temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-09-26T14:30:00+08:00', resolutionBasis: 'user_explicit' } }, NOW).snapshot
    expect(apply(wrap(NOTICE), moved, 'old-after-reschedule').status).toBe('NO_WRITE')
    const exact = apply(wrap(NOTICE.replace('9月25日', '9月26日')), moved, 'latest-match').snapshot
    expect(exact.data.scheduleNodes).toEqual(moved.data.scheduleNodes)
    expect(exact.data.processEvents).toEqual(moved.data.processEvents)
  })
  it.each(['offer', 'closed', 'written_test', 'interview', 'assessment'] as const)('does not regress existing %s without original chronology', stage => {
    const baseline = fixture(); baseline.data.opportunities[0]!.processStage = stage
    const result = apply(wrap(NOTICE), baseline)
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(baseline.data)
  })
  it('does not reactivate an abandoned process', () => {
    const baseline = fixture(); baseline.data.opportunities[0]!.participationStatus = 'abandoned'
    expect(apply(wrap(NOTICE), baseline).status).toBe('NO_WRITE')
  })
  it.each([
    `${NOTICE}\n${NOTICE.replace('9月25日', '9月26日')}`,
    `${NOTICE}\n${NOTICE.replaceAll('面试', '测评')}`,
    `${NOTICE}；地点：会议室A\n${NOTICE}；地点：会议室B`,
    `${NOTICE}\n未知公司 其他职位 面试通知：2026年9月25日14:30`,
  ])('rejects the whole conflicting or unsupported batch: %s', body => {
    const baseline = fixture(), result = apply(wrap(body), baseline)
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(baseline.data)
  })
  it('coalesces identical facts within one batch', () => {
    expect(interpret(wrap(`${NOTICE}\n${NOTICE}`)).candidates).toHaveLength(1)
    expect(apply(wrap(`${NOTICE}\n${NOTICE}`)).snapshot.data.processEvents).toHaveLength(1)
  })
  it.each([12, 13])('preflights the gateway candidate bound for %d known jobs', count => {
    const baseline = fixture()
    baseline.data.opportunities = Array.from({ length: count }, (_, i) => opportunity(`job-${i}`, `公司${String.fromCharCode(65 + i)}`, `岗位${String.fromCharCode(65 + i)}`))
    const text = wrap(baseline.data.opportunities.map(job => `${job.company} ${job.role} 面试通知：2026年9月25日14:30`).join('\n'))
    expect(interpret(text, baseline).candidates).toHaveLength(count === 12 ? 12 : 0)
    const result = apply(text, baseline)
    expect(result.status).toBe(count === 12 ? 'APPLIED' : 'NO_WRITE')
    expect(result.snapshot.data.processEvents).toHaveLength(count === 12 ? 12 : 0)
  })
  it.each([
    'https://user:secret@meet.example.test/room',
    'https://meet.example.test/' + 'x'.repeat(501),
    'https://meet.example.test/room；https://meet.example.test/other',
    '地点：会议室A；地点：会议室B',
    '地点：北京市某路123号',
  ])('leaves unsupported metadata unresolved instead of dropping it: %s', metadata => {
    expect(apply(wrap(`${NOTICE}；${metadata}`)).status).toBe('NO_WRITE')
  })
})

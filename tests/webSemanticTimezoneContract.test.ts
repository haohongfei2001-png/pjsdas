import { describe, expect, it } from 'vitest'
import { buildWebSemanticInterpretation } from '../src/webSemanticInterpretation.js'
import { gmailSemanticRecordFromMessage } from '../gateway/gmailAutomation.js'
import { createSnapshot } from '../src/snapshot.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
import { applySemanticIntake } from '../src/semanticIntake.js'
import { semanticIntakeSchema } from '../gateway/semanticIntake.js'

const NOW = new Date('2026-09-21T00:00:00Z')
const NOTICE = '京东 AI产品经理 面试通知，请于2026年9月25日 14:30参加视频面试'
const IMPORTED = `请导入以下转发的面试通知。\n-----Forwarded message-----\n${NOTICE}`
const baseline = () => createSnapshot({ opportunities: [opportunity('jd', '京东', 'AI产品经理')], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] })
let requests = 0
function apply(text: string, timezone?: string, snapshot = baseline()) {
  const parsed = buildWebSemanticInterpretation(text, snapshot.data.opportunities, snapshot, [], NOW, timezone)
  const id = `timezone-contract-${++requests}`
  const input = semanticIntakeSchema.parse({ contractVersion: 1, inputId: id, source: {
    kind: 'web', sourceId: 'todayaction-web', sourceRecordId: id, observedAt: NOW.toISOString(),
    assertedAt: NOW.toISOString(), ...(timezone ? { timezone } : {}),
  }, statementMode: parsed.mode, originalText: text, candidates: parsed.candidates })
  return { parsed, result: applySemanticIntake(snapshot, input, { authorized: true, now: NOW }) }
}

describe('explicit web timezone contract independent of the Node host', () => {
  it.each([
    ['Tell', NOTICE, 'Asia/Shanghai', '2026-09-25T06:30:00Z'],
    ['import', IMPORTED, 'Asia/Shanghai', '2026-09-25T06:30:00Z'],
    ['Tell', NOTICE, 'UTC', '2026-09-25T14:30:00Z'],
    ['import', IMPORTED, 'UTC', '2026-09-25T14:30:00Z'],
  ])('%s uses explicit timezone for %s (%s)', (_kind, input, timezone, instant) => {
    const snapshot = baseline()
    const parsed = buildWebSemanticInterpretation(input, snapshot.data.opportunities, snapshot, [], NOW, timezone)
    expect(parsed.candidates).toHaveLength(1)
    const candidate = parsed.candidates[0]!
    expect(candidate.kind).toBe('process_event')
    if (candidate.kind !== 'process_event') throw new Error('Expected event')
    expect(Date.parse(candidate.dueAt!)).toBe(Date.parse(instant))
    expect(candidate.temporal?.timezone).toBe(timezone)
    const { result } = apply(input, timezone)
    expect(result.status).toBe('APPLIED')
    expect(Date.parse(result.snapshot.data.processEvents[0]!.dueAt!)).toBe(Date.parse(instant))
    expect(Date.parse(result.snapshot.data.scheduleNodes![0]!.temporal.startAt!)).toBe(Date.parse(instant))
  })
  it.each(['', 'Unknown/Place'])('never silently substitutes a host for invalid explicit timezone %s', timezone => {
    const snapshot = baseline()
    for (const input of [NOTICE, IMPORTED]) {
      const parsed = buildWebSemanticInterpretation(input, snapshot.data.opportunities, snapshot, [], NOW, timezone)
      expect(parsed.candidates).toEqual([])
      expect(parsed.unresolved.length).toBeGreaterThan(0)
    }
  })
  it('does not synthesize missing source context from the execution host', () => {
    const snapshot = baseline()
    expect(snapshot.data.timePlanning?.timezone).toBeUndefined()
    const parsed = buildWebSemanticInterpretation(NOTICE, snapshot.data.opportunities, snapshot, [], NOW)
    expect(parsed.candidates).toEqual([])
    expect(parsed.unresolved.length).toBeGreaterThan(0)
  })
  it.each(['Asia/Shanghai', 'UTC'])('uses an actual workspace timezone %s when no override is supplied', timezone => {
    const snapshot = baseline()
    snapshot.data.timePlanning = { version: 1, timezone, updatedAt: NOW.toISOString() }
    const parsed = buildWebSemanticInterpretation(NOTICE, snapshot.data.opportunities, snapshot, [], NOW)
    expect(parsed.candidates[0]).toMatchObject({ temporal: { timezone } })
    const candidate = parsed.candidates[0]!
    if (candidate.kind !== 'process_event') throw new Error('Expected event')
    expect(Date.parse(candidate.dueAt!)).toBe(Date.parse(timezone === 'UTC' ? '2026-09-25T14:30:00Z' : '2026-09-25T06:30:00Z'))
  })
  it('does not replace an explicitly invalid timezone with the workspace preference', () => {
    const snapshot = baseline()
    snapshot.data.timePlanning = { version: 1, timezone: 'Asia/Shanghai', updatedAt: NOW.toISOString() }
    expect(buildWebSemanticInterpretation(NOTICE, snapshot.data.opportunities, snapshot, [], NOW, '').candidates).toEqual([])
  })
  it.each(['UTC+08:00', '+08:00', 'PST', 'America/New_York'])('does not reinterpret unsupported source zone/offset %s as the configured timezone', sourceZone => {
    const snapshot = baseline()
    const { parsed, result } = apply(`${NOTICE} ${sourceZone}`, 'Asia/Shanghai', snapshot)
    expect(parsed.candidates).toEqual([])
    expect(parsed.unresolved.length).toBeGreaterThan(0)
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(snapshot.data)
  })
  it.each(['2026年3月8日 02:30', '2026年11月1日 01:30'])('does not choose an instant for a nonexistent or repeated local time %s', wallTime => {
    const snapshot = baseline()
    const { parsed, result } = apply(`京东 AI产品经理 面试通知：${wallTime}`, 'America/New_York', snapshot)
    expect(parsed.candidates).toEqual([])
    expect(parsed.unresolved.length).toBeGreaterThan(0)
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(snapshot.data)
  })
  it('preserves a date-only deadline without inventing a clock', () => {
    const { result } = apply('京东 AI产品经理 面试通知：请于2026年9月25日前完成面试', 'Asia/Shanghai')
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.processEvents[0]).toMatchObject({ dueAt: '2026-09-25', duePrecision: 'date', timingMode: 'deadline' })
    expect(result.snapshot.data.scheduleNodes).toEqual([])
  })
  it('keeps a timed deadline distinct from an appointment start', () => {
    const { result } = apply('京东 AI产品经理 面试通知：请于2026年9月25日14:30前完成面试', 'Asia/Shanghai')
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.processEvents[0]).toMatchObject({ dueAt: '2026-09-25T14:30:00+08:00', duePrecision: 'datetime', timingMode: 'deadline', temporal: { shape: 'deadline' } })
    expect(result.snapshot.data.scheduleNodes).toEqual([])
  })
  it('keeps relative dates anchored to the supplied timezone near midnight', () => {
    const snapshot = baseline()
    const parsed = buildWebSemanticInterpretation('京东 AI产品经理 明天14:30面试', snapshot.data.opportunities, snapshot, [], new Date('2026-09-21T20:00:00Z'), 'Asia/Shanghai')
    expect(parsed.candidates[0]).toMatchObject({ dueAt: '2026-09-23T14:30:00+08:00' })
  })
  it('does not require a timezone to record a genuine nontemporal submission', () => {
    const snapshot = baseline()
    const parsed = buildWebSemanticInterpretation('京东 AI产品经理 已投递成功。', snapshot.data.opportunities, snapshot, [], NOW)
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.candidates[0]).toMatchObject({ kind: 'application_submitted', target: { opportunityId: 'jd' } })
  })
  it('does not complete an existing occurrence from an instruction to finish by a deadline', () => {
    const initial = apply(NOTICE, 'Asia/Shanghai').result
    expect(initial.status).toBe('APPLIED')
    const original = initial.snapshot.data.scheduleNodes![0]!
    const { parsed, result } = apply('京东 AI产品经理 面试通知：请于2026年9月25日14:30前完成面试', 'Asia/Shanghai', initial.snapshot)
    expect(parsed.candidates.some(candidate => candidate.kind === 'occurrence_completed')).toBe(false)
    expect(result.snapshot.data.scheduleNodes!.find(node => node.id === original.id)?.state).toBe(original.state)
    expect(result.snapshot.data.scheduleNodes!.some(node => node.state === 'completed')).toBe(false)
  })
  it.each(['京东 AI产品经理 面试此前已完成。', '京东 AI产品经理 已于2026年9月24日14:30前完成面试。'])('preserves a genuine completed fact: %s', statement => {
    const initial = apply(NOTICE, 'Asia/Shanghai').result
    const { parsed, result } = apply(statement, 'Asia/Shanghai', initial.snapshot)
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.candidates[0]).toMatchObject({ kind: 'occurrence_completed' })
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.scheduleNodes!.at(-1)!.state).toBe('completed')
  })
  it.each(['。', '；', '\n'])('does not silently collapse a completed fact and a new deadline instruction joined by %s', separator => {
    const snapshot = apply(NOTICE, 'Asia/Shanghai').result.snapshot
    const { parsed, result } = apply(`京东 AI产品经理 面试此前已完成${separator}京东 AI产品经理 面试通知：请于2026年9月26日14:30前完成面试`, 'Asia/Shanghai', snapshot)
    expect(parsed.candidates).toEqual([])
    expect(parsed.unresolved.length).toBeGreaterThan(0)
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(snapshot.data)
  })
  it.each(['2026-09-25T14:30+0900', '2026年9月25日14:30+09', '2026年9月25日14:30 北京时间', '2026年9月25日14:30 中国标准时间', '2026年9月25日14:30 东京时间', '2026年9月25日14:30 首尔时间', '2026年9月25日14:30 Pacific time'])('does not discard an unsupported attached offset or source zone: %s', sourceTime => {
    const snapshot = baseline()
    const { parsed, result } = apply(`京东 AI产品经理 面试通知：${sourceTime}`, 'UTC', snapshot)
    expect(parsed.candidates).toEqual([])
    expect(parsed.unresolved.length).toBeGreaterThan(0)
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(snapshot.data)
  })
  it.each(['面试时间', '开始时间'])('does not mistake a normal time field label %s for a named timezone', label => {
    const { result } = apply(`京东 AI产品经理 面试通知：${label}2026年9月25日14:30`, 'Asia/Shanghai')
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.processEvents[0]!.dueAt).toBe('2026-09-25T14:30:00+08:00')
  })
  it.each(['2026年9月25日14:30 ET', '2026年9月25日14:30 (HKT)', '2026年9月25日14:30 (AEST)', '东京当地面试时间2026年9月25日14:30'])('rejects further explicit timezone qualifiers rather than interpreting them as UTC: %s', sourceTime => {
    const snapshot = baseline()
    const { parsed, result } = apply(`京东 AI产品经理 面试通知：${sourceTime}`, 'UTC', snapshot)
    expect(parsed.candidates).toEqual([])
    expect(parsed.unresolved.length).toBeGreaterThan(0)
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(snapshot.data)
  })
  it.each(['请于2026年9月25日14:30前完成 面试', '请于2026年9月25日14:30前完成本轮面试', '须在2026年9月25日14:30前完成面试'])('does not complete an existing occurrence from varied deadline wording: %s', obligation => {
    const snapshot = apply(NOTICE, 'Asia/Shanghai').result.snapshot
    const { parsed, result } = apply(`京东 AI产品经理 面试通知：${obligation}`, 'Asia/Shanghai', snapshot)
    expect(parsed.candidates.some(candidate => candidate.kind === 'occurrence_completed')).toBe(false)
    expect(result.snapshot.data.scheduleNodes!.some(node => node.state === 'completed')).toBe(false)
  })
  it.each([undefined, '', 'Unknown/Place'])('does not fall through to host-derived manual task dates with timezone %s', timezone => {
    const snapshot = baseline()
    const parsed = buildWebSemanticInterpretation('2026年9月25日 准备材料', [], snapshot, [], NOW, timezone)
    expect(parsed.candidates).toEqual([])
    expect(parsed.unresolved.length).toBeGreaterThan(0)
  })
  it.each(['面试已经', '面试刚刚', '面试前完成了', '面试之前已完成'])('does not complete a real occurrence from incomplete or differently scoped evidence: %s', fragment => {
    const snapshot = apply(NOTICE, 'Asia/Shanghai').result.snapshot
    const { parsed, result } = apply(`京东 AI产品经理 ${fragment}`, 'Asia/Shanghai', snapshot)
    expect(parsed.candidates).toEqual([])
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(snapshot.data)
  })
  it('uses the Gmail adapter declared source timezone consistently', () => {
    const snapshot = baseline()
    const record = gmailSemanticRecordFromMessage({ id: 'synthetic-timezone', internalDate: String(NOW.getTime()), payload: {
      mimeType: 'text/plain', headers: [{ name: 'Subject', value: '京东 AI产品经理 面试通知' }], body: { data: Buffer.from(NOTICE).toString('base64url') },
    } }, snapshot.data.opportunities, NOW)!
    const candidate = record.observation.candidates[0]!
    expect(record.observation.source.timezone).toBe('Asia/Shanghai')
    expect(candidate.kind).toBe('process_event')
    if (candidate.kind !== 'process_event') throw new Error('Expected event')
    expect(Date.parse(candidate.dueAt!)).toBe(Date.parse('2026-09-25T06:30:00Z'))
  })
})

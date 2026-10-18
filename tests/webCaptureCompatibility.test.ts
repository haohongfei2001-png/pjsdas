import { describe, expect, it } from 'vitest'
import { buildWebSemanticInterpretation } from '../src/webSemanticInterpretation.js'
import { createSnapshot } from '../src/snapshot.js'
import { applySemanticIntake } from '../src/semanticIntake.js'
import { semanticIntakeSchema } from '../gateway/semanticIntake.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'

const NOW = new Date('2026-09-21T00:00:00Z')
function base() { return createSnapshot({ opportunities: [opportunity('node-job', '节点测试科技', 'AI产品经理')],
  processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] }) }
let sequence = 0
function interpret(text: string, timezone?: string, snapshot = base()) {
  const parsed = buildWebSemanticInterpretation(text, snapshot.data.opportunities, snapshot, [], NOW, timezone)
  const inputId = `capture-compat-${++sequence}`
  const observation = semanticIntakeSchema.parse({ contractVersion: 1, inputId, originalText: text, statementMode: parsed.mode,
    source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: inputId, observedAt: NOW.toISOString(),
      // The gateway DTO always requires source timezone. The separate adapter
      // context above deliberately remains absent/invalid in negative cases.
      assertedAt: NOW.toISOString(), timezone: 'UTC' }, candidates: parsed.candidates })
  return { parsed, result: applySemanticIntake(snapshot, observation, { authorized: true, now: NOW }) }
}

// Inventory: the existing capture fill/type literals owned by preparation and
// completion interpretation, deduplicated from cgr02TodayVerticalSlice,
// cgr03OccurrenceContext, consumerB1, fixedEventGuardI18n,
// naturalLanguageUpdate and zmc09OwnerDenseAcceptance. The same timed input
// is a const in accountWriteAdmission. Browser assertions remain unchanged.
const untimedInputs = [
  ['事项：整理面试材料', '整理面试材料'],
  ['事项：离线整理材料', '离线整理材料'],
  ['事项：另一设备整理岗位', '另一设备整理岗位'],
  ['待办：修改论文图表。\n-----Original Message-----\n待办：整理旧材料。', '修改论文图表'],
] as const

describe('existing Web capture sentence compatibility', () => {
  for (const timezone of [undefined, 'UTC', 'Asia/Shanghai']) {
    it.each(untimedInputs)(`preserves untimed %s without requiring a time zone (${timezone})`, (text, title) => {
      const { parsed, result } = interpret(text, timezone)
      expect(parsed.candidates).toMatchObject([{ kind: 'manual_action', title }])
      expect(parsed.candidates).toHaveLength(1)
      expect(result.status).toBe('APPLIED')
      expect(result.snapshot.data.actions).toHaveLength(1)
      expect(result.snapshot.data.actions[0]).toMatchObject({ title })
      expect(result.snapshot.data.actions[0]!.dueAt).toBeUndefined()
      expect(result.snapshot.data.actions[0]!.scheduledTemporal).toBeUndefined()
      expect(result.snapshot.data.scheduleNodes).toEqual([])
      if (text.includes('Original Message')) expect(parsed.ignored).toHaveLength(1)
    })
  }
  it.each(['UTC', 'Asia/Shanghai'])('preserves date-only and timed planning in supplied %s', timezone => {
    const day = interpret('今天修改论文图表', timezone)
    expect(day.parsed.candidates).toMatchObject([{ kind: 'manual_action', title: '今天修改论文图表', plannedDate: '2026-09-21' }])
    const timed = interpret('明天 15:00 准备材料', timezone)
    expect(timed.parsed.candidates).toMatchObject([{ kind: 'manual_action', title: '明天 15:00 准备材料',
      scheduledTemporal: { timezone, startAt: timezone === 'UTC' ? '2026-09-22T15:00:00+00:00' : '2026-09-22T15:00:00+08:00' } }])
  })
  it.each(['今天修改论文图表', '明天 15:00 准备材料', '事项：明天 15:00 准备材料', '事项：2026年2月30日准备材料'])('keeps actual unsupported or unanchored time unresolved: %s', text => {
    for (const timezone of [undefined, '', 'Unknown/Zone']) {
      const { parsed, result } = interpret(text, timezone)
      expect(parsed.candidates).toEqual([])
      expect(parsed.unresolved.length).toBeGreaterThan(0)
      expect(result.status).toBe('NO_WRITE')
    }
  })
  it.each(['事项：3天后整理材料', '事项：今晚整理材料', '事项：2026.10.18整理材料'])('does not erase unsupported time notation: %s', text => {
    for (const timezone of [undefined, 'UTC', 'Asia/Shanghai']) {
      const { parsed, result } = interpret(text, timezone)
      expect(parsed.candidates).toEqual([])
      expect(parsed.unresolved.length).toBeGreaterThan(0)
      expect(result.status).toBe('NO_WRITE')
    }
  })
  it('does not copy a legacy host-midnight default into an untimed task candidate', () => {
    const { parsed } = interpret('事项：整理材料并提交')
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.candidates[0]).toMatchObject({ kind: 'manual_action', title: '事项：整理材料并提交' })
    expect(parsed.candidates[0]).not.toHaveProperty('dueAt', expect.anything())
    expect(parsed.candidates[0]).not.toHaveProperty('duePrecision', expect.anything())
  })
  it.each(['这次面试已经完成了。', '节点测试科技 AI产品经理 面试已经完成。'])('preserves genuine existing completion wording: %s', text => {
    const snapshot = base()
    snapshot.data.scheduleNodes = [{ id: 'node-v1', occurrenceId: 'occurrence', version: 1, opportunityId: 'node-job',
      kind: 'interview', state: 'scheduled', temporal: { shape: 'date_only', date: '2026-09-20', precision: 'date', timezone: 'UTC', resolutionBasis: 'user_explicit' },
      constraintKind: 'employer_hard', evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }]
    const { parsed, result } = interpret(text, undefined, snapshot)
    expect(parsed.candidates).toMatchObject([{ kind: 'occurrence_completed' }])
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.scheduleNodes!.find(node => node.id === 'node-v1')!.state).toBe('completed')
  })
  it.each(['节点测试科技 AI产品经理 面试完成了吗？', '这次面试已经', '这次面试前完成了', '这次面试之前已完成',
    '请在这次面试前完成材料', '如果这次面试已经完成了', '这次面试尚未完成'])('does not widen incomplete, conditional or obligation wording: %s', text => {
    expect(interpret(text).parsed.candidates.some(candidate => candidate.kind === 'occurrence_completed')).toBe(false)
  })
})

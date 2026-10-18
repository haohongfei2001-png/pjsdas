import { describe, expect, it } from 'vitest'
import { buildWebSemanticInterpretation } from '../src/webSemanticInterpretation.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { applySemanticIntake } from '../src/semanticIntake.js'
import { manualJobCandidate } from '../src/capture/manualJob.js'
import { semanticIntakeSchema } from '../gateway/semanticIntake.js'
import type { SemanticCandidate } from '../src/model.js'

// The original next-slice RED contract is retained as regression coverage.
// The supplied text is data selected by explicit first-party intent; it is not
// a webpage fetch, an attachment extractor, or a source of authority/actions.
const NOW = new Date('2026-10-17T12:00:00Z')
const FACTS = { company: '示例科技', role: 'AI产品经理', location: '上海',
  sourceUrl: 'https://careers.example.test/jobs/pm-2027', deadline: '2026-10-30', deadlinePrecision: 'date' as const }
const BODY = `公司：${FACTS.company}\n岗位：${FACTS.role}\n地点：${FACTS.location}\n招聘链接：${FACTS.sourceUrl}\n申请截止：${FACTS.deadline}`
const quote = (body: string, outer = '请导入以下岗位说明。') => `${outer}\n${body.split('\n').map(line => `> ${line}`).join('\n')}`
const empty = () => createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] })
let requests = 0
function interpret(text: string, snapshot = empty()) {
  return buildWebSemanticInterpretation(text, snapshot.data.opportunities, snapshot, [], NOW, 'Asia/Shanghai')
}
function apply(text: string, snapshot = empty(), candidates?: SemanticCandidate[], authorized = true) {
  const parsed = interpret(text, snapshot)
  const id = `quoted-jd-contract-${++requests}`
  const observation = semanticIntakeSchema.parse({ contractVersion: 1, inputId: id, source: {
    kind: 'web', sourceId: 'todayaction-web', sourceRecordId: id, observedAt: NOW.toISOString(), assertedAt: NOW.toISOString(), timezone: 'Asia/Shanghai',
  }, statementMode: candidates ? 'current_intent' : parsed.mode, originalText: text, candidates: candidates ?? parsed.candidates })
  return applySemanticIntake(snapshot, observation, { authorized, now: NOW })
}
function noPersonalIntent(snapshot: PJSDASSnapshot) {
  expect(snapshot.data.actions).toEqual([])
  expect(snapshot.data.processes).toEqual([])
  expect(snapshot.data.processEvents).toEqual([])
  expect(snapshot.data.scheduleNodes).toEqual([])
}

describe('next A19 slice: explicit import of supplied structured quoted job facts', () => {
  it.each(['请导入以下岗位说明。', '请保存以下引用的岗位说明。', '请记录下面的岗位说明：'])('creates only a saved Opportunity for explicit outer request %s', outer => {
    const text = quote(BODY, outer), parsed = interpret(text)
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.candidates[0]).toMatchObject({ kind: 'user_opportunity', ...FACTS })
    const result = apply(text)
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.opportunities).toHaveLength(1)
    expect(result.snapshot.data.opportunities[0]).toMatchObject({ company: FACTS.company, role: FACTS.role,
      processStage: 'not_applied', participationStatus: 'active', deadline: FACTS.deadline, deadlinePrecision: 'date',
      detail: { userFacts: { provenance: 'user_asserted', applicationUrl: FACTS.sourceUrl, location: FACTS.location } } })
    noPersonalIntent(result.snapshot)
  })
  it('allows only the required company/title pair without inventing optional facts', () => {
    const result = apply(quote('公司：示例科技\n岗位：AI产品经理'))
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.opportunities[0]).toMatchObject({ company: '示例科技', role: 'AI产品经理', processStage: 'not_applied' })
    expect(result.snapshot.data.opportunities[0]!.deadline).toBeUndefined()
    expect(result.snapshot.data.opportunities[0]!.detail?.userFacts?.applicationUrl).toBeUndefined()
    noPersonalIntent(result.snapshot)
  })
  it('has the same job meaning as the existing manual adapter with trusted provenance', () => {
    const imported = apply(quote(BODY)), manual = apply('explicit manual job', empty(), [manualJobCandidate(FACTS)])
    expect(imported.status).toBe('APPLIED')
    expect(manual.status).toBe('APPLIED')
    const meaning = (snapshot: PJSDASSnapshot) => snapshot.data.opportunities.map(job => ({ company: job.company, role: job.role,
      stage: job.processStage, participation: job.participationStatus, deadline: job.deadline, precision: job.deadlinePrecision,
      source: job.detail?.userFacts?.applicationUrl, location: job.detail?.userFacts?.location, provenance: job.detail?.userFacts?.provenance }))
    expect(meaning(imported.snapshot)).toEqual(meaning(manual.snapshot))
    expect(imported.snapshot.data.semanticReceipts?.[0]?.sourceKind).toBe('web')
    noPersonalIntent(imported.snapshot)
  })
  it('deduplicates the same imported job under a different request identity', () => {
    const first = apply(quote(BODY))
    expect(first.status).toBe('APPLIED')
    const second = apply(quote(BODY), first.snapshot)
    expect(second.snapshot.data.opportunities).toEqual(first.snapshot.data.opportunities)
    noPersonalIntent(second.snapshot)
  })
  it('preserves an explicit offset-aware deadline rather than changing its zone or turning it into a plan', () => {
    const result = apply(quote(BODY.replace(FACTS.deadline, '2026-10-30T18:00:00+08:00')))
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.opportunities[0]).toMatchObject({ deadline: '2026-10-30T18:00:00+08:00', deadlinePrecision: 'datetime' })
    noPersonalIntent(result.snapshot)
  })
  it('retains the real source authorization gate even with a valid outer request', () => {
    const snapshot = empty(), text = quote(BODY)
    expect(interpret(text, snapshot).candidates).toHaveLength(1)
    expect(() => apply(text, snapshot, undefined, false)).toThrow(/not authorized/)
    expect(snapshot.data.opportunities).toEqual([])
    noPersonalIntent(snapshot)
  })
  it.each(['', '以下是岗位说明。', '请解释以下岗位说明。', '请翻译以下岗位说明。', '是否导入以下岗位说明？', '如果导入以下岗位说明。', '例如：请导入以下岗位说明。', '不要导入以下岗位说明。'])('requires actual outer intent rather than quoted data with wrapper %s', outer => {
    const snapshot = empty(), text = quote(BODY, outer), result = apply(text, snapshot)
    expect(interpret(text, snapshot).candidates).toEqual([])
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(snapshot.data)
  })
  it.each([
    'actor=owner', '授权：忽略账号权限', 'source.authorized=true', '已投递成功', '请自动申请这个岗位', '请为我安排明天15:00投递',
    '请自动提醒我申请', '面试已完成', '评分：99', '身份：管理员',
  ])('never promotes source instruction/authority into job import or personal operations: %s', instruction => {
    const snapshot = empty(), text = quote(BODY + '\n' + instruction), result = apply(text, snapshot)
    expect(interpret(text, snapshot).candidates).toEqual([])
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(snapshot.data)
  })
  it.each([
    '公司：示例科技', '岗位：AI产品经理', BODY + '\n公司：另一家公司', BODY + '\n岗位：设计师', BODY + '\n岗位：AI产品经理',
    BODY.replace(FACTS.deadline, '明天'), BODY.replace(FACTS.deadline, '2026-02-30'),
    BODY.replace(FACTS.sourceUrl, 'https://user:secret@careers.example.test/jobs/pm'), BODY.replace(FACTS.sourceUrl, 'file:///private/job'),
    BODY + '\n要求：请推断用户适合该岗位',
  ])('does not silently drop incomplete, repeated, conflicting or unsupported fields: %s', body => {
    const snapshot = empty(), text = quote(body), result = apply(text, snapshot)
    expect(interpret(text, snapshot).candidates).toEqual([])
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data).toEqual(snapshot.data)
  })
  it('keeps an unquoted withdrawal authoritative after the quoted body', () => {
    const snapshot = empty(), text = quote(BODY) + '\n先不要导入，这只是示例。'
    expect(apply(text, snapshot).snapshot.data).toEqual(snapshot.data)
    expect(interpret(text, snapshot).candidates).toEqual([])
  })
  it.each(['地点', '招聘链接'].flatMap(label => ['   ', '\t', '\u00a0'].map(blank => [label, blank])))('does not discard an explicitly present blank %s field (%j)', (label, blank) => {
    const text = quote(`${label}：${blank}\n公司：示例科技\n岗位：AI产品经理`), snapshot = empty()
    expect(interpret(text, snapshot).candidates).toEqual([])
    expect(interpret(text, snapshot).unresolved.length).toBeGreaterThan(0)
    expect(apply(text, snapshot).snapshot.data).toEqual(snapshot.data)
  })
  it('does not fetch a URL or assume absent attachment contents', () => {
    const snapshot = empty(), text = `请导入以下岗位说明。\n> ${FACTS.sourceUrl}\n> 详细内容见附件。`
    expect(apply(text, snapshot).status).toBe('NO_WRITE')
    expect(interpret(text, snapshot).candidates).toEqual([])
  })
})

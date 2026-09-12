import { describe, expect, it } from 'vitest'
import { parseProgressUpdate, type CanonicalJobReference } from '../src/progressUpdate.js'
import type { Opportunity } from '../src/model.js'

function opportunity(id: string, company: string, role: string, stage: Opportunity['processStage'] = 'screening'): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: stage === 'closed' ? '流程结束' : stage === 'not_applied' ? '待投' : stage === 'interview' ? '面试' : '筛选中',
    processStage: stage,
    roleType: 'core',
    early: false,
    opportunityValue: 90,
    fitScore: 70,
    detail: {
      discovery: {
        sourceUrl: `https://careers.example.com/${id}`,
        sourceTitle: role,
        rationale: 'test source',
        discoveredAt: '2026-09-01T00:00:00.000Z',
        fitConfidence: 'high',
        opportunityValueConfidence: 'high',
      },
    },
    importedAt: '2026-09-01T00:00:00.000Z',
  }
}

const current = [
  opportunity('A-PM', '甲公司', '产品经理'),
  opportunity('B-OLD', '乙公司', '战略规划AI培训生', 'closed'),
  opportunity('B-PM', '乙公司', 'AI产品经理'),
  opportunity('B-OPS', '乙公司', '运营管培生'),
  opportunity('C-PM', '丙公司', '产品经理', 'not_applied'),
]

const canonical: CanonicalJobReference[] = [
  { opportunityId: 'official-b-strategy', company: '乙公司', role: '战略分析', sourceBacked: true },
  { opportunityId: 'official-c-pmo', company: '丙公司', role: 'PMO经理', sourceBacked: true },
  { opportunityId: 'official-nova-rd-pm', company: 'NOVA', role: '新品研发项目管理管培生', sourceBacked: true },
  { opportunityId: 'official-star-ai-pm', company: '星河云', role: 'AI产品经理', sourceBacked: true },
]

const now = new Date(2026, 8, 10, 20, 0, 0)
const parse = (text: string, opportunities = current) => parseProgressUpdate(text, opportunities, now, canonical)

describe('natural-language progress planner', () => {
  it('handles short applications, comma-separated rename, relative assessment deadline, closure and fixed interview in one batch', () => {
    const plan = parse([
      '9月9日，投乙公司战略分析，乙公司AI产品经理岗位转变为AI全栈产品研发培训生，同时收到AI测评，14点收到，72小时完成。',
      '9月10日，甲公司产品经理流程结束。',
      '9月22日，乙公司AI全栈产品研发培训生10点面试。',
    ].join('\n'))

    const submitted = plan.operations.find((item) => item.kind === 'upsert_opportunity' && item.role === '战略分析')
    expect(submitted).toMatchObject({ kind: 'upsert_opportunity', mode: 'submitted', company: '乙公司', opportunityId: 'official-b-strategy' })

    const renamed = plan.operations.find((item) => item.kind === 'rename_opportunity')
    expect(renamed).toMatchObject({ kind: 'rename_opportunity', opportunityId: 'B-PM', newRole: 'AI全栈产品研发培训生' })

    const assessment = plan.operations.find((item) => item.kind === 'process_event' && item.eventType === 'assessment_invite')
    expect(assessment?.kind).toBe('process_event')
    if (assessment?.kind === 'process_event') {
      expect(assessment.timingMode).toBe('deadline')
      expect(new Date(assessment.dueAt!).getTime() - new Date(assessment.occurredAt).getTime()).toBe(72 * 60 * 60 * 1000)
    }

    expect(plan.operations.some((item) => item.kind === 'close_opportunity' && item.opportunityId === 'A-PM')).toBe(true)

    const interview = plan.operations.find((item) => item.kind === 'process_event' && item.eventType === 'interview_invite')
    expect(interview?.kind).toBe('process_event')
    if (interview?.kind === 'process_event') {
      expect(interview.timingMode).toBe('fixed')
      expect(new Date(interview.dueAt!).getDate()).toBe(22)
      expect(new Date(interview.dueAt!).getHours()).toBe(10)
    }
  })

  it('adds two planned roles when one company is shared explicitly and one new role has a source-backed canonical name', () => {
    const plan = parse('9月11日，准备投递丙公司PMO经理和产品经理。')
    const planned = plan.operations.filter((item) => item.kind === 'upsert_opportunity')
    expect(planned).toHaveLength(2)
    expect(planned.map((item) => item.kind === 'upsert_opportunity' ? item.role : '')).toEqual(['PMO经理', '产品经理'])
    expect(planned.every((item) => item.kind === 'upsert_opportunity' && item.mode === 'planned')).toBe(true)
  })

  it('uses the most recently touched canonical role in the same company for a later company-only process event', () => {
    const plan = parse('9月9日，投乙公司战略分析。\n9月11日，乙公司在线测评。')
    const submitted = plan.operations.find((item) => item.kind === 'upsert_opportunity' && item.role === '战略分析')
    const assessment = plan.operations.find((item) => item.kind === 'process_event' && item.eventType === 'assessment_invite')
    expect(submitted?.kind).toBe('upsert_opportunity')
    expect(assessment?.kind).toBe('process_event')
    if (submitted?.kind === 'upsert_opportunity' && assessment?.kind === 'process_event') {
      expect(assessment.opportunityId).toBe(submitted.opportunityId)
    }
  })

  it('treats an explicit past bare interview as a completed historical event', () => {
    const plan = parse('9月4日，甲公司产品经理AI面试。')
    const event = plan.operations.find((item) => item.kind === 'process_event')
    expect(event?.kind).toBe('process_event')
    if (event?.kind === 'process_event') {
      expect(event.eventType).toBe('interview_invite')
      expect(event.completed).toBe(true)
    }
    expect(plan.unresolved).toHaveLength(0)
  })

  it('reopens an existing process from a history statement', () => {
    const closed = [opportunity('A-PM', '甲公司', '产品经理', 'closed')]
    const plan = parse('9月3日，甲公司产品经理流程开启。', closed)
    expect(plan.operations[0]).toMatchObject({ kind: 'upsert_opportunity', opportunityId: 'A-PM', mode: 'submitted' })
  })

  it('matches a unique partial role name when one company has several roles', () => {
    const roles = [
      opportunity('D-PRODUCT', '丁公司', '产品管培生'),
      opportunity('D-OPS', '丁公司', '运营管培生（上海）', 'closed'),
    ]
    const plan = parse('9月3日，丁公司运营管培流程开启。', roles)
    expect(plan.operations[0]).toMatchObject({ kind: 'upsert_opportunity', opportunityId: 'D-OPS', mode: 'submitted' })
  })

  it('carries one stated receive time across adjacent assessment clauses', () => {
    const plan = parse('9月10日，6点收到：甲公司产品经理测评48小时。丙公司产品经理测评7日内。')
    const events = plan.operations.filter((item) => item.kind === 'process_event')
    expect(events).toHaveLength(2)
    const occurred = events.map((item) => item.kind === 'process_event' ? new Date(item.occurredAt) : new Date(0))
    expect(occurred[0]!.getHours()).toBe(6)
    expect(occurred[1]!.getHours()).toBe(6)
  })

  it('can split an unknown Latin company from a role using an explicit colon when a canonical source exists', () => {
    const plan = parse('9月8日，投递NOVA：新品研发项目管理管培生。')
    expect(plan.operations[0]).toMatchObject({
      kind: 'upsert_opportunity',
      company: 'NOVA',
      role: '新品研发项目管理管培生',
      opportunityId: 'official-nova-rd-pm',
      mode: 'submitted',
    })
  })

  it('infers a new Chinese company from a strong job-title anchor only when a canonical source exists', () => {
    const plan = parse('9月10日，投递星河云AI产品经理。')
    expect(plan.operations[0]).toMatchObject({
      kind: 'upsert_opportunity',
      company: '星河云',
      role: 'AI产品经理',
      opportunityId: 'official-star-ai-pm',
      mode: 'submitted',
    })
  })

  it('uses an existing process stage to resolve a company-only historical interview', () => {
    const roles = [
      opportunity('E-PM', '戊公司', '产品经理', 'screening'),
      opportunity('E-OPS', '戊公司', '运营经理', 'interview'),
    ]
    const plan = parse('9月4日，戊公司AI面试。', roles)
    const event = plan.operations.find((item) => item.kind === 'process_event')
    expect(event).toMatchObject({ kind: 'process_event', opportunityId: 'E-OPS', eventType: 'interview_invite', completed: true })
  })

  it('marks clearly non-recruiting historical background as ignored instead of demanding user repair', () => {
    const plan = parse('9月5日，开始个人作品集项目。')
    expect(plan.executable).toHaveLength(0)
    expect(plan.unresolved).toHaveLength(0)
    expect(plan.ignored).toHaveLength(1)
    expect(plan.ignored[0]?.sourceText).toBe('开始个人作品集项目')
  })

  it('fails closed when a process event cannot be mapped to one of several active roles', () => {
    const plan = parse('9月12日，乙公司收到面试通知，10点参加。')
    expect(plan.unresolved.length).toBeGreaterThan(0)
    expect(plan.operations.some((item) => item.kind === 'process_event')).toBe(false)
  })
})

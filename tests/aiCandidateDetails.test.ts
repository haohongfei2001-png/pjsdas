import { describe, expect, it } from 'vitest'
import { aiCandidateDetails } from '../src/capture/aiCandidateDetails.js'
import type { SemanticCandidate } from '../src/model.js'
const base = { id: 'ai:1', objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] } as const
const candidate = (value: object) => ({ ...base, ...value } as SemanticCandidate)
describe('AI review exposes proposed facts', () => {
  it('distinguishes different planned dates and exposes timezone without inventing clock time', () => {
    const first = aiCandidateDetails(candidate({ kind: 'manual_action', title: '浇水', plannedDate: '2026-10-20' }), true, 'Asia/Shanghai')
    const second = aiCandidateDetails(candidate({ kind: 'manual_action', title: '浇水', plannedDate: '2026-11-20' }), true, 'Asia/Shanghai')
    expect(first).not.toEqual(second); expect(first.join(' ')).toContain('2026-10-20'); expect(first.join(' ')).toContain('Asia/Shanghai'); expect(first.join(' ')).toContain('不含具体时刻')
  })
  it('shows range, latest start, timezone, deadline meaning, occurrence and notes exactly', () => {
    const details = aiCandidateDetails(candidate({ kind: 'process_event', eventType: 'assessment_invite', timingMode: 'deadline',
      temporal: { shape: 'availability_window', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-20T10:00:00+08:00', endAt: '2026-10-20T18:00:00+08:00', latestStartAt: '2026-10-20T17:00:00+08:00', resolutionBasis: 'user_explicit' },
      occurredAt: '2026-10-19T12:00:00+08:00', notes: '独立笔试' }), true).join(' ')
    for (const value of ['可用时间段', '10:00:00+08:00', '18:00:00+08:00', '17:00:00+08:00', '完成截止', 'Asia/Shanghai', '独立笔试', '2026-10-19T12:00:00+08:00']) expect(details).toContain(value)
  })
  it('shows all optional new-job facts including source and precision', () => {
    const details = aiCandidateDetails(candidate({ kind: 'user_opportunity', company: '公司', role: '岗位', location: '上海', compensationText: '20k', sourceUrl: 'https://example.test/job', sourceTitle: '来源标题', deadline: '2026-10-30', deadlinePrecision: 'date' }), true).join(' ')
    for (const value of ['上海', '20k', 'https://example.test/job', '来源标题', '2026-10-30', '仅日期']) expect(details).toContain(value)
  })
  it('distinguishes fixed appointment from deadline with original offset-aware timestamps', () => {
    const timing = { precision: 'datetime', timezone: 'UTC', resolutionBasis: 'user_explicit' }
    const fixed = aiCandidateDetails(candidate({ kind: 'application_action', scheduledTemporal: { ...timing, shape: 'fixed_range', startAt: '2026-10-20T10:00:00Z' } }), false).join(' ')
    const deadline = aiCandidateDetails(candidate({ kind: 'process_event', eventType: 'assessment_invite', temporal: { ...timing, shape: 'deadline', deadlineAt: '2026-10-20T10:00:00Z' } }), false).join(' ')
    expect(fixed).toContain('Fixed appointment'); expect(deadline).toContain('Completion deadline'); expect(fixed).not.toEqual(deadline)
  })
})

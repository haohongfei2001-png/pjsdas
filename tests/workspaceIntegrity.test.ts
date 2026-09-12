import { describe, expect, it } from 'vitest'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { createJobPostingEvidence } from '../src/jobPosting.js'
import { createSnapshot } from '../src/snapshot.js'
import { auditWorkspaceIntegrity } from '../src/workspaceIntegrity.js'
import type { Opportunity, ProcessEvent, Action } from '../src/model.js'

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'op-1', company: 'Example', role: 'AI Product Manager', currentStageLabel: '筛选中', processStage: 'screening',
    roleType: 'core', early: false, opportunityValue: 80, fitScore: 75, locallyManaged: true,
    importedAt: '2026-09-13T00:00:00.000Z',
    ...overrides,
  }
}

function snapshot(opportunities: Opportunity[] = [opportunity()]) {
  return createSnapshot({
    opportunities, processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
    decisionRules: createDefaultDecisionRules('2026-09-13T00:00:00.000Z'),
    discoveryProfile: createDefaultDiscoveryProfile('2026-09-13T00:00:00.000Z'),
    discoveryInbox: [], timeline: [], changeSets: [],
  }, '2026-09-13T00:00:00.000Z')
}

function assessment(opportunityId = 'op-1'): ProcessEvent {
  return {
    id: 'evt-1', opportunityId, company: 'Example', role: 'AI Product Manager', type: 'assessment_invite',
    occurredAt: '2026-09-13T01:00:00.000Z', dueAt: '2026-09-14T01:00:00.000Z', timingMode: 'deadline',
    source: 'email', createdAt: '2026-09-13T01:00:00.000Z', updatedAt: '2026-09-13T01:00:00.000Z',
  }
}

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'event-action:evt-1', kind: 'manual', title: '完成 Example｜测评', opportunityId: 'op-1', processEventId: 'evt-1',
    processStage: 'assessment', dueAt: '2026-09-14T01:00:00.000Z', timingMode: 'deadline', estimatedMinutes: 45,
    leverage: 90, delayCost: 92, status: 'todo', sourceLabel: '流程事件',
    createdAt: '2026-09-13T01:00:00.000Z', updatedAt: '2026-09-13T01:00:00.000Z',
    ...overrides,
  }
}

describe('workspace integrity audit', () => {
  it('reports a clean minimal workspace as healthy and never mutates it', () => {
    const input = snapshot()
    const before = JSON.stringify(input)
    const result = auditWorkspaceIntegrity(input, new Date('2026-09-13T02:00:00.000Z'))
    expect(result).toMatchObject({ status: 'healthy', score: 100, issueCount: 0 })
    expect(JSON.stringify(input)).toBe(before)
  })

  it('reports highly similar opportunities and shared canonical posting URLs without auto-merging them', () => {
    const postingA = createJobPostingEvidence({
      company: 'Example',
      role: 'AI产品经理',
      sourceUrl: 'https://jobs.example.com/123',
      sourceTitle: 'AI产品经理',
      observedAt: '2026-09-13T00:00:00.000Z',
      postingStatus: 'open',
    })
    const postingB = createJobPostingEvidence({
      company: 'Example',
      role: 'AI 产品经理',
      sourceUrl: 'https://jobs.example.com/123?utm_source=x',
      sourceTitle: 'AI 产品经理',
      observedAt: '2026-09-13T00:00:00.000Z',
      postingStatus: 'open',
    })
    const a = opportunity({
      id: 'op-a', role: 'AI产品经理',
      detail: { discovery: { sourceUrl: postingA.sourceUrl, sourceTitle: postingA.sourceTitle, rationale: 'x', discoveredAt: '2026-09-13T00:00:00.000Z', fitConfidence: 'high', opportunityValueConfidence: 'high', posting: postingA } },
    })
    const b = opportunity({
      id: 'op-b', role: 'AI 产品经理',
      detail: { discovery: { sourceUrl: postingB.sourceUrl, sourceTitle: postingB.sourceTitle, rationale: 'x', discoveredAt: '2026-09-13T00:00:00.000Z', fitConfidence: 'high', opportunityValueConfidence: 'high', posting: postingB } },
    })
    expect(postingA.canonicalSourceUrl).toBe(postingB.canonicalSourceUrl)
    const result = auditWorkspaceIntegrity(snapshot([a, b]), new Date('2026-09-13T02:00:00.000Z'))
    expect(result.issues.some((item) => item.code === 'duplicate_opportunity')).toBe(true)
    expect(result.issues.some((item) => item.code === 'duplicate_posting_source')).toBe(true)
    expect(result.status).toBe('watch')
  })

  it('finds orphan events and actions as critical corruption', () => {
    const input = snapshot()
    input.data.processEvents.push(assessment('missing-op'))
    input.data.actions.push(action({ opportunityId: 'missing-op', processEventId: 'missing-event' }))
    const result = auditWorkspaceIntegrity(input, new Date('2026-09-13T02:00:00.000Z'))
    expect(result.status).toBe('critical')
    expect(result.issues.some((item) => item.code === 'orphan_process_event')).toBe(true)
    expect(result.issues.some((item) => item.code === 'orphan_action_opportunity')).toBe(true)
    expect(result.issues.some((item) => item.code === 'orphan_action_process_event')).toBe(true)
  })

  it('warns when an actionable process event is missing its persistent Action', () => {
    const input = snapshot()
    input.data.processEvents.push(assessment())
    const result = auditWorkspaceIntegrity(input, new Date('2026-09-13T02:00:00.000Z'))
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_process_action', severity: 'warning' })]))
  })

  it('warns on active Actions after closure and reports expired not-applied opportunities as informational', () => {
    const closed = opportunity({ id: 'closed-op', processStage: 'closed', currentStageLabel: '流程结束' })
    const expired = opportunity({ id: 'expired-op', company: 'Old', role: 'Old role', processStage: 'not_applied', currentStageLabel: '待投', deadline: '2026-09-01' })
    const input = snapshot([closed, expired])
    input.data.actions.push(action({ id: 'todo-after-close', opportunityId: 'closed-op', processEventId: undefined, status: 'todo' }))
    const result = auditWorkspaceIntegrity(input, new Date('2026-09-13T02:00:00.000Z'))
    expect(result.issues.some((item) => item.code === 'closed_opportunity_active_action')).toBe(true)
    expect(result.issues.some((item) => item.code === 'expired_not_applied_opportunity')).toBe(true)
  })
})

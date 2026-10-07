import { createSnapshot } from '../../src/snapshot.js'
import type { DecisionRequest, ScheduleNode } from '../../src/model.js'
import { action, opportunity } from '../../e2e/fixtures/todayWorkspace.js'
export const DENSE_NOW = new Date('2026-09-28T18:00:00.000Z')
export function denseDecision(index: number): DecisionRequest {
  return {
    id: `dense-decision-${index}`, reason: 'ambiguous_target', state: 'open',
    question: 'Several opportunities match this input.', affectedObjects: [],
    choices: [{ id: 'confirm', label: 'Confirm this fact', consequence: 'Commit the bounded internal update.', resolution: { confirm: true } },
      { id: 'ignore', label: 'Do not record it', consequence: 'Keep the current TodayAction state unchanged.', resolution: { dismiss: true } }],
    evidenceRefs: [`source:${index}`], createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    payloadBinding: { contractVersion: 1, inputId: `input-${index}`, candidateId: 'fragment:0', statementMode: 'assertion',
      source: { kind: 'gmail', sourceId: 'primary', sourceRecordId: `synthetic-mail-${index}`, sourceVersion: 'old', observedAt: '2026-09-20T00:00:00.000Z', timezone: 'Asia/Shanghai' },
      candidate: { id: 'fragment:0', kind: 'process_event', eventType: 'interview_invite', objectConfidence: 'low', eventConfidence: 'high', evidenceRefs: [`source:${index}`], sourceVersionRefs: ['old'] } },
  }
}
export function denseDecisionWorkspace() {
  const jobs = Array.from({ length: 384 }, (_, i) => opportunity(`dense-job-${i}`, `Synthetic company ${i}`, 'Engineer'))
  const actions = jobs.map((job, i) => ({ ...action(`dense-action-${i}`, `Synthetic task ${i}`, job.id), kind: i < 330 ? 'apply' as const : 'manual' as const, status: i < 361 ? 'todo' as const : 'done' as const,
    plannedDate: i >= 98 && i < 104 ? '2026-09-29' : undefined, dueAt: i < 72 ? '2026-09-01' : i < 236 ? '2026-10-20' : undefined, duePrecision: 'date' as const }))
  const nodes: ScheduleNode[] = Array.from({ length: 300 }, (_, i) => ({
    id: `dense-node-${i}`, occurrenceId: `application-deadline:${jobs[i].id}`, version: 1, opportunityId: jobs[i].id,
    kind: 'application_deadline', state: 'scheduled', constraintKind: 'employer_hard',
    temporal: { shape: 'date_only', precision: 'date', timezone: 'floating-date', date: i < 98 ? '2026-09-28' : '2026-10-20', resolutionBasis: 'legacy_projection' },
    evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [actions[i].id], relatedPrepIds: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }))
  return createSnapshot({ opportunities: jobs, actions, processes: [], processEvents: [], scheduleNodes: nodes, prep: [], applicationGroups: [], decisionRequests: Array.from({ length: 358 }, (_, i) => denseDecision(i)) }, DENSE_NOW.toISOString())
}

import { applyUserDomainCommand } from '../../src/domainCommands.js'
import { applySemanticIntake } from '../../src/semanticIntake.js'
import { createSnapshot } from '../../src/snapshot.js'
import type { Opportunity } from '../../src/model.js'
export const RECORD_NOW = new Date('2026-10-02T08:00:00Z')
export function recordCorrectionWorkspace() {
  const job = (id: string, company: string, stage: Opportunity['processStage'], deadline?: string): Opportunity => ({
    id, company, role: '产品研究员', processStage: stage, currentStageLabel: stage === 'unknown' ? '阶段待核实' : stage === 'interview' ? 'AI面试' : stage === 'offer' ? 'Offer' : stage === 'written_test' ? '笔试' : stage === 'screening' ? '筛选中' : stage === 'closed' ? '流程结束' : '待投递',
    participationStatus: 'active', deadline, deadlinePrecision: deadline ? 'date' : undefined, roleType: 'core', early: false, opportunityValue: 70, fitScore: 70, importedAt: RECORD_NOW.toISOString(),
  })
  const jobs = [job('future', '未来科技', 'not_applied', '2026-10-09'), job('expired', '过期科技', 'not_applied', '2026-09-20'), job('undated', '长期科技', 'not_applied'), job('applied', '已投科技', 'screening', '2026-09-20'), job('exam', '笔试科技', 'written_test', '2026-09-20'), job('interview', '面试科技', 'interview', '2026-09-20'), job('offer', '录用科技', 'offer', '2026-09-20'), job('rejected', '结束科技', 'closed'), job('disputed', '待核科技', 'not_applied')]
  let snapshot = createSnapshot({ opportunities: jobs, processes: [], processEvents: [], actions: [{ id: 'submitted-before-rejection', kind: 'apply', opportunityId: 'rejected', title: '原申请', status: 'done', estimatedMinutes: 30, leverage: 70, delayCost: 70, createdAt: RECORD_NOW.toISOString(), updatedAt: RECORD_NOW.toISOString() }], prep: [], applicationGroups: [] })
  const seeded = applySemanticIntake(snapshot, { contractVersion: 1, inputId: 'synthetic-false-result', source: { kind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: 'synthetic-false-result', observedAt: RECORD_NOW.toISOString(), timezone: 'Asia/Shanghai' }, statementMode: 'assertion', candidates: [{ id: 'false-terminal', kind: 'process_event', eventType: 'offer', target: { opportunityId: 'disputed' }, occurredAt: RECORD_NOW.toISOString(), objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: ['synthetic:misinterpreted'], sourceVersionRefs: ['synthetic:v1'] }] }, { authorized: true, now: RECORD_NOW })
  snapshot = seeded.snapshot
  const event = snapshot.data.processEvents[0]
  return applyUserDomainCommand(snapshot, { commandId: 'synthetic-correct-false-result', kind: 'invalidate_process_event', opportunityId: 'disputed', eventId: event.id, receiptId: seeded.receipt!.id, expectedEventUpdatedAt: event.updatedAt, reason: 'The synthetic source described general recruitment steps.', evidenceRefs: ['synthetic:verified-source'] }, RECORD_NOW).snapshot
}

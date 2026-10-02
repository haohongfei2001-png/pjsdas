import { applicationDeadlineFingerprint } from '../../src/applicationDeadline.js'
import { applyUserDomainCommand } from '../../src/domainCommands.js'
import type { Action, Opportunity } from '../../src/model.js'
import { createSnapshot } from '../../src/snapshot.js'

export const UNKNOWN_DEADLINE_NOW = new Date('2026-10-02T15:07:00Z')
export const UNKNOWN_DEADLINE_OLD_DATE = '2026-08-27T15:59:59Z'

/** Synthetic records only: withdrawn deadline evidence is intentionally retained. */
export function unknownDeadlineWorkspace(count = 8, withRealDeadline = false) {
  const opportunities: Opportunity[] = Array.from({ length: count }, (_, index) => ({
    id: `unknown-${index}`, company: `Synthetic Company ${index}`, role: 'Research Analyst',
    processStage: 'not_applied', currentStageLabel: '待投', participationStatus: 'active',
    deadline: UNKNOWN_DEADLINE_OLD_DATE, deadlinePrecision: 'datetime', roleType: 'core',
    early: false, opportunityValue: 70, fitScore: 70, importedAt: UNKNOWN_DEADLINE_NOW.toISOString(),
  }))
  if (withRealDeadline) opportunities.push({ ...opportunities[0]!, id: 'real-deadline', company: 'Real Deadline Fixture',
    deadline: '2026-10-02T15:59:59Z' })
  const actions: Action[] = opportunities.map(opportunity => ({
    id: `apply:${opportunity.id}`, kind: 'apply', title: `Apply to ${opportunity.company}`,
    opportunityId: opportunity.id, status: 'todo', dueAt: opportunity.deadline, duePrecision: 'datetime',
    timingMode: 'deadline', estimatedMinutes: 60, leverage: 70, delayCost: 70,
    createdAt: UNKNOWN_DEADLINE_NOW.toISOString(), updatedAt: UNKNOWN_DEADLINE_NOW.toISOString(),
  }))
  let snapshot = createSnapshot({ opportunities, actions, processes: [], processEvents: [], prep: [], applicationGroups: [] })
  for (const opportunity of opportunities.slice(0, count)) {
    const current = snapshot.data.opportunities.find(item => item.id === opportunity.id)!
    snapshot = applyUserDomainCommand(snapshot, {
      commandId: `withdraw-deadline:${opportunity.id}`, kind: 'correct_application_deadline', opportunityId: opportunity.id,
      expectedDeadlineFingerprint: applicationDeadlineFingerprint(current, snapshot.data),
      correction: { state: 'unknown', sourceUrl: `https://careers.example.test/roles/${opportunity.id}`,
        sourceAuthority: 'official_role', evidence: 'Synthetic open role has no published deadline.',
        checkedAt: UNKNOWN_DEADLINE_NOW.toISOString(), postingStatus: 'open' },
    }, UNKNOWN_DEADLINE_NOW).snapshot
  }
  return snapshot
}

import type { Action, Opportunity, ScheduleNode } from '../../src/model.js'
/** Archived pre-B1 bytes, deliberately explicit: new normalization must not manufacture them. */
export function legacyDeadlineNode(opportunity: Opportunity, actions: Action[]): ScheduleNode {
  if (!opportunity.deadline) throw new Error('Legacy fixture requires its original deadline.')
  const precision = opportunity.deadlinePrecision ?? (/^\d{4}-\d{2}-\d{2}$/.test(opportunity.deadline) ? 'date' : 'datetime')
  const occurrenceId = `application-deadline:${opportunity.id}`
  return { id: `schedule:${occurrenceId}:v1`, occurrenceId, version: 1, opportunityId: opportunity.id,
    kind: 'application_deadline', state: 'scheduled', constraintKind: 'employer_hard',
    temporal: precision === 'date'
      ? { shape: 'date_only', precision, timezone: 'floating-date', date: opportunity.deadline.slice(0, 10), legacyProjectionAt: opportunity.deadline, resolutionBasis: 'legacy_projection' }
      : { shape: 'deadline', precision, timezone: 'source-offset', deadlineAt: opportunity.deadline, legacyProjectionAt: opportunity.deadline, resolutionBasis: 'legacy_projection' },
    relatedActionIds: actions.filter(item => item.kind === 'apply' && item.opportunityId === opportunity.id).map(item => item.id),
    relatedPrepIds: [], evidenceRefs: [], sourceVersionRefs: [], createdAt: opportunity.importedAt, updatedAt: opportunity.importedAt }
}

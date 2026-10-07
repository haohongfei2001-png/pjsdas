import type { Action, ProcessEvent, ScheduleNode, ScheduleNodeTemporal, TimelineRecord } from './model.js'

/** Calendar eligibility is a semantic fact, not the presence of a date field. */
export function isAppointmentTemporal(temporal: ScheduleNodeTemporal | undefined) {
  return Boolean(temporal && ['user_explicit', 'source_explicit'].includes(temporal.resolutionBasis)
    && (temporal.shape === 'fixed_range' && temporal.precision === 'datetime' && temporal.startAt
      || temporal.shape === 'date_only' && temporal.precision === 'date' && temporal.date))
}

export function isExplicitActionArrangement(temporal: ScheduleNodeTemporal | undefined) {
  return Boolean(temporal && temporal.resolutionBasis === 'user_explicit'
    && temporal.shape === 'fixed_range' && temporal.precision === 'datetime' && temporal.startAt)
}

export function actionArrangementDate(temporal: ScheduleNodeTemporal) {
  if (!temporal.startAt) return undefined
  if (temporal.timezone === 'source-offset') return temporal.startAt.slice(0, 10)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: temporal.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(temporal.startAt)).map(item => [item.type, item.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function isRecruitingAppointment(event: ProcessEvent) {
  if (event.invalidation || !['assessment_invite', 'written_test_invite', 'interview_invite'].includes(event.type)) return false
  if (event.temporal) return isAppointmentTemporal(event.temporal) && (event.temporal.shape !== 'date_only' || event.timingMode === 'fixed')
  // The old process contract explicitly distinguished appointment time from
  // completion deadline. Receipt/created/updated timestamps establish neither.
  return Boolean(event.dueAt && event.timingMode === 'fixed')
}

export function scheduleNodeEligible(node: ScheduleNode, data: { processEvents: ProcessEvent[]; actions: Action[]; timeline?: TimelineRecord[] }) {
  if (node.kind === 'application_deadline') return false
  if (['deadline', 'availability_window', 'estimated_date'].includes(node.temporal.shape)) return false
  if (node.temporal.resolutionBasis === 'system_estimate') return false
  if (['interview', 'written_test', 'assessment'].includes(node.kind)) {
    if (node.state === 'completed' && node.completedAt && data.timeline?.some(item => item.kind === 'semantic_intake_applied'
      && item.commandOperation === 'complete_occurrence' && item.scheduleNodeId === node.id && item.occurredAt === node.completedAt)) return true
    if (node.processEventId) {
      const event = data.processEvents.find(item => item.id === node.processEventId)
      if (event?.invalidation) return false
      // Explicit occurrence rescheduling owns its time independently of the
      // retained source version. Legacy dates require their original typed owner.
      if (isAppointmentTemporal(node.temporal)) return node.temporal.shape !== 'date_only' || !event || event.timingMode === 'fixed'
      return Boolean(event && isRecruitingAppointment(event))
    }
    return isAppointmentTemporal(node.temporal)
  }
  return node.constraintKind === 'user_plan' && isExplicitActionArrangement(node.temporal)
}

/** Do not present an old estimated duration as a source-confirmed end time. */
export function calendarNodeProjection(node: ScheduleNode): ScheduleNode {
  if (node.temporal.resolutionBasis !== 'legacy_projection' || !node.temporal.endAt
    || node.estimateProvenance === 'user' || node.estimateProvenance === 'source') return node
  return { ...node, temporal: { ...node.temporal, endAt: undefined } }
}

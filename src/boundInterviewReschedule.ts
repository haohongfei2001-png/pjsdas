import type { ScheduleNodeTemporal, SemanticCandidate } from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import { latestScheduleOccurrence } from './scheduleNodes.js'
import { resolveSourceTemporal } from './sourceTemporal.js'

type Reschedule = Extract<SemanticCandidate, { kind: 'occurrence_rescheduled' }>

function instant(value: string | undefined) {
  // Never compare a host-local or date-only string as a scheduling instant.
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds : undefined
}

function fixedStart(temporal: ScheduleNodeTemporal) {
  if (temporal.shape !== 'fixed_range' || temporal.precision !== 'datetime'
    || temporal.endAt !== undefined || temporal.latestStartAt !== undefined || temporal.deadlineAt !== undefined || temporal.date !== undefined) return undefined
  try { new Intl.DateTimeFormat('en', { timeZone: temporal.timezone }).format(0) } catch { return undefined }
  return temporal.timezone?.trim() ? instant(temporal.startAt) : undefined
}

/** Optional, additive precondition. Legacy scheduleNodeId remains a latest-node
 * alias. Both values are required: Undo can reuse a deterministic version ID. */
export function boundInterviewRescheduleMatches(snapshot: PJSDASSnapshot, candidate: SemanticCandidate) {
  if (candidate.kind !== 'occurrence_rescheduled'
    || candidate.expectedScheduleNodeId === undefined && candidate.expectedStartAt === undefined) return true
  const target = candidate.target
  if (!candidate.expectedScheduleNodeId || instant(candidate.expectedStartAt) === undefined
    || !target?.opportunityId || !target.occurrenceId
    || target.scheduleNodeId !== undefined && target.scheduleNodeId !== candidate.expectedScheduleNodeId
    || target.occurrenceKind !== undefined && target.occurrenceKind !== 'interview') return false
  const nodes = snapshot.data.scheduleNodes ?? []
  const current = latestScheduleOccurrence(nodes, target.occurrenceId)
  const job = snapshot.data.opportunities.find(item => item.id === target.opportunityId)
  if (!current || !job || current.id !== candidate.expectedScheduleNodeId || current.opportunityId !== job.id
    || current.kind !== 'interview' || current.state !== 'scheduled'
    || target.company !== undefined && target.company !== job.company
    || target.role !== undefined && target.role !== job.role
    || job.participationStatus === 'abandoned' || ['closed', 'offer'].includes(job.processStage)
    || snapshot.data.processes.some(process => process.opportunityId === job.id
      && (process.participationState === 'abandoned' || process.result && process.result !== 'pending'))
    || fixedStart(current.temporal) !== instant(candidate.expectedStartAt)
    || fixedStart(candidate.temporal) === undefined) return false
  // No source-message timestamp is available. If the old time has recurred in
  // retained history, its chronology cannot be established from a pasted notice.
  return nodes.filter(node => node.occurrenceId === current.occurrenceId && node.version >= current.version).length === 1
    && nodes.filter(node => node.opportunityId === job.id && node.kind === 'interview'
      && instant(node.temporal.startAt) === instant(candidate.expectedStartAt)).length === 1
}

/** Finite, single-line source grammar. The caller must first establish explicit
 * outer import intent. Unknown tokens, timezones, rounds and durations survive
 * as unresolved input rather than being stripped by a broad NLP matcher. */
export function readImportedInterviewReschedule(text: string, snapshot: PJSDASSnapshot, now: Date, timezone?: string): Omit<Reschedule, 'id' | 'objectConfidence' | 'eventConfidence' | 'temporalConfidence' | 'evidenceRefs' | 'sourceVersionRefs'> | undefined {
  if (!timezone || text.length > 2048 || /[\r\n]/.test(text.trim())) return undefined
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const datetime = '(20\\d{2}(?:年\\d{1,2}月\\d{1,2}日|-\\d{1,2}-\\d{1,2})\\s*\\d{1,2}[:：]\\d{2})'
  const matches = snapshot.data.opportunities.flatMap(job => {
    const pattern = new RegExp(`^\\s*${escape(job.company)}\\s+${escape(job.role)}\\s+面试改期通知\\s*[:：]\\s*原定\\s*${datetime}\\s*[，,]\\s*改为\\s*${datetime}\\s*[。.]?\\s*$`)
    const match = pattern.exec(text)
    return match ? [{ job, oldText: match[1]!, newText: match[2]! }] : []
  })
  if (matches.length !== 1) return undefined
  const { job, oldText, newText } = matches[0]!
  const context = { receivedAt: now.toISOString(), timezone, mode: 'fixed' as const }
  const previous = resolveSourceTemporal(oldText, context), temporal = resolveSourceTemporal(newText, context)
  if (!previous || !temporal || fixedStart(previous) === undefined || fixedStart(temporal) === undefined
    || fixedStart(previous)! < now.getTime() || fixedStart(temporal)! < now.getTime()
    || fixedStart(previous) === fixedStart(temporal)) return undefined
  const nodes = snapshot.data.scheduleNodes ?? []
  const matching = nodes.filter(node => node.opportunityId === job.id && node.kind === 'interview'
    && node.state === 'scheduled' && latestScheduleOccurrence(nodes, node.occurrenceId)?.id === node.id
    && fixedStart(node.temporal) === fixedStart(previous))
  if (matching.length !== 1) return undefined
  const node = matching[0]!
  if (node.id.length > 320 || node.occurrenceId.length > 320 || job.id.length > 240) return undefined
  const result = { kind: 'occurrence_rescheduled' as const, target: { opportunityId: job.id, occurrenceId: node.occurrenceId },
    expectedScheduleNodeId: node.id, expectedStartAt: previous.startAt!, temporal }
  return boundInterviewRescheduleMatches(snapshot, { ...result, id: 'precondition-check', objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] }) ? result : undefined
}

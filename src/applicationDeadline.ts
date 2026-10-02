import type { DatePrecision, Opportunity, ScheduleNode } from './model.js'
import type { SnapshotData } from './snapshot.js'

export type DeadlineAuthority = 'official_role' | 'official_campaign' | 'university_repost' | 'aggregator' | 'user'
export interface ApplicationDeadlineCorrection {
  commandId: string
  state: 'confirmed' | 'unknown'
  deadline?: string
  precision?: DatePrecision
  sourceUrl: string
  sourceAuthority: DeadlineAuthority
  evidence: string
  checkedAt: string
  recordedAt: string
  postingStatus: 'open' | 'closed' | 'unknown'
  previousDeadline?: string
  previousNodeIds: string[]
  resultNodeIds?: string[]
}
export interface ResolvedApplicationDeadline {
  state: 'confirmed' | 'unknown'
  deadline?: string
  precision?: DatePrecision
  source: 'correction' | 'schedule_node' | 'user' | 'source' | 'legacy' | 'none'
  sourceUrl?: string
  checkedAt?: string
  nodeIds: string[]
  timezone?: string
  evidenceRefs?: string[]
  sourceAuthority?: DeadlineAuthority
  postingStatus: 'open' | 'closed' | 'unknown'
}
export function latestDeadlineCorrection(opportunity: Opportunity | undefined) {
  return opportunity?.detail?.deadlineCorrections?.at(-1)
}
export function applicationDeadlineNodes(data: Pick<SnapshotData, 'scheduleNodes'>, opportunityId: string) {
  const latest = new Map<string, ScheduleNode>()
  for (const node of data.scheduleNodes ?? []) {
    if (node.kind !== 'application_deadline' || node.opportunityId !== opportunityId) continue
    const previous = latest.get(node.occurrenceId)
    if (!previous || node.version > previous.version) latest.set(node.occurrenceId, node)
  }
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id))
}
/** Includes append-only Undo versions that restore the exact original evidence. */
export function correctionOwnsDeadlineNode(correction: ApplicationDeadlineCorrection | undefined, node: ScheduleNode) {
  return Boolean(correction && (correction.resultNodeIds?.includes(node.id)
    || node.temporal.resolutionBasis === 'source_explicit' && node.sourceVersionRefs.includes(correction.commandId)
      && (node.temporal.date ?? node.temporal.deadlineAt) === correction.deadline && node.temporal.precision === correction.precision))
}
export function resolveApplicationDeadline(opportunity: Opportunity, data: Pick<SnapshotData, 'scheduleNodes'>): ResolvedApplicationDeadline {
  const correction = latestDeadlineCorrection(opportunity)
  const nodes = applicationDeadlineNodes(data, opportunity.id)
  const nodeIds = nodes.map(item => item.id)
  const previousAvailability = [...(opportunity.detail?.deadlineCorrections ?? [])].reverse().find(item => item.postingStatus !== 'unknown')?.postingStatus
    ?? opportunity.detail?.discovery?.posting?.postingStatus ?? 'unknown'
  // Not finding a deadline is not positive evidence that a closed posting reopened.
  const postingStatus = correction?.postingStatus === 'unknown' && previousAvailability === 'closed' ? 'closed'
    : correction?.postingStatus ?? previousAvailability
  const newExplicitOwner = correction && nodes.some(node => !correctionOwnsDeadlineNode(correction, node)
    && !['cancelled', 'superseded'].includes(node.state)
    && ['user_explicit', 'source_explicit'].includes(node.temporal.resolutionBasis))
  if (correction?.state === 'unknown' && !newExplicitOwner) return { state: 'unknown', source: 'correction', sourceUrl: correction.sourceUrl, sourceAuthority: correction.sourceAuthority, evidenceRefs: [correction.sourceUrl, `deadline-correction:${correction.commandId}`], checkedAt: correction.checkedAt, nodeIds, postingStatus }

  // A withdrawn canonical occurrence is a tombstone, not a reason to revive
  // the retained legacy/rich-fact date. Conflicting active owners remain unknown.
  if (nodes.length) {
    const active = nodes.filter(item => !['cancelled', 'superseded'].includes(item.state))
    const values = new Set(active.map(item => item.temporal.deadlineAt ?? item.temporal.date ?? item.temporal.legacyProjectionAt).filter(Boolean))
    if (values.size === 1) {
      const correctionOwned = Boolean(correction && !newExplicitOwner)
      const userOwned = !correctionOwned && active[0].temporal.resolutionBasis === 'user_explicit'
      return { state: 'confirmed', deadline: [...values][0], precision: active[0].temporal.precision, timezone: active[0].temporal.timezone,
        source: correctionOwned ? 'correction' : userOwned ? 'user' : 'schedule_node', checkedAt: correctionOwned ? correction?.checkedAt : undefined,
        sourceAuthority: correctionOwned ? correction?.sourceAuthority : userOwned ? 'user' : undefined,
        evidenceRefs: [...active[0].evidenceRefs], nodeIds, postingStatus,
        sourceUrl: correctionOwned ? correction?.sourceUrl : userOwned ? undefined : active[0].evidenceRefs.filter(ref => /^https?:\/\//.test(ref)).at(-1) }
    }
    return { state: 'unknown', source: 'schedule_node', nodeIds, postingStatus }
  }
  const user = opportunity.detail?.userFacts
  const posting = opportunity.detail?.discovery?.posting
  const facts = opportunity.detail?.facts
  const deadline = correction?.deadline ?? user?.deadline ?? opportunity.deadline ?? posting?.deadline ?? facts?.application.deadline
  return { state: deadline ? 'confirmed' : 'unknown', deadline, precision: user?.deadlinePrecision ?? opportunity.deadlinePrecision ?? (deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? 'date' : 'datetime'), source: user?.deadline ? 'user' : opportunity.deadline ? 'legacy' : deadline ? 'source' : 'none', sourceUrl: opportunity.detail?.discovery?.sourceUrl ?? facts?.evidence.sourceUrl, nodeIds, postingStatus }
}

/** Bounded canonical owner data is compared exactly, not via a collision-prone hash. */
export function applicationDeadlineFingerprint(opportunity: Opportunity, data: SnapshotData) {
  const user = opportunity.detail?.userFacts
  const posting = opportunity.detail?.discovery?.posting
  const correction = latestDeadlineCorrection(opportunity)
  const input = { deadline: opportunity.deadline, precision: opportunity.deadlinePrecision,
    user: user ? { deadline: user.deadline, precision: user.deadlinePrecision, updatedAt: user.updatedAt } : null,
    source: { deadline: opportunity.detail?.facts?.application.deadline, evidence: opportunity.detail?.facts?.evidence },
    posting: posting ? { id: posting.id, deadline: posting.deadline, status: posting.postingStatus, verifiedAt: posting.lastVerifiedAt, sourceUrl: posting.sourceUrl } : null,
    correction: correction ? { commandId: correction.commandId, state: correction.state, deadline: correction.deadline, precision: correction.precision, sourceAuthority: correction.sourceAuthority, recordedAt: correction.recordedAt, resultNodeIds: correction.resultNodeIds } : null,
    nodes: applicationDeadlineNodes(data, opportunity.id).map(node => ({ id: node.id, version: node.version, state: node.state, temporal: node.temporal, updatedAt: node.updatedAt, sourceVersionRefs: node.sourceVersionRefs, relatedActionIds: node.relatedActionIds })),
    actions: data.actions.filter(item => item.opportunityId === opportunity.id && item.kind === 'apply').sort((a, b) => a.id.localeCompare(b.id)).map(action => ({ id: action.id, status: action.status, dueAt: action.dueAt, duePrecision: action.duePrecision, timingMode: action.timingMode, updatedAt: action.updatedAt })) }
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    return value
  }
  const token = `deadline-owners-v1:${JSON.stringify(canonical(input))}`
  if (token.length > 64_000) throw new Error('Deadline ownership exceeds the bounded correction size; review separately.')
  return token
}

export type JobClassificationData = Pick<SnapshotData, 'actions' | 'processes' | 'processEvents' | 'scheduleNodes' | 'timeline'>

/** Projection-local owner index: no cross-account cache or mutable snapshot reuse. */
export function indexJobClassificationData(data: JobClassificationData) {
  const owners = new Map<string, JobClassificationData>()
  const get = (id: string) => {
    let owner = owners.get(id)
    if (!owner) { owner = { actions: [], processes: [], processEvents: [], scheduleNodes: [], timeline: [] }; owners.set(id, owner) }
    return owner
  }
  for (const item of data.actions) if (item.opportunityId && item.kind === 'apply') get(item.opportunityId).actions.push(item)
  for (const item of data.processes) if (item.opportunityId) get(item.opportunityId).processes.push(item)
  for (const item of data.processEvents) if (item.opportunityId) get(item.opportunityId).processEvents.push(item)
  for (const item of data.scheduleNodes ?? []) if (item.opportunityId && item.kind === 'application_deadline') get(item.opportunityId).scheduleNodes!.push(item)
  for (const item of data.timeline ?? []) if (item.opportunityId && item.kind === 'application_submitted') get(item.opportunityId).timeline!.push(item)
  return get
}

export function hasApplicationEvidence(opportunity: Opportunity, data: JobClassificationData) {
  if (['screening', 'assessment', 'written_test', 'interview', 'offer'].includes(opportunity.processStage)) return true
  if (data.processes.some(item => item.opportunityId === opportunity.id && ['screening', 'assessment', 'written_test', 'interview', 'offer'].includes(item.stage))) return true
  if (data.actions.some(item => item.opportunityId === opportunity.id && item.kind === 'apply' && item.status === 'done')) return true
  if ((data.timeline ?? []).some(item => item.opportunityId === opportunity.id && item.kind === 'application_submitted')) return true
  return data.processEvents.some(item => item.opportunityId === opportunity.id && !item.invalidation && ['assessment_invite', 'written_test_invite', 'interview_invite', 'offer'].includes(item.type))
}
function dateKey(now: Date, timezone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}
export function applicationDeadlineExpired(deadline: ResolvedApplicationDeadline, now: Date, timezone: string) {
  if (deadline.state !== 'confirmed' || !deadline.deadline) return false
  if (deadline.precision === 'date') {
    const zone = deadline.timezone && !['floating-date', 'source-offset'].includes(deadline.timezone) ? deadline.timezone : timezone
    return deadline.deadline.slice(0, 10) < dateKey(now, zone)
  }
  return Number.isFinite(Date.parse(deadline.deadline)) && Date.parse(deadline.deadline) < now.getTime()
}

export type JobCategory = 'to_apply' | 'applied' | 'written_test' | 'interview' | 'process_ended' | 'deadline_passed' | 'no_deadline'
export function classifyJob(opportunity: Opportunity, data: JobClassificationData, now: Date, timezone: string): JobCategory | undefined {
  const process = data.processes.find(item => item.opportunityId === opportunity.id)
  const stage = process?.stage ?? opportunity.processStage
  const submitted = hasApplicationEvidence(opportunity, data)
  if (stage === 'unknown' || opportunity.processStage === 'unknown') return undefined
  if (stage === 'offer' || (stage === 'closed' && (submitted || process?.result === 'rejected')) || (opportunity.participationStatus === 'abandoned' && submitted)) return 'process_ended'
  if (opportunity.participationStatus === 'abandoned' || stage === 'closed') return undefined
  if (stage === 'interview') return 'interview'
  if (stage === 'written_test') return 'written_test'
  if (stage === 'screening' || stage === 'assessment') return 'applied'
  if (submitted || !['not_applied', 'waiting_release'].includes(stage)) return undefined
  const deadline = resolveApplicationDeadline(opportunity, data)
  if (deadline.postingStatus === 'closed' || applicationDeadlineExpired(deadline, now, timezone)) return 'deadline_passed'
  return deadline.state === 'confirmed' ? 'to_apply' : 'no_deadline'
}

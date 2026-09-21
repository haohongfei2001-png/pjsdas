import { applyDomainCompensation, applyUserDomainCommand, type DomainCompensation, type UserDomainCommand } from './domainCommands.js'
import { jobRoleSimilarity, normalizeJobCompany } from './jobPosting.js'
import type {
  DecisionRequest,
  DecisionRequestChoice,
  DecisionRequestReason,
  Opportunity,
  ScheduleNode,
  SemanticCandidate,
  SemanticConfidence,
  SemanticIntakeObservation,
  SemanticIntakeReceipt,
  SemanticIntakeSourceKind,
  SemanticResolutionTarget,
  TimelineRecord,
} from './model.js'
import { latestScheduleOccurrence } from './scheduleNodes.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'

export interface SemanticWritePolicyContext {
  authorized: boolean
  workspaceRevision?: string
  now?: Date
}

export interface SemanticBatchCompensation {
  operation: 'semantic_batch'
  payload: {
    domainCompensations: DomainCompensation[]
    decisionRequestIds: string[]
    receiptIds: string[]
    restoreDecisionRequests?: DecisionRequest[]
  }
}

export interface SemanticIntakeResult {
  status: 'APPLIED' | 'DECISION_REQUIRED' | 'NO_WRITE' | 'ALREADY_APPLIED'
  snapshot: PJSDASSnapshot
  changed: boolean
  summary: string
  receipt?: SemanticIntakeReceipt
  decisionRequests: DecisionRequest[]
  compensation?: SemanticBatchCompensation
}

export interface SemanticDecisionResult {
  status: 'APPLIED' | 'DISMISSED' | 'ALREADY_RESOLVED'
  snapshot: PJSDASSnapshot
  changed: boolean
  summary: string
  receipt?: SemanticIntakeReceipt
  compensation?: SemanticBatchCompensation
}

type OpportunityResolution =
  | { status: 'unique'; opportunity: Opportunity }
  | { status: 'ambiguous'; opportunities: Opportunity[] }
  | { status: 'missing'; opportunities: Opportunity[] }

type OccurrenceResolution =
  | { status: 'unique'; node: ScheduleNode }
  | { status: 'ambiguous'; nodes: ScheduleNode[] }
  | { status: 'missing'; nodes: ScheduleNode[] }

type CandidateApplyResult =
  | { status: 'applied'; snapshot: PJSDASSnapshot; compensation?: DomainCompensation; affected: SemanticIntakeReceipt['affectedObjects']; summary: string }
  | { status: 'already'; snapshot: PJSDASSnapshot; affected: SemanticIntakeReceipt['affectedObjects']; summary: string }
  | { status: 'decision'; snapshot: PJSDASSnapshot; reason: DecisionRequestReason; summary: string; choices: DecisionRequestChoice[]; affected: DecisionRequest['affectedObjects'] }

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function iso(value: string | undefined) {
  return Boolean(value && !Number.isNaN(new Date(value).getTime()))
}

function sourceTimelineKind(kind: SemanticIntakeSourceKind): TimelineRecord['source'] {
  if (kind === 'gmail') return 'gmail'
  if (kind === 'paia') return 'paia'
  if (kind === 'mcp') return 'mcp'
  if (kind === 'iphone') return 'iphone'
  return 'natural_language'
}

function sourceEvidence(observation: SemanticIntakeObservation) {
  return `${observation.source.kind}:${observation.source.sourceId}:${observation.source.sourceRecordId}`
}

function candidateEvidence(observation: SemanticIntakeObservation, candidate: SemanticCandidate) {
  return [...new Set([sourceEvidence(observation), ...candidate.evidenceRefs])]
}

function candidateSourceVersions(observation: SemanticIntakeObservation, candidate: SemanticCandidate) {
  const sourceVersion = observation.source.sourceVersion
    ? `${sourceEvidence(observation)}:${observation.source.sourceVersion}`
    : undefined
  return [...new Set([sourceVersion, ...candidate.sourceVersionRefs].filter((item): item is string => Boolean(item)))]
}

function sourceRecordIdentity(observation: SemanticIntakeObservation) {
  return [
    observation.source.kind,
    observation.source.sourceId,
    observation.source.sourceRecordId,
    observation.source.sourceVersion ?? '',
  ].join('|')
}

function existingReceipt(snapshot: PJSDASSnapshot, observation: SemanticIntakeObservation) {
  return (snapshot.data.semanticReceipts ?? []).find((item) =>
    item.inputId === observation.inputId
    || (
      item.sourceKind === observation.source.kind
      && item.sourceId === observation.source.sourceId
      && item.sourceRecordId === observation.source.sourceRecordId
      && (item.sourceVersion ?? '') === (observation.source.sourceVersion ?? '')
    ),
  )
}

function assertObservation(observation: SemanticIntakeObservation) {
  if (observation.contractVersion !== 1) throw new Error('Unsupported Semantic Intake contract version.')
  if (!observation.inputId?.trim()) throw new Error('Semantic Intake inputId is required.')
  if (!observation.source?.sourceId?.trim() || !observation.source.sourceRecordId?.trim()) {
    throw new Error('Semantic Intake source identity is incomplete.')
  }
  if (!iso(observation.source.observedAt)) throw new Error('Semantic Intake source observedAt is invalid.')
  if (observation.source.assertedAt && !iso(observation.source.assertedAt)) throw new Error('Semantic Intake source assertedAt is invalid.')
  if (!observation.source.timezone?.trim()) throw new Error('Semantic Intake source timezone is required.')
  if (!Array.isArray(observation.candidates)) throw new Error('Semantic Intake candidates must be an array.')
  const ids = new Set<string>()
  for (const candidate of observation.candidates) {
    if (!candidate.id?.trim() || ids.has(candidate.id)) throw new Error('Semantic Intake candidate identity is invalid or duplicated.')
    ids.add(candidate.id)
    if (!['high', 'medium', 'low'].includes(candidate.objectConfidence)) throw new Error('Semantic candidate objectConfidence is invalid.')
    if (!['high', 'medium', 'low'].includes(candidate.eventConfidence)) throw new Error('Semantic candidate eventConfidence is invalid.')
    if (candidate.temporalConfidence && !['high', 'medium', 'low'].includes(candidate.temporalConfidence)) {
      throw new Error('Semantic candidate temporalConfidence is invalid.')
    }
  }
}

function normalCompany(value: string) {
  return normalizeJobCompany(value).replace(/(?:校园招聘|校园|校招|招聘)$/g, '').trim()
}

function opportunityResolution(snapshot: PJSDASSnapshot, candidate: SemanticCandidate): OpportunityResolution {
  const target = candidate.target
  if (!target) return { status: 'missing', opportunities: [] }
  if (target.opportunityId) {
    const exact = snapshot.data.opportunities.find((item) => item.id === target.opportunityId)
    return exact ? { status: 'unique', opportunity: exact } : { status: 'missing', opportunities: [] }
  }

  let pool = snapshot.data.opportunities
  if (target.company?.trim()) {
    const company = normalCompany(target.company)
    pool = pool.filter((item) => normalCompany(item.company) === company)
  }
  if (target.role?.trim()) {
    const role = target.role.trim()
    const scored = pool
      .map((item) => ({ item, score: jobRoleSimilarity(role, item.role) }))
      .filter((item) => item.score >= 0.84)
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
    if (scored.length === 1) return { status: 'unique', opportunity: scored[0]!.item }
    if (scored.length > 1 && scored[0]!.score >= 0.94 && scored[0]!.score - scored[1]!.score >= 0.12) {
      return { status: 'unique', opportunity: scored[0]!.item }
    }
    pool = scored.map((item) => item.item)
  }

  const active = pool.filter((item) => item.processStage !== 'closed')
  if (active.length === 1) return { status: 'unique', opportunity: active[0]! }
  if (active.length > 1) return { status: 'ambiguous', opportunities: active }
  if (pool.length === 1) return { status: 'unique', opportunity: pool[0]! }
  return pool.length > 1
    ? { status: 'ambiguous', opportunities: pool }
    : { status: 'missing', opportunities: [] }
}

function latestActiveNodes(snapshot: PJSDASSnapshot) {
  const byOccurrence = new Map<string, ScheduleNode>()
  for (const node of snapshot.data.scheduleNodes ?? []) {
    const current = byOccurrence.get(node.occurrenceId)
    if (!current || node.version > current.version) byOccurrence.set(node.occurrenceId, node)
  }
  return [...byOccurrence.values()].filter((node) => node.state !== 'superseded' && node.state !== 'cancelled')
}

function occurrenceResolution(
  snapshot: PJSDASSnapshot,
  candidate: SemanticCandidate,
  opportunity?: Opportunity,
): OccurrenceResolution {
  const target = candidate.target
  if (target?.scheduleNodeId) {
    const node = (snapshot.data.scheduleNodes ?? []).find((item) => item.id === target.scheduleNodeId)
    if (!node) return { status: 'missing', nodes: [] }
    const latest = latestScheduleOccurrence(snapshot.data.scheduleNodes ?? [], node.occurrenceId)
    return latest ? { status: 'unique', node: latest } : { status: 'missing', nodes: [] }
  }
  if (target?.occurrenceId) {
    const node = latestScheduleOccurrence(snapshot.data.scheduleNodes ?? [], target.occurrenceId)
    return node ? { status: 'unique', node } : { status: 'missing', nodes: [] }
  }

  let nodes = latestActiveNodes(snapshot)
  const opportunityId = opportunity?.id ?? target?.opportunityId
  if (opportunityId) nodes = nodes.filter((node) => node.opportunityId === opportunityId)
  if (target?.occurrenceKind) nodes = nodes.filter((node) => node.kind === target.occurrenceKind)

  if (nodes.length === 1) return { status: 'unique', node: nodes[0]! }
  return nodes.length > 1 ? { status: 'ambiguous', nodes } : { status: 'missing', nodes: [] }
}

function opportunityChoices(items: Opportunity[]): DecisionRequestChoice[] {
  return items.slice(0, 4).map((item) => ({
    id: `opportunity:${item.id}`,
    label: `${item.company}｜${item.role}`,
    consequence: 'Only this opportunity will be updated.',
    resolution: { opportunityId: item.id },
  }))
}

function temporalLabel(node: ScheduleNode) {
  return node.temporal.date
    ?? node.temporal.startAt
    ?? node.temporal.deadlineAt
    ?? node.temporal.legacyProjectionAt
    ?? node.occurrenceId
}

function occurrenceChoices(nodes: ScheduleNode[]): DecisionRequestChoice[] {
  return nodes.slice(0, 4).map((node) => ({
    id: `occurrence:${node.occurrenceId}`,
    label: `${node.kind} · ${temporalLabel(node)}`,
    consequence: 'Only this recruiting occurrence will be updated.',
    resolution: { occurrenceId: node.occurrenceId },
  }))
}

function confirmChoices(): DecisionRequestChoice[] {
  return [
    { id: 'confirm', label: 'Confirm this fact', consequence: 'Commit the bounded internal update.', resolution: { confirm: true } },
    { id: 'ignore', label: 'Do not record it', consequence: 'Keep the current PJSDAS state unchanged.', resolution: { dismiss: true } },
  ]
}

function createDecisionRequest(input: {
  observation: SemanticIntakeObservation
  candidate: SemanticCandidate
  reason: DecisionRequestReason
  question: string
  choices: DecisionRequestChoice[]
  affectedObjects?: DecisionRequest['affectedObjects']
  recommendation?: { choiceId: string; basis: string }
  now: string
}): DecisionRequest {
  const id = `decision:${stableHash(`${input.observation.inputId}|${input.candidate.id}|${input.reason}`)}`
  return {
    id,
    reason: input.reason,
    affectedObjects: input.affectedObjects ?? [{ type: 'source', id: sourceEvidence(input.observation) }],
    question: input.question,
    choices: input.choices,
    recommendedChoiceId: input.recommendation?.choiceId,
    recommendationBasis: input.recommendation?.basis,
    evidenceRefs: candidateEvidence(input.observation, input.candidate),
    payloadBinding: {
      contractVersion: 1,
      inputId: input.observation.inputId,
      candidateId: input.candidate.id,
      source: structuredClone(input.observation.source),
      statementMode: input.observation.statementMode,
      candidate: structuredClone(input.candidate),
    },
    state: 'open',
    createdAt: input.now,
    updatedAt: input.now,
  }
}

function confidenceDecision(
  observation: SemanticIntakeObservation,
  candidate: SemanticCandidate,
  now: string,
  affectedObjects: DecisionRequest['affectedObjects'],
) {
  const low = candidate.objectConfidence !== 'high'
    || candidate.eventConfidence !== 'high'
    || (
      ['opportunity_deadline', 'occurrence_rescheduled', 'process_event'].includes(candidate.kind)
      && candidate.temporalConfidence !== undefined
      && candidate.temporalConfidence !== 'high'
    )
  if (!low) return undefined
  return createDecisionRequest({
    observation,
    candidate,
    reason: 'low_confidence',
    question: 'This fact is not confident enough for automatic write. Record it anyway?',
    choices: confirmChoices(),
    affectedObjects,
    now,
  })
}

function timelineForDecision(observation: SemanticIntakeObservation, request: DecisionRequest, now: string): TimelineRecord {
  return {
    id: `timeline:decision:${request.id}`,
    kind: 'decision_requested',
    category: 'change',
    source: sourceTimelineKind(observation.source.kind),
    occurredAt: observation.source.assertedAt ?? observation.source.observedAt,
    recordedAt: now,
    title: '需要你的决定',
    detail: request.question,
    decisionRequestId: request.id,
    sourceRef: sourceEvidence(observation),
  }
}

function sourceForProcessEvent(kind: SemanticIntakeSourceKind) {
  return kind === 'gmail' ? 'email' as const : 'manual' as const
}

function resolvedTarget(candidate: SemanticCandidate, resolution?: SemanticResolutionTarget): SemanticCandidate {
  if (!resolution) return candidate
  return {
    ...structuredClone(candidate),
    target: {
      ...(candidate.target ?? {}),
      ...(resolution.opportunityId ? { opportunityId: resolution.opportunityId } : {}),
      ...(resolution.occurrenceId ? { occurrenceId: resolution.occurrenceId } : {}),
    },
    ...(resolution.confirm ? {
      objectConfidence: 'high' as SemanticConfidence,
      eventConfidence: 'high' as SemanticConfidence,
      temporalConfidence: candidate.temporalConfidence ? 'high' as SemanticConfidence : undefined,
    } : {}),
  } as SemanticCandidate
}

function toDomainCommand(
  observation: SemanticIntakeObservation,
  candidate: SemanticCandidate,
  opportunity?: Opportunity,
  occurrence?: ScheduleNode,
): UserDomainCommand {
  const commandId = `semantic:${observation.inputId}:${candidate.id}`
  if (candidate.kind === 'application_submitted') {
    return {
      commandId,
      kind: 'record_application_submission',
      opportunityId: opportunity!.id,
      occurredAt: candidate.occurredAt,
    }
  }
  if (candidate.kind === 'process_event') {
    return {
      commandId,
      kind: 'record_process_event',
      opportunityId: opportunity!.id,
      eventType: candidate.eventType,
      occurredAt: candidate.occurredAt,
      dueAt: candidate.dueAt,
      duePrecision: candidate.duePrecision,
      timingMode: candidate.timingMode,
      estimatedMinutes: candidate.estimatedMinutes,
      notes: candidate.notes,
      location: candidate.location,
      joinUrl: candidate.joinUrl,
      source: sourceForProcessEvent(observation.source.kind),
    }
  }
  if (candidate.kind === 'opportunity_deadline') {
    return { commandId, kind: 'set_deadline', opportunityId: opportunity!.id, deadline: candidate.deadline, precision: candidate.precision }
  }
  if (candidate.kind === 'occurrence_completed' || candidate.kind === 'occurrence_cancelled') {
    return { commandId, kind: candidate.kind === 'occurrence_cancelled' ? 'cancel_occurrence' : 'complete_occurrence', occurrenceId: occurrence!.occurrenceId, occurredAt: candidate.occurredAt }
  }
  if (candidate.kind === 'occurrence_rescheduled') {
    return {
      commandId,
      kind: 'reschedule_occurrence',
      occurrenceId: occurrence!.occurrenceId,
      temporal: candidate.temporal,
      evidenceRefs: candidateEvidence(observation, candidate),
      sourceVersionRefs: candidateSourceVersions(observation, candidate),
    }
  }
  if (candidate.kind === 'abandon_opportunity') {
    return { commandId, kind: 'abandon_opportunity', opportunityId: opportunity!.id, occurredAt: candidate.occurredAt }
  }
  if (candidate.kind === 'manual_action') {
    return {
      commandId,
      kind: 'add_manual_action',
      title: candidate.title,
      dueAt: candidate.dueAt,
      duePrecision: candidate.duePrecision,
      estimatedMinutes: candidate.estimatedMinutes,
    }
  }
  throw new Error(`Candidate ${candidate.kind} does not map to an internal domain command.`)
}

function affectedFromDomain(command: UserDomainCommand, opportunity?: Opportunity, occurrence?: ScheduleNode): SemanticIntakeReceipt['affectedObjects'] {
  const affected: SemanticIntakeReceipt['affectedObjects'] = []
  if (opportunity) affected.push({ type: 'opportunity', id: opportunity.id })
  if (occurrence) affected.push({ type: 'schedule_node', id: occurrence.id })
  if (command.kind === 'set_action_status') affected.push({ type: 'action', id: command.actionId })
  return affected
}

function retagCommandTimeline(snapshot: PJSDASSnapshot, commandId: string, observation: SemanticIntakeObservation) {
  const record = (snapshot.data.timeline ?? []).find((item) => item.commandId === commandId)
  if (!record) return
  record.source = sourceTimelineKind(observation.source.kind)
  record.sourceRef = sourceEvidence(observation)
}

function applicationGroupGoverned(snapshot: PJSDASSnapshot, opportunity: Opportunity) {
  if (!opportunity.applicationGroupId) return false
  const group = snapshot.data.applicationGroups.find((item) => item.id === opportunity.applicationGroupId)
  if (!group) return false
  return Boolean(group.locked || group.total !== undefined || group.remaining !== undefined || group.rule?.trim())
}

function applyCandidate(
  snapshot: PJSDASSnapshot,
  observation: SemanticIntakeObservation,
  originalCandidate: SemanticCandidate,
  now: Date,
  resolution?: SemanticResolutionTarget,
): CandidateApplyResult {
  const candidate = resolvedTarget(originalCandidate, resolution)
  const opportunityNeeded = candidate.kind !== 'manual_action'
    && candidate.kind !== 'occurrence_completed'
    && candidate.kind !== 'occurrence_cancelled'
    && candidate.kind !== 'occurrence_rescheduled'
  let opportunity: Opportunity | undefined

  if (opportunityNeeded || candidate.target?.opportunityId || candidate.target?.company || candidate.target?.role) {
    const resolved = opportunityResolution(snapshot, candidate)
    if (resolved.status === 'ambiguous') {
      return {
        status: 'decision',
        snapshot,
        reason: 'ambiguous_target',
        summary: 'Several opportunities match this input.',
        choices: opportunityChoices(resolved.opportunities),
        affected: resolved.opportunities.slice(0, 4).map((item) => ({ type: 'opportunity', id: item.id })),
      }
    }
    if (resolved.status === 'missing') {
      return {
        status: 'decision',
        snapshot,
        reason: 'missing_required_field',
        summary: 'No unique existing opportunity matches this input.',
        choices: [
          { id: 'ignore', label: 'Do not record it', consequence: 'Keep the workspace unchanged.', resolution: { dismiss: true } },
          { id: 'clarify', label: 'Clarify the target', consequence: 'Provide the exact company/role or stable opportunity id.', resolution: { dismiss: true } },
        ],
        affected: [{ type: 'source', id: sourceEvidence(observation) }],
      }
    }
    opportunity = resolved.opportunity
  }

  let occurrence: ScheduleNode | undefined
  if (candidate.kind === 'occurrence_completed' || candidate.kind === 'occurrence_cancelled' || candidate.kind === 'occurrence_rescheduled') {
    const resolved = occurrenceResolution(snapshot, candidate, opportunity)
    if (resolved.status === 'ambiguous') {
      return {
        status: 'decision',
        snapshot,
        reason: 'ambiguous_occurrence',
        summary: 'Several recruiting occurrences match this input.',
        choices: occurrenceChoices(resolved.nodes),
        affected: resolved.nodes.slice(0, 4).map((node) => ({ type: 'schedule_node', id: node.id })),
      }
    }
    if (resolved.status === 'missing') {
      return {
        status: 'decision',
        snapshot,
        reason: 'missing_required_field',
        summary: 'No active recruiting occurrence matches this input.',
        choices: [
          { id: 'ignore', label: 'Do not record it', consequence: 'Keep the workspace unchanged.', resolution: { dismiss: true } },
          { id: 'clarify', label: 'Clarify the occurrence', consequence: 'Provide which interview, test, or assessment this refers to.', resolution: { dismiss: true } },
        ],
        affected: [{ type: 'source', id: sourceEvidence(observation) }],
      }
    }
    occurrence = resolved.node
    opportunity ??= occurrence.opportunityId
      ? snapshot.data.opportunities.find((item) => item.id === occurrence!.opportunityId)
      : undefined
  }

  const affected: DecisionRequest['affectedObjects'] = [
    ...(opportunity ? [{ type: 'opportunity' as const, id: opportunity.id }] : []),
    ...(occurrence ? [{ type: 'schedule_node' as const, id: occurrence.id }] : []),
  ]
  const confidence = confidenceDecision(observation, candidate, now.toISOString(), affected)
  if (confidence && !resolution?.confirm) {
    return {
      status: 'decision',
      snapshot,
      reason: confidence.reason,
      summary: 'Confidence is below the automatic-write threshold.',
      choices: confidence.choices,
      affected,
    }
  }

  if (candidate.kind === 'abandon_opportunity' && opportunity && applicationGroupGoverned(snapshot, opportunity) && !resolution?.confirm) {
    return {
      status: 'decision',
      snapshot,
      reason: 'shared_governance',
      summary: 'This opportunity participates in shared application governance.',
      choices: confirmChoices(),
      affected: [
        { type: 'opportunity', id: opportunity.id },
        ...(opportunity.applicationGroupId ? [{ type: 'application_group' as const, id: opportunity.applicationGroupId }] : []),
      ],
    }
  }

  if (candidate.kind === 'external_withdrawal') {
    return {
      status: 'decision',
      snapshot,
      reason: 'external_consequence',
      summary: 'PJSDAS will not withdraw an external application automatically.',
      choices: [
        { id: 'keep', label: 'Keep PJSDAS unchanged', consequence: 'No internal or external change is made.', resolution: { dismiss: true } },
        { id: 'record_internal', label: 'Record only an internal note later', consequence: 'No external withdrawal is performed.', resolution: { dismiss: true } },
      ],
      affected,
    }
  }

  if (candidate.kind === 'process_event' && candidate.target?.occurrenceId) {
    const sourceNode = (snapshot.data.scheduleNodes ?? []).find((node) => node.evidenceRefs.includes(`source-occurrence:${candidate.target!.occurrenceId}`))
    const existing = latestScheduleOccurrence(snapshot.data.scheduleNodes ?? [], sourceNode?.occurrenceId ?? candidate.target.occurrenceId)
    if (existing) {
      const event = snapshot.data.processEvents.find((item) => item.id === existing.processEventId)
      const sameTime = event?.dueAt === candidate.dueAt || Boolean(event?.dueAt && candidate.dueAt
        && Date.parse(event.dueAt) === Date.parse(candidate.dueAt))
      if (event?.opportunityId === opportunity?.id && event?.type === candidate.eventType && sameTime) {
        return { status: 'already', snapshot, summary: 'The same source occurrence is already recorded.',
          affected: [{ type: 'schedule_node', id: existing.id }] }
      }
      return { status: 'decision', snapshot, reason: 'material_conflict',
        summary: 'The source occurrence conflicts with an existing event; use an explicit reschedule or clarify the occurrence.',
        choices: [
          { id: 'ignore', label: 'Keep the existing occurrence', consequence: 'No schedule is replaced.', resolution: { dismiss: true } },
          { id: 'clarify', label: 'Clarify the change', consequence: 'Provide the intended occurrence and corrected time.', resolution: { dismiss: true } },
        ], affected: [{ type: 'schedule_node', id: existing.id }] }
    }
  }

  // An old observation is evidence, not authority to overwrite a later process
  // fact. Preserve it as a material conflict so an explicit correction can still
  // be confirmed; never silently discard it or apply last-arrival-wins.
  const assertedAt = 'occurredAt' in candidate ? candidate.occurredAt ?? observation.source.assertedAt : observation.source.assertedAt
  const process = opportunity ? snapshot.data.processes.find((item) => item.opportunityId === opportunity!.id) : undefined
  const currentFactAt = [opportunity?.effectiveProcessEventAt, process?.effectiveProcessEventAt, process?.lastProgressAt]
    .filter((value): value is string => Boolean(value && iso(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
  const updatesProgress = ['application_submitted', 'process_event', 'occurrence_completed', 'occurrence_cancelled', 'occurrence_rescheduled'].includes(candidate.kind)
  if (updatesProgress && observation.statementMode === 'assertion' && assertedAt && currentFactAt
    && Date.parse(assertedAt) < Date.parse(currentFactAt) && !resolution?.confirm) {
    return {
      status: 'decision', snapshot, reason: 'material_conflict',
      summary: 'This observation predates a newer process fact. Confirm only if it is an intentional correction.',
      choices: confirmChoices(), affected,
    }
  }

  const command = toDomainCommand(observation, candidate, opportunity, occurrence)
  if (command.kind === 'record_application_submission' && resolution?.confirm) command.reactivateConfirmed = true
  const result = applyUserDomainCommand(snapshot, command, now)
  if (result.status === 'NEEDS_CONFIRMATION') {
    return {
      status: 'decision',
      snapshot,
      reason: result.reason === 'TARGET_ABANDONED' ? 'target_abandoned' : 'material_conflict',
      summary: result.summary,
      choices: confirmChoices(),
      affected,
    }
  }
  if (result.status === 'ALREADY_APPLIED') {
    return {
      status: 'already',
      snapshot: result.snapshot,
      summary: result.summary,
      affected: affectedFromDomain(command, opportunity, occurrence),
    }
  }
  if (candidate.kind === 'process_event' && candidate.target?.occurrenceId) {
    const newEvent = result.snapshot.data.processEvents.find((event) => !snapshot.data.processEvents.some((prior) => prior.id === event.id))
    const node = (result.snapshot.data.scheduleNodes ?? []).find((item) => item.processEventId === newEvent?.id)
    if (node) {
      node.evidenceRefs = [...new Set([...node.evidenceRefs, `source-occurrence:${candidate.target.occurrenceId}`, ...candidateEvidence(observation, candidate)])]
      node.sourceVersionRefs = [...new Set([...node.sourceVersionRefs, ...candidateSourceVersions(observation, candidate)])]
    }
  }
  retagCommandTimeline(result.snapshot, command.commandId, observation)
  return {
    status: 'applied',
    snapshot: result.snapshot,
    compensation: result.compensation,
    summary: result.summary,
    affected: affectedFromDomain(command, opportunity, occurrence),
  }
}

function receipt(input: {
  observation: SemanticIntakeObservation
  status: SemanticIntakeReceipt['status']
  summary: string
  affectedObjects: SemanticIntakeReceipt['affectedObjects']
  decisionRequestIds: string[]
  undoAvailable: boolean
  now: string
  commandId?: string
}): SemanticIntakeReceipt {
  return {
    id: `semantic-receipt:${stableHash(input.observation.inputId)}`,
    inputId: input.observation.inputId,
    sourceKind: input.observation.source.kind,
    sourceId: input.observation.source.sourceId,
    sourceRecordId: input.observation.source.sourceRecordId,
    sourceVersion: input.observation.source.sourceVersion,
    commandId: input.commandId,
    status: input.status,
    summary: input.summary,
    affectedObjects: input.affectedObjects,
    decisionRequestIds: input.decisionRequestIds,
    undoAvailable: input.undoAvailable,
    createdAt: input.now,
    updatedAt: input.now,
  }
}

function appendReceipt(snapshot: PJSDASSnapshot, value: SemanticIntakeReceipt) {
  snapshot.data.semanticReceipts = [...(snapshot.data.semanticReceipts ?? []).filter((item) => item.id !== value.id), value]
}

function appendDecision(snapshot: PJSDASSnapshot, observation: SemanticIntakeObservation, request: DecisionRequest, now: string) {
  snapshot.data.decisionRequests = [...(snapshot.data.decisionRequests ?? []).filter((item) => item.id !== request.id), request]
  snapshot.data.timeline = [...(snapshot.data.timeline ?? []), timelineForDecision(observation, request, now)]
}

function originalFingerprint(observation: SemanticIntakeObservation) {
  return observation.originalTextFingerprint
    ?? (observation.originalText ? `fnv1a:${stableHash(observation.originalText)}` : undefined)
}

export function applySemanticIntake(
  snapshot: PJSDASSnapshot,
  observation: SemanticIntakeObservation,
  policy: SemanticWritePolicyContext,
): SemanticIntakeResult {
  assertObservation(observation)
  if (!policy.authorized) throw new Error('Semantic Intake source is not authorized for writes.')
  const now = policy.now ?? new Date()
  if (Number.isNaN(now.getTime())) throw new Error('Semantic Intake clock is invalid.')
  const timestamp = now.toISOString()
  const base = upgradeSnapshotToLatest(snapshot)

  const replay = existingReceipt(base, observation)
  if (replay) {
    return {
      status: 'ALREADY_APPLIED',
      snapshot: base,
      changed: false,
      summary: replay.summary,
      receipt: replay,
      decisionRequests: (base.data.decisionRequests ?? []).filter((item) => replay.decisionRequestIds.includes(item.id)),
    }
  }

  if (!['assertion', 'current_intent'].includes(observation.statementMode)) {
    const value = receipt({
      observation,
      status: 'no_write',
      summary: `No write: ${observation.statementMode} is not a current factual assertion or intent.`,
      affectedObjects: [],
      decisionRequestIds: [],
      undoAvailable: false,
      now: timestamp,
    })
    return {
      status: 'NO_WRITE',
      snapshot: base,
      changed: false,
      summary: value.summary,
      receipt: value,
      decisionRequests: [],
    }
  }

  if (observation.candidates.length === 0) {
    const value = receipt({
      observation,
      status: 'no_write',
      summary: 'No write: the input contains no candidate business fact or intent.',
      affectedObjects: [],
      decisionRequestIds: [],
      undoAvailable: false,
      now: timestamp,
    })
    return {
      status: 'NO_WRITE',
      snapshot: base,
      changed: false,
      summary: value.summary,
      receipt: value,
      decisionRequests: [],
    }
  }

  let working = base
  const decisions: DecisionRequest[] = []
  const domainCompensations: DomainCompensation[] = []
  const affectedObjects: SemanticIntakeReceipt['affectedObjects'] = []
  const summaries: string[] = []

  for (const candidate of observation.candidates) {
    const applied = applyCandidate(working, observation, candidate, now)
    if (applied.status === 'decision') {
      const request = createDecisionRequest({
        observation,
        candidate,
        reason: applied.reason,
        question: applied.summary,
        choices: applied.choices,
        affectedObjects: applied.affected,
        now: timestamp,
      })
      appendDecision(working, observation, request, timestamp)
      decisions.push(request)
      affectedObjects.push({ type: 'decision_request', id: request.id })
      continue
    }
    working = applied.snapshot
    summaries.push(applied.summary)
    affectedObjects.push(...applied.affected)
    if (applied.status === 'applied' && applied.compensation) domainCompensations.push(applied.compensation)
  }

  const committed = domainCompensations.length > 0 || summaries.length > 0
  const status: SemanticIntakeReceipt['status'] = committed ? 'committed' : 'decision_required'
  const summary = [
    summaries.length ? `${summaries.length} bounded update(s) committed.` : '',
    decisions.length ? `${decisions.length} item(s) need a decision.` : '',
  ].filter(Boolean).join(' ')
  const value = receipt({
    observation,
    status,
    summary,
    affectedObjects: [...new Map(affectedObjects.map((item) => [`${item.type}:${item.id}`, item])).values()],
    decisionRequestIds: decisions.map((item) => item.id),
    undoAvailable: domainCompensations.length > 0 || decisions.length > 0,
    now: timestamp,
    commandId: `semantic-intake:${observation.inputId}`,
  })
  appendReceipt(working, value)

  working.data.timeline = [...(working.data.timeline ?? []), {
    id: `timeline:semantic:${stableHash(observation.inputId)}`,
    kind: 'semantic_intake_applied',
    category: 'change',
    source: sourceTimelineKind(observation.source.kind),
    occurredAt: observation.source.assertedAt ?? observation.source.observedAt,
    recordedAt: timestamp,
    title: committed ? '语义输入已写入' : '语义输入需要决定',
    detail: [
      summary,
      originalFingerprint(observation) ? `text=${originalFingerprint(observation)}` : undefined,
      policy.workspaceRevision ? `workspace=${policy.workspaceRevision}` : undefined,
    ].filter(Boolean).join(' · '),
    sourceRef: sourceEvidence(observation),
    commandId: value.commandId,
    commandOperation: 'semantic_intake',
  }]
  working.exportedAt = timestamp
  validateSnapshot(working)

  return {
    status: committed ? 'APPLIED' : 'DECISION_REQUIRED',
    snapshot: working,
    changed: true,
    summary,
    receipt: value,
    decisionRequests: decisions,
    compensation: {
      operation: 'semantic_batch',
      payload: {
        domainCompensations,
        decisionRequestIds: decisions.map((item) => item.id),
        receiptIds: [value.id],
      },
    },
  }
}

export function resolveSemanticDecision(
  snapshot: PJSDASSnapshot,
  requestId: string,
  choiceId: string,
  now = new Date(),
): SemanticDecisionResult {
  const base = upgradeSnapshotToLatest(snapshot)
  const request = (base.data.decisionRequests ?? []).find((item) => item.id === requestId)
  if (!request) throw new Error(`DecisionRequest ${requestId} was not found.`)
  if (request.state !== 'open') {
    return {
      status: 'ALREADY_RESOLVED',
      snapshot: base,
      changed: false,
      summary: `DecisionRequest ${requestId} is already ${request.state}.`,
    }
  }
  const choice = request.choices.find((item) => item.id === choiceId)
  if (!choice) throw new Error(`DecisionRequest choice ${choiceId} was not found.`)
  const timestamp = now.toISOString()
  const previousRequest = structuredClone(request)

  request.state = 'answered'
  request.answerChoiceId = choice.id
  request.answeredAt = timestamp
  request.updatedAt = timestamp

  if (choice.resolution?.dismiss || !choice.resolution) {
    base.data.timeline = [...(base.data.timeline ?? []), {
      id: `timeline:decision-resolved:${request.id}:${stableHash(choice.id)}`,
      kind: 'decision_resolved',
      category: 'change',
      source: sourceTimelineKind(request.payloadBinding.source.kind),
      occurredAt: timestamp,
      recordedAt: timestamp,
      title: '决定已记录',
      detail: choice.label,
      decisionRequestId: request.id,
      sourceRef: `${request.payloadBinding.source.kind}:${request.payloadBinding.source.sourceId}:${request.payloadBinding.source.sourceRecordId}`,
    }]
    base.exportedAt = timestamp
    validateSnapshot(base)
    return {
      status: 'DISMISSED',
      snapshot: base,
      changed: true,
      summary: choice.consequence,
      compensation: {
        operation: 'semantic_batch',
        payload: {
          domainCompensations: [],
          decisionRequestIds: [],
          receiptIds: [],
          restoreDecisionRequests: [previousRequest],
        },
      },
    }
  }

  const observation: SemanticIntakeObservation = {
    contractVersion: 1,
    inputId: `decision-resolution:${request.id}:${choice.id}`,
    source: structuredClone(request.payloadBinding.source),
    statementMode: request.payloadBinding.statementMode,
    candidates: [resolvedTarget(request.payloadBinding.candidate, choice.resolution)],
  }
  const applied = applyCandidate(base, observation, observation.candidates[0]!, now, choice.resolution)
  if (applied.status === 'decision') {
    request.state = 'open'
    request.answerChoiceId = undefined
    request.answeredAt = undefined
    request.updatedAt = timestamp
    throw new Error('Decision resolution is still ambiguous; refresh the DecisionRequest from current state.')
  }

  let working = applied.snapshot
  const resolutionReceipt = receipt({
    observation,
    status: 'committed',
    summary: applied.summary,
    affectedObjects: applied.affected,
    decisionRequestIds: [request.id],
    undoAvailable: applied.status === 'applied' && Boolean(applied.compensation),
    now: timestamp,
    commandId: `semantic-decision:${request.id}:${choice.id}`,
  })
  appendReceipt(working, resolutionReceipt)
  working.data.timeline = [...(working.data.timeline ?? []), {
    id: `timeline:decision-resolved:${request.id}:${stableHash(choice.id)}`,
    kind: 'decision_resolved',
    category: 'change',
    source: sourceTimelineKind(request.payloadBinding.source.kind),
    occurredAt: timestamp,
    recordedAt: timestamp,
    title: '决定已执行',
    detail: choice.label,
    decisionRequestId: request.id,
    sourceRef: `${request.payloadBinding.source.kind}:${request.payloadBinding.source.sourceId}:${request.payloadBinding.source.sourceRecordId}`,
  }]
  working.exportedAt = timestamp
  validateSnapshot(working)
  return {
    status: 'APPLIED',
    snapshot: working,
    changed: true,
    summary: applied.summary,
    receipt: resolutionReceipt,
    compensation: {
      operation: 'semantic_batch',
      payload: {
        domainCompensations: applied.status === 'applied' && applied.compensation ? [applied.compensation] : [],
        decisionRequestIds: [previousRequest.id],
        receiptIds: [resolutionReceipt.id],
        restoreDecisionRequests: [previousRequest],
      },
    },
  }
}

export function applySemanticCompensation(
  snapshot: PJSDASSnapshot,
  compensation: SemanticBatchCompensation,
  now = new Date(),
) {
  let next = upgradeSnapshotToLatest(snapshot)
  const timestamp = now.toISOString()
  for (const item of [...compensation.payload.domainCompensations].reverse()) {
    next = applyDomainCompensation(next, item, now)
  }
  for (const id of compensation.payload.decisionRequestIds) {
    const request = (next.data.decisionRequests ?? []).find((item) => item.id === id)
    if (request && request.state !== 'expired') {
      request.state = 'superseded'
      request.updatedAt = timestamp
    }
  }
  for (const previous of compensation.payload.restoreDecisionRequests ?? []) {
    const index = (next.data.decisionRequests ?? []).findIndex((item) => item.id === previous.id)
    if (index >= 0) next.data.decisionRequests![index] = structuredClone(previous)
    else next.data.decisionRequests!.push(structuredClone(previous))
  }
  for (const id of compensation.payload.receiptIds) {
    const item = (next.data.semanticReceipts ?? []).find((receipt) => receipt.id === id)
    if (item) {
      item.status = 'undone'
      item.undoAvailable = false
      item.updatedAt = timestamp
    }
  }
  next.data.timeline = [...(next.data.timeline ?? []), {
    id: `timeline:semantic-undo:${stableHash(`${timestamp}|${compensation.payload.receiptIds.join(',')}`)}`,
    kind: 'semantic_undo_applied',
    category: 'change',
    source: 'system',
    occurredAt: timestamp,
    recordedAt: timestamp,
    title: '撤销语义写入',
    detail: `${compensation.payload.domainCompensations.length} compensation operation(s)`,
  }]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return next
}

export function semanticSourceRecordIdentity(observation: SemanticIntakeObservation) {
  return sourceRecordIdentity(observation)
}

import { invalidatedSourceFact } from './processFactCorrection.js'
import { applyDomainCompensation, applyUserDomainCommand, type DomainCompensation, type UserDomainCommand } from './domainCommands.js'
import { resolveOpportunityTarget } from './semanticTargetMatching.js'
import type {
  DecisionRequest,
  DecisionRequestChoice,
  DecisionRequestReason,
  ExternalCapabilityId,
  ExternalCapabilityState,
  ReminderIntent,
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
import { createIngestionLedgerTimeline, ingestionSourceRecordKey } from './ingestion.js'
import { reminderDedupeKey, resolveReminderTrigger } from './reminders.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import { actionableDecision } from './decisionActionability.js'

export interface SemanticWritePolicyContext {
  authorized: boolean
  workspaceRevision?: string
  now?: Date
  externalCapabilities?: Partial<Record<ExternalCapabilityId, ExternalCapabilityState>>
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
  /** Parser/source uncertainty retained by the ingestion ledger, not offered as a user choice. */
  coverageDebtCount?: number
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

function canonicalBusinessValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalBusinessValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalBusinessValue(item)]))
  return value
}

function sameBusinessValue(left: unknown, right: unknown) {
  return JSON.stringify(canonicalBusinessValue(left)) === JSON.stringify(canonicalBusinessValue(right))
}

function candidateBusinessSignature(candidate: SemanticCandidate) {
  const { id: _id, sourceVersionRefs: _sourceVersionRefs, evidenceRefs: _evidenceRefs, ...business } = candidate
  return JSON.stringify(canonicalBusinessValue(business))
}

function sameDecisionChoices(left: DecisionRequestChoice[], right: DecisionRequestChoice[]) {
  return sameBusinessValue([...left].sort((a, b) => a.id.localeCompare(b.id)),
    [...right].sort((a, b) => a.id.localeCompare(b.id)))
}

function sameAffectedObjects(left: DecisionRequest['affectedObjects'], right: DecisionRequest['affectedObjects']) {
  const order = (item: { type: string; id: string }) => `${item.type}:${item.id}`
  return sameBusinessValue([...left].sort((a, b) => order(a).localeCompare(order(b))),
    [...right].sort((a, b) => order(a).localeCompare(order(b))))
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

function receiptMatchesObservation(item: SemanticIntakeReceipt, observation: SemanticIntakeObservation) {
  return item.inputId === observation.inputId
    || (
      item.sourceKind === observation.source.kind
      && item.sourceId === observation.source.sourceId
      && item.sourceRecordId === observation.source.sourceRecordId
      && (item.sourceVersion ?? '') === (observation.source.sourceVersion ?? '')
    )
}

function receiptInvalidatedFactKeys(receipt: SemanticIntakeReceipt) {
  return new Set((receipt.factInvalidations ?? []).map((item) => item.factKey))
}

function pendingFactKeys(matching: SemanticIntakeReceipt[]) {
  const pending = new Set<string>()
  const restoredAfter = (factKey: string, at: string, afterSequence: number | undefined, invalidatedBy: SemanticIntakeReceipt) => matching.some((receipt) =>
    receipt.status === 'committed'
    && (afterSequence !== undefined && receipt.creationSequence !== undefined
      ? !receipt.causalOrderAmbiguous && !invalidatedBy.causalOrderAmbiguous
        && receipt.creationSequence > afterSequence
      : receipt.createdAt > at
        || (receipt.createdAt === at
          && !receipt.causalOrderAmbiguous
          && !invalidatedBy.causalOrderAmbiguous
          && (receipt.creationSequence ?? 0) > (invalidatedBy.creationSequence ?? 0)))
    && receipt.factKeys?.includes(factKey)
    && !receiptInvalidatedFactKeys(receipt).has(factKey))
  for (const item of matching) {
    for (const invalidation of item.factInvalidations ?? []) {
      if (!restoredAfter(invalidation.factKey, invalidation.invalidatedAt, invalidation.invalidatedAfterSequence, item)) pending.add(invalidation.factKey)
    }
    if (item.status === 'undone') for (const factKey of item.mutatedFactKeys ?? item.factKeys ?? []) {
      if (!restoredAfter(factKey, item.updatedAt, item.undoneAfterSequence, item)) pending.add(factKey)
    }
  }
  return pending
}

function pendingRecoveryFactKeys(snapshot: PJSDASSnapshot, observation: SemanticIntakeObservation) {
  return pendingFactKeys((snapshot.data.semanticReceipts ?? []).filter((item) =>
    receiptMatchesObservation(item, observation)))
}

export function pendingSemanticSourceFactKeys(
  snapshot: PJSDASSnapshot,
  source: { sourceKind: string; sourceId: string; sourceRecordId: string },
) {
  return pendingFactKeys((snapshot.data.semanticReceipts ?? []).filter((item) =>
    item.sourceKind === source.sourceKind
    && item.sourceId === source.sourceId
    && item.sourceRecordId === source.sourceRecordId))
}

function existingReceipt(snapshot: PJSDASSnapshot, observation: SemanticIntakeObservation) {
  if (pendingRecoveryFactKeys(snapshot, observation).size) return undefined
  return (snapshot.data.semanticReceipts ?? []).find((item) =>
    item.status !== 'undone'
    && !(item.factInvalidations?.length)
    && receiptMatchesObservation(item, observation),
  )
}

function normalInstant(value: string | undefined) {
  if (!value) return ''
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : value
}

export function semanticCandidateFactKey(snapshot: PJSDASSnapshot, candidate: SemanticCandidate) {
  const resolvedOpportunity = candidate.target ? opportunityResolution(snapshot, candidate) : undefined
  const opportunityId = resolvedOpportunity?.status === 'unique' ? resolvedOpportunity.opportunity.id : candidate.target?.opportunityId ?? ''
  const resolvedOccurrence = candidate.target ? occurrenceResolution(snapshot, candidate,
    resolvedOpportunity?.status === 'unique' ? resolvedOpportunity.opportunity : undefined) : undefined
  const node = resolvedOccurrence?.status === 'unique' ? resolvedOccurrence.node : undefined
  const occurrenceId = node?.occurrenceId ?? candidate.target?.occurrenceId ?? ''

  if (candidate.kind === 'application_submitted') return `application_submitted|opp:${opportunityId}`
  if (candidate.kind === 'opportunity_deadline') return `opportunity_deadline|opp:${opportunityId}|${candidate.precision}|${normalInstant(candidate.deadline)}`
  if (candidate.kind === 'abandon_opportunity') return `abandon_opportunity|opp:${opportunityId}`
  if (candidate.kind === 'occurrence_completed' || candidate.kind === 'occurrence_cancelled') {
    return `${candidate.kind}|occurrence:${occurrenceId}`
  }
  if (candidate.kind === 'occurrence_rescheduled') {
    return `occurrence_rescheduled|occurrence:${occurrenceId}|${JSON.stringify([
      candidate.temporal.shape,
      candidate.temporal.precision,
      normalInstant(candidate.temporal.startAt),
      normalInstant(candidate.temporal.endAt),
      normalInstant(candidate.temporal.deadlineAt),
      candidate.temporal.date ?? '',
    ])}`
  }
  if (candidate.kind === 'process_event') {
    return `process_event|opp:${opportunityId}|${candidate.eventType}|${JSON.stringify([
      candidate.temporal?.shape ?? '',
      candidate.temporal?.precision ?? candidate.duePrecision ?? '',
      normalInstant(candidate.temporal?.startAt ?? candidate.dueAt),
      normalInstant(candidate.temporal?.endAt),
      normalInstant(candidate.temporal?.deadlineAt),
      candidate.temporal?.date ?? '',
    ])}`
  }
  if (candidate.kind === 'manual_action') {
    return `manual_action|${candidate.title.trim().toLowerCase()}|${normalInstant(candidate.dueAt)}`
  }
  if (candidate.kind === 'reminder_intent') {
    if (!node) return undefined
    let trigger = ''
    try {
      trigger = resolveReminderTrigger(node, {
        triggerAt: candidate.triggerAt,
        offsetMinutesBefore: candidate.offsetMinutesBefore,
        purpose: candidate.purpose,
      })
    } catch {
      trigger = candidate.triggerAt ?? `offset:${candidate.offsetMinutesBefore ?? ''}`
    }
    return `reminder_intent|${reminderDedupeKey(node, candidate.purpose)}|${trigger}|${candidate.deliveryOwner ?? 'pjsdas'}`
  }
  if (candidate.kind === 'reminder_cancelled') {
    return `reminder_cancelled|${candidate.target?.reminderIntentId ?? ''}|${occurrenceId}|${candidate.purpose ?? ''}`
  }
  if (candidate.kind === 'external_withdrawal') return `external_withdrawal|opp:${opportunityId}`
  return undefined
}

function existingFactReceipt(snapshot: PJSDASSnapshot, factKey: string | undefined) {
  if (!factKey) return undefined
  return (snapshot.data.semanticReceipts ?? []).find((item) =>
    item.status === 'committed'
    && item.factKeys?.includes(factKey)
    && !receiptInvalidatedFactKeys(item).has(factKey),
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

function opportunityResolution(snapshot: PJSDASSnapshot, candidate: SemanticCandidate) {
  return resolveOpportunityTarget(snapshot.data.opportunities, candidate.target)
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
    { id: 'ignore', label: 'Do not record it', consequence: 'Keep the current TodayAction state unchanged.', resolution: { dismiss: true } },
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
  const id = `decision:${stableHash(JSON.stringify({
    inputId: input.observation.inputId, candidateId: input.candidate.id,
    reason: input.reason,
    candidate: { ...input.candidate, sourceVersionRefs: undefined },
    choices: input.choices, affectedObjects: input.affectedObjects,
  }))}`
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
      ['opportunity_deadline', 'occurrence_rescheduled', 'process_event', 'reminder_intent'].includes(candidate.kind)
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
    ...((resolution.opportunityId || resolution.occurrenceId || resolution.reminderIntentId) ? {
      objectConfidence: 'high' as SemanticConfidence,
    } : {}),
    target: {
      ...(candidate.target ?? {}),
      ...(resolution.opportunityId ? { opportunityId: resolution.opportunityId } : {}),
      ...(resolution.occurrenceId ? { occurrenceId: resolution.occurrenceId } : {}),
      ...(resolution.reminderIntentId ? { reminderIntentId: resolution.reminderIntentId } : {}),
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
  reminderIntent?: ReminderIntent,
  externalCapabilities: Partial<Record<ExternalCapabilityId, ExternalCapabilityState>> = {},
  commandInputId = observation.inputId,
): UserDomainCommand {
  const commandId = `semantic:${commandInputId}:${candidate.id}`
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
      temporal: candidate.temporal,
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
  if (candidate.kind === 'reminder_intent') {
    return {
      commandId,
      kind: 'upsert_reminder_intent',
      scheduleNodeId: occurrence!.id,
      purpose: candidate.purpose,
      triggerAt: candidate.triggerAt,
      offsetMinutesBefore: candidate.offsetMinutesBefore,
      deliveryOwner: candidate.deliveryOwner,
      channel: candidate.channel,
      capabilityStates: externalCapabilities,
    }
  }
  if (candidate.kind === 'reminder_cancelled') {
    return {
      commandId,
      kind: 'cancel_reminder_intent',
      reminderIntentId: reminderIntent!.id,
    }
  }
  throw new Error(`Candidate ${candidate.kind} does not map to an internal domain command.`)
}

function affectedFromDomain(command: UserDomainCommand, opportunity?: Opportunity, occurrence?: ScheduleNode, snapshot?: PJSDASSnapshot, before?: PJSDASSnapshot): SemanticIntakeReceipt['affectedObjects'] {
  const affected: SemanticIntakeReceipt['affectedObjects'] = []
  if (opportunity) affected.push({ type: 'opportunity', id: opportunity.id })
  if (occurrence) affected.push({ type: 'schedule_node', id: occurrence.id })
  if (command.kind === 'set_action_status') affected.push({ type: 'action', id: command.actionId })
  if (command.kind === 'upsert_reminder_intent' && snapshot) {
    const reminder = (snapshot.data.reminderIntents ?? []).find((item) =>
      item.scheduleNodeId === command.scheduleNodeId && item.purpose === command.purpose)
    if (reminder) affected.push({ type: 'reminder_intent', id: reminder.id })
  }
  if (command.kind === 'cancel_reminder_intent') affected.push({ type: 'reminder_intent', id: command.reminderIntentId })
  if (snapshot && before) {
    for (const action of snapshot.data.actions) {
      if (!before.data.actions.some((item) => item.id === action.id)) affected.push({ type: 'action', id: action.id })
    }
    for (const node of snapshot.data.scheduleNodes ?? []) {
      if (!(before.data.scheduleNodes ?? []).some((item) => item.id === node.id)) affected.push({ type: 'schedule_node', id: node.id })
    }
    for (const event of snapshot.data.processEvents) {
      if (!before.data.processEvents.some((item) => item.id === event.id)) affected.push({ type: 'process_event', id: event.id })
    }
  }
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
  externalCapabilities: Partial<Record<ExternalCapabilityId, ExternalCapabilityState>> = {},
  commandInputId = observation.inputId,
): CandidateApplyResult {
  const candidate = resolvedTarget(originalCandidate, resolution)
  const opportunityNeeded = candidate.kind !== 'manual_action'
    && candidate.kind !== 'reminder_intent'
    && candidate.kind !== 'reminder_cancelled'
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

  if (candidate.kind === 'reminder_intent' && candidate.triggerAt === undefined && candidate.offsetMinutesBefore === undefined) {
    return {
      status: 'decision',
      snapshot,
      reason: 'missing_required_field',
      summary: 'Reminder intent needs an exact trigger time or an offset from a datetime ScheduleNode.',
      choices: [
        { id: 'ignore', label: 'Do not create reminder', consequence: 'Keep reminder state unchanged.', resolution: { dismiss: true } },
        { id: 'clarify', label: 'Clarify reminder timing', consequence: 'Provide an exact time or offset.', resolution: { dismiss: true } },
      ],
      affected: [{ type: 'source', id: sourceEvidence(observation) }],
    }
  }

  let occurrence: ScheduleNode | undefined
  if (candidate.kind === 'occurrence_completed' || candidate.kind === 'occurrence_cancelled' || candidate.kind === 'occurrence_rescheduled' || candidate.kind === 'reminder_intent') {
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

  if (candidate.kind === 'reminder_intent' && candidate.offsetMinutesBefore !== undefined && occurrence?.temporal.precision !== 'datetime') {
    return {
      status: 'decision',
      snapshot,
      reason: 'missing_required_field',
      summary: 'A relative reminder offset requires an exact datetime ScheduleNode; TodayAction will not invent a clock time.',
      choices: [
        { id: 'ignore', label: 'Do not create reminder', consequence: 'Keep reminder state unchanged.', resolution: { dismiss: true } },
        { id: 'clarify', label: 'Provide exact reminder time', consequence: 'Use an explicit datetime reminder trigger.', resolution: { dismiss: true } },
      ],
      affected: occurrence ? [{ type: 'schedule_node', id: occurrence.id }] : [{ type: 'source', id: sourceEvidence(observation) }],
    }
  }

  let reminderIntent: ReminderIntent | undefined
  if (candidate.kind === 'reminder_cancelled') {
    const requestedReminderId = resolution?.reminderIntentId ?? candidate.target?.reminderIntentId
    const direct = requestedReminderId
      ? (snapshot.data.reminderIntents ?? []).find((item) => item.id === requestedReminderId)
      : undefined
    let matches = direct ? [direct] : (snapshot.data.reminderIntents ?? []).filter((item) =>
      item.state !== 'cancelled'
      && (!candidate.purpose || item.purpose === candidate.purpose)
      && (!candidate.target?.scheduleNodeId || item.scheduleNodeId === candidate.target.scheduleNodeId),
    )
    if (candidate.target?.occurrenceId) {
      const occurrence = latestScheduleOccurrence(snapshot.data.scheduleNodes ?? [], candidate.target.occurrenceId)
      if (occurrence) matches = matches.filter((item) => item.scheduleNodeId === occurrence.id)
    }
    if (matches.length !== 1) {
      return {
        status: 'decision',
        snapshot,
        reason: 'missing_required_field',
        summary: matches.length > 1 ? 'Several reminder intents match this cancellation.' : 'No active reminder intent matches this cancellation.',
        choices: matches.length > 1
          ? matches.slice(0, 4).map((item) => ({
              id: `reminder:${item.id}`,
              label: `${item.purpose} · ${item.triggerAt}`,
              consequence: 'Only this ReminderIntent will be cancelled; the ScheduleNode remains unchanged.',
              resolution: { reminderIntentId: item.id },
            }))
          : [
              { id: 'ignore', label: 'Do not cancel', consequence: 'Keep reminder state unchanged.', resolution: { dismiss: true } },
              { id: 'clarify', label: 'Clarify the reminder', consequence: 'Provide the exact reminder intent.', resolution: { dismiss: true } },
            ],
        affected: matches.slice(0, 4).map((item) => ({ type: 'reminder_intent' as const, id: item.id })),
      }
    }
    reminderIntent = matches[0]
  }

  const affected: DecisionRequest['affectedObjects'] = [
    ...(opportunity ? [{ type: 'opportunity' as const, id: opportunity.id }] : []),
    ...(occurrence ? [{ type: 'schedule_node' as const, id: occurrence.id }] : []),
    ...(reminderIntent ? [{ type: 'reminder_intent' as const, id: reminderIntent.id }] : []),
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
      summary: 'TodayAction will not withdraw an external application automatically.',
      choices: [
        { id: 'keep', label: 'Keep TodayAction unchanged', consequence: 'No internal or external change is made.', resolution: { dismiss: true } },
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
      const sameTemporal = !candidate.temporal || (existing.temporal.shape === candidate.temporal.shape
        && existing.temporal.precision === candidate.temporal.precision
        && (['startAt', 'endAt', 'latestStartAt', 'deadlineAt', 'date'] as const).every((key) => {
          const previous = existing.temporal[key]; const next = candidate.temporal![key]
          return previous === next || Boolean(previous && next && Date.parse(previous) === Date.parse(next))
        }))
      if (event?.opportunityId === opportunity?.id && event?.type === candidate.eventType && sameTime && sameTemporal) {
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

  const command = toDomainCommand(observation, candidate, opportunity, occurrence, reminderIntent, externalCapabilities, commandInputId)
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
      affected: affectedFromDomain(command, opportunity, occurrence, result.snapshot),
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
    affected: affectedFromDomain(command, opportunity, occurrence, result.snapshot, snapshot),
  }
}

function receipt(input: {
  observation: SemanticIntakeObservation
  recoveryInputId?: string
  status: SemanticIntakeReceipt['status']
  summary: string
  affectedObjects: SemanticIntakeReceipt['affectedObjects']
  decisionRequestIds: string[]
  factKeys?: string[]
  mutatedFactKeys?: string[]
  factMutationObjects?: SemanticIntakeReceipt['factMutationObjects']
  creationSequence?: number
  undoAvailable: boolean
  now: string
  commandId?: string
}): SemanticIntakeReceipt {
  const inputId = input.recoveryInputId ?? input.observation.inputId
  return {
    id: `semantic-receipt:${stableHash(inputId)}`,
    inputId,
    sourceKind: input.observation.source.kind,
    sourceId: input.observation.source.sourceId,
    sourceRecordId: input.observation.source.sourceRecordId,
    sourceVersion: input.observation.source.sourceVersion,
    commandId: input.commandId,
    status: input.status,
    summary: input.summary,
    affectedObjects: input.affectedObjects,
    decisionRequestIds: input.decisionRequestIds,
    factKeys: input.factKeys?.length ? [...new Set(input.factKeys)] : undefined,
    mutatedFactKeys: input.mutatedFactKeys === undefined ? undefined : [...new Set(input.mutatedFactKeys)],
    factMutationObjects: input.factMutationObjects,
    creationSequence: input.creationSequence,
    undoAvailable: input.undoAvailable,
    createdAt: input.now,
    updatedAt: input.now,
  }
}

function appendReceipt(snapshot: PJSDASSnapshot, value: SemanticIntakeReceipt) {
  snapshot.data.semanticReceipts = [...(snapshot.data.semanticReceipts ?? []).filter((item) => item.id !== value.id), value]
}

function compareReceiptCreationOrder(left: SemanticIntakeReceipt, right: SemanticIntakeReceipt) {
  if (left.creationSequence !== undefined && right.creationSequence !== undefined) {
    return left.creationSequence - right.creationSequence
  }
  return left.createdAt.localeCompare(right.createdAt)
}

function nextReceiptSequence(snapshot: PJSDASSnapshot) {
  const receipts = snapshot.data.semanticReceipts ?? []
  return Math.max(receipts.length, ...receipts.map((item) => item.creationSequence ?? 0)) + 1
}

function ownsIndependentFactMutation(
  target: SemanticIntakeReceipt,
  dependent: SemanticIntakeReceipt,
  factKey: string,
) {
  if (!dependent.mutatedFactKeys?.includes(factKey)) return false
  const affected = dependent.factMutationObjects?.[factKey]
  if (!affected?.length) return false
  const targetAffected = target.factMutationObjects?.[factKey] ?? target.affectedObjects
  const targetIds = new Set(targetAffected.map((item) => `${item.type}:${item.id}`))
  return affected.some((item) => !targetIds.has(`${item.type}:${item.id}`))
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
  const openSourceChoices = observation.source.kind === 'gmail'
    ? (base.data.decisionRequests ?? []).filter(item => item.state === 'open'
      && item.payloadBinding.source.kind === 'gmail'
      && item.payloadBinding.source.sourceId === observation.source.sourceId
      && item.payloadBinding.source.sourceRecordId === observation.source.sourceRecordId)
    : []
  const retiredSourceChoices = observation.source.kind === 'gmail'
    ? (base.data.decisionRequests ?? []).filter(item => item.state === 'superseded'
      && item.payloadBinding.source.kind === 'gmail'
      && item.payloadBinding.source.sourceId === observation.source.sourceId
      && item.payloadBinding.source.sourceRecordId === observation.source.sourceRecordId)
    : []
  const needsChoiceRecheck = observation.source.kind === 'gmail'
    && (replay?.status === 'decision_required' || replay?.status === 'committed')
    && (openSourceChoices.length > 0
      || (['assertion', 'current_intent'].includes(observation.statementMode)
        && observation.candidates.length > 0 && retiredSourceChoices.length > 0))
  const sourceNoLongerAssertive = observation.source.kind === 'gmail'
    && openSourceChoices.length > 0
    && (!['assertion', 'current_intent'].includes(observation.statementMode) || observation.candidates.length === 0)
  if (replay && !needsChoiceRecheck && !sourceNoLongerAssertive) {
    return {
      status: 'ALREADY_APPLIED',
      snapshot: base,
      changed: false,
      summary: replay.summary,
      receipt: replay,
      decisionRequests: (base.data.decisionRequests ?? []).filter((item) => replay.decisionRequestIds.includes(item.id)),
    }
  }

  const semanticCommandId = `semantic-intake:${observation.inputId}`
  const priorSemanticApplications = (base.data.timeline ?? []).filter((item) =>
    item.kind === 'semantic_intake_applied' && item.commandId === semanticCommandId).length
  const recoveryFactKeys = pendingRecoveryFactKeys(base, observation)
  const commandInputId = priorSemanticApplications || recoveryFactKeys.size
    ? `${observation.inputId}:recovery:${priorSemanticApplications}`
    : observation.inputId

  const retireAllSourceChoices = (summary: string, coverageDebtCount: number): SemanticIntakeResult => {
    const retired = openSourceChoices.map(item => structuredClone(item))
    for (const item of openSourceChoices) {
      item.state = 'superseded'
      item.updatedAt = timestamp
    }
    base.exportedAt = timestamp
    validateSnapshot(base)
    return {
      status: 'NO_WRITE', snapshot: base, changed: true, summary,
      decisionRequests: [], coverageDebtCount,
      compensation: { operation: 'semantic_batch', payload: {
        domainCompensations: [], decisionRequestIds: [], receiptIds: [], restoreDecisionRequests: retired,
      } },
    }
  }

  if (!['assertion', 'current_intent'].includes(observation.statementMode)) {
    if (observation.source.kind === 'gmail' && openSourceChoices.length) {
      return retireAllSourceChoices('The current source is not an assertion; former choices were retired.', 0)
    }
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
    if (observation.source.kind === 'gmail' && openSourceChoices.length) {
      return retireAllSourceChoices(
        'The current source parse no longer supports the former choices; coverage review is needed.',
        openSourceChoices.length,
      )
    }
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
  let coverageDebtCount = 0
  let supersededCount = 0
  const retiredRequests: DecisionRequest[] = []
  const retirePriorOpenChoices = (candidateId: string, preserveId?: string) => {
    if (observation.source.kind !== 'gmail') return
    for (const item of working.data.decisionRequests ?? []) {
      if (item.state !== 'open' || item.id === preserveId
        || item.payloadBinding.source.kind !== 'gmail'
        || item.payloadBinding.source.sourceId !== observation.source.sourceId
        || item.payloadBinding.source.sourceRecordId !== observation.source.sourceRecordId
        || item.payloadBinding.candidateId !== candidateId) continue
      retiredRequests.push(structuredClone(item))
      item.state = 'superseded'
      item.updatedAt = timestamp
      supersededCount += 1
    }
  }
  const domainCompensations: DomainCompensation[] = []
  const affectedObjects: SemanticIntakeReceipt['affectedObjects'] = []
  const summaries: string[] = []
  const factKeys: string[] = []
  const mutatedFactKeys: string[] = []
  const factMutationObjects: NonNullable<SemanticIntakeReceipt['factMutationObjects']> = {}

  const currentCandidateIds = new Set(observation.candidates.map(candidate => candidate.id))
  for (const item of openSourceChoices) {
    if (!currentCandidateIds.has(item.payloadBinding.candidateId)) {
      retirePriorOpenChoices(item.payloadBinding.candidateId)
      if (!observation.candidates.some(candidate => candidateBusinessSignature(candidate)
        === candidateBusinessSignature(item.payloadBinding.candidate))) coverageDebtCount += 1
    }
  }

  for (const candidate of observation.candidates) {
    if (invalidatedSourceFact(working, observation.source, semanticCandidateFactKey(working, candidate))) {
      coverageDebtCount += 1
      continue
    }
    if (observation.source.kind === 'gmail') {
      const priorAnswer = (working.data.decisionRequests ?? []).find(item =>
        (item.state === 'answered' || item.state === 'auto_resolved')
        && item.payloadBinding.source.kind === 'gmail'
        && item.payloadBinding.source.sourceId === observation.source.sourceId
        && item.payloadBinding.source.sourceRecordId === observation.source.sourceRecordId
        && (item.payloadBinding.candidateId === candidate.id
          || (!currentCandidateIds.has(item.payloadBinding.candidateId)
            && candidateBusinessSignature(item.payloadBinding.candidate) === candidateBusinessSignature(candidate))))
      if (priorAnswer) {
        retirePriorOpenChoices(candidate.id)
        if (candidateBusinessSignature(priorAnswer.payloadBinding.candidate) !== candidateBusinessSignature(candidate)) {
          coverageDebtCount += 1
        }
        continue
      }
    }
    // Recheck the open fragment and any newly parsed fragment, while retaining
    // receipts that already prove another fragment's business fact or answer.
    if (needsChoiceRecheck && !openSourceChoices.some(item => item.payloadBinding.candidateId === candidate.id)) {
      const alreadyRecorded = existingFactReceipt(working, semanticCandidateFactKey(working, candidate))
      if (alreadyRecorded) continue
    }
    const factKey = semanticCandidateFactKey(working, candidate)
    // A partially invalidated receipt still proves its other facts. A new recovery
    // command must never recreate those domain objects (notably manual actions).
    if (recoveryFactKeys.size && (!factKey || !recoveryFactKeys.has(factKey))) continue
    const priorFact = existingFactReceipt(working, factKey)
    if (priorFact && priorFact.sourceId !== observation.source.sourceId) {
      summaries.push('Cross-source fact already recorded; source receipt retained without a second business mutation.')
      affectedObjects.push(...priorFact.affectedObjects)
      if (factKey) factKeys.push(factKey)
      continue
    }
    const applied = applyCandidate(
      working,
      observation,
      candidate,
      now,
      undefined,
      policy.externalCapabilities ?? {},
      commandInputId,
    )
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
      if (observation.source.kind === 'gmail' && !actionableDecision(request, {
        opportunities: working.data.opportunities,
        scheduleNodes: working.data.scheduleNodes,
        reminderIntents: working.data.reminderIntents,
        now,
      })) {
        coverageDebtCount += 1
        retirePriorOpenChoices(candidate.id)
        continue
      }
      const currentChoices = observation.source.kind === 'gmail'
        ? (working.data.decisionRequests ?? []).filter(item => item.state === 'open'
          && item.payloadBinding.source.kind === 'gmail'
          && item.payloadBinding.source.sourceId === observation.source.sourceId
          && item.payloadBinding.source.sourceRecordId === observation.source.sourceRecordId
          && item.payloadBinding.candidateId === candidate.id)
        : []
      const matchingOpen = currentChoices.find(item =>
        item.reason === request.reason
        && candidateBusinessSignature(item.payloadBinding.candidate) === candidateBusinessSignature(candidate)
        && sameDecisionChoices(item.choices, request.choices)
        && sameAffectedObjects(item.affectedObjects, request.affectedObjects))
      if (matchingOpen) {
        retirePriorOpenChoices(candidate.id, matchingOpen.id)
        continue
      }
      // A changed business choice set is a new decision. Retain the old
      // request for provenance but stop counting its obsolete choices as open.
      retirePriorOpenChoices(candidate.id)
      // A return to an earlier set of choices is a new occurrence of that
      // decision; never replace the retained superseded record with the same ID.
      if (working.data.decisionRequests?.some(item => item.id === request.id)) {
        let sequence = 1
        let nextId = `decision:${stableHash(`${request.id}|reissue:${sequence}`)}`
        while (working.data.decisionRequests.some(item => item.id === nextId)) {
          sequence += 1
          nextId = `decision:${stableHash(`${request.id}|reissue:${sequence}`)}`
        }
        request.id = nextId
      }
      appendDecision(working, observation, request, timestamp)
      decisions.push(request)
      affectedObjects.push({ type: 'decision_request', id: request.id })
      continue
    }
    working = applied.snapshot
    retirePriorOpenChoices(candidate.id)
    summaries.push(applied.summary)
    if (factKey) factKeys.push(factKey)
    affectedObjects.push(...applied.affected)
    if (applied.status === 'applied' && applied.compensation) {
      domainCompensations.push(applied.compensation)
      if (factKey) {
        mutatedFactKeys.push(factKey)
        factMutationObjects[factKey] = [...(factMutationObjects[factKey] ?? []), ...applied.affected]
      }
    }
  }

  if (!domainCompensations.length && !summaries.length && !decisions.length) {
    if (supersededCount) {
      working.exportedAt = timestamp
      validateSnapshot(working)
    }
    return {
      status: 'NO_WRITE', snapshot: supersededCount ? working : base, changed: supersededCount > 0,
      summary: coverageDebtCount ? 'Source interpretation needs coverage review; no answerable user decision was created.' : 'No business change.',
      decisionRequests: [], coverageDebtCount,
      ...(retiredRequests.length ? { compensation: { operation: 'semantic_batch' as const, payload: {
        domainCompensations: [], decisionRequestIds: [], receiptIds: [], restoreDecisionRequests: retiredRequests,
      } } } : {}),
    }
  }
  const committed = domainCompensations.length > 0 || summaries.length > 0
  const status: SemanticIntakeReceipt['status'] = committed ? 'committed' : 'decision_required'
  const summary = [
    summaries.length ? `${summaries.length} bounded update(s) committed.` : '',
    decisions.length ? `${decisions.length} item(s) need a decision.` : '',
  ].filter(Boolean).join(' ')
  const value = receipt({
    observation,
    recoveryInputId: commandInputId !== observation.inputId ? commandInputId : undefined,
    status,
    summary,
    affectedObjects: [...new Map(affectedObjects.map((item) => [`${item.type}:${item.id}`, item])).values()],
    decisionRequestIds: decisions.map((item) => item.id),
    factKeys,
    mutatedFactKeys,
    factMutationObjects: Object.keys(factMutationObjects).length ? factMutationObjects : undefined,
    creationSequence: nextReceiptSequence(working),
    undoAvailable: domainCompensations.length > 0 || decisions.length > 0,
    now: timestamp,
    commandId: `semantic-intake:${observation.inputId}`,
  })
  appendReceipt(working, value)

  const semanticTimelineIdentity = priorSemanticApplications
    ? `${observation.inputId}|recovery:${priorSemanticApplications}`
    : observation.inputId
  working.data.timeline = [...(working.data.timeline ?? []), {
    id: `timeline:semantic:${stableHash(semanticTimelineIdentity)}`,
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
    coverageDebtCount,
    compensation: {
      operation: 'semantic_batch',
      payload: {
        domainCompensations,
        decisionRequestIds: decisions.map((item) => item.id),
        receiptIds: [value.id],
        restoreDecisionRequests: retiredRequests,
      },
    },
  }
}

export function resolveSemanticDecision(
  snapshot: PJSDASSnapshot,
  requestId: string,
  choiceId: string,
  now = new Date(),
  policy: Pick<SemanticWritePolicyContext, 'externalCapabilities'> = {},
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
  const applied = applyCandidate(base, observation, observation.candidates[0]!, now, choice.resolution, policy.externalCapabilities ?? {})
  if (applied.status === 'decision') {
    request.state = 'open'
    request.answerChoiceId = undefined
    request.answeredAt = undefined
    request.updatedAt = timestamp
    throw new Error('Decision resolution is still ambiguous; refresh the DecisionRequest from current state.')
  }

  let working = applied.snapshot
  const factKey = semanticCandidateFactKey(base, observation.candidates[0]!)
  const ownsMutation = applied.status === 'applied' && Boolean(applied.compensation) && Boolean(factKey)
  const resolutionReceipt = receipt({
    observation,
    status: 'committed',
    summary: applied.summary,
    affectedObjects: applied.affected,
    decisionRequestIds: [request.id],
    factKeys: factKey ? [factKey] : [],
    mutatedFactKeys: ownsMutation && factKey ? [factKey] : [],
    factMutationObjects: ownsMutation && factKey ? { [factKey]: applied.affected } : undefined,
    creationSequence: nextReceiptSequence(working),
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
  for (const id of compensation.payload.receiptIds) {
    const target = next.data.semanticReceipts?.find((item) => item.id === id)
    if (!target?.causalOrderAmbiguous) continue
    const hasUnorderedOverlap = next.data.semanticReceipts?.some((item) =>
      item.id !== target.id
      && item.causalOrderAmbiguous
      && item.status === 'committed'
      && (item.factKeys ?? []).some((key) => target.factKeys?.includes(key)))
    if (hasUnorderedOverlap) {
      throw new Error('Semantic receipt causal order cannot be proven for this legacy fact; automatic undo is blocked.')
    }
  }
  const timestamp = now.toISOString()
  const undoAfterSequence = Math.max(0, ...(next.data.semanticReceipts ?? []).map((item) => item.creationSequence ?? 0))
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
  const correctiveIngestion: TimelineRecord[] = []
  const correctedSourceKeys = new Set<string>()
  let exportedAt = timestamp
  for (const id of compensation.payload.receiptIds) {
    const item = (next.data.semanticReceipts ?? []).find((receipt) => receipt.id === id)
    if (item) {
      if (item.status !== 'undone' && item.commandId) {
        const sourceKey = [item.sourceKind, item.sourceId, item.sourceRecordId].join('|')
        const sourceRecords = (next.data.timeline ?? [])
          .filter((record) => record.ingestion
            && ingestionSourceRecordKey(record.ingestion) === sourceKey)
        let latestSourceRecord: TimelineRecord | undefined
        for (const record of sourceRecords) {
          if (!latestSourceRecord) {
            latestSourceRecord = record
            continue
          }
          const accountedAt = record.ingestion?.accountedAt ?? ''
          const latestAt = latestSourceRecord.ingestion?.accountedAt ?? ''
          if (accountedAt > latestAt
            || (accountedAt === latestAt
              && latestSourceRecord.ingestion?.outcome === 'unresolved'
              && record.ingestion?.outcome !== 'unresolved')) {
            latestSourceRecord = record
          }
        }
        const ingestion = latestSourceRecord?.ingestion
        if (!correctedSourceKeys.has(sourceKey)
          && ingestion) {
          const priorAccountedMs = Date.parse(ingestion.accountedAt)
          const correctionAt = new Date(Number.isFinite(priorAccountedMs)
            ? Math.max(now.getTime(), priorAccountedMs + 1)
            : now.getTime()).toISOString()
          correctiveIngestion.push(createIngestionLedgerTimeline({
            sourceKind: ingestion.sourceKind,
            sourceId: ingestion.sourceId,
            sourceRecordId: ingestion.sourceRecordId,
            runId: `semantic-undo:${item.id}`,
            recordType: ingestion.recordType,
            outcome: 'unresolved',
            fingerprint: ingestion.fingerprint,
            receivedAt: ingestion.receivedAt,
            accountedAt: correctionAt,
            reason: 'Semantic write was undone; source requires fresh reconciliation.',
            capabilityBoundaries: ingestion.capabilityBoundaries,
            issueKinds: ingestion.issueKinds,
            opportunityId: ingestion.opportunityId,
            processEventId: ingestion.processEventId,
            actionId: ingestion.actionId,
            company: latestSourceRecord?.company,
            role: latestSourceRecord?.role,
            sourceRef: latestSourceRecord?.sourceRef,
          }))
          correctedSourceKeys.add(sourceKey)
          if (correctionAt > exportedAt) exportedAt = correctionAt
        }
      }
      const invalidatedFactKeys = new Set(item.mutatedFactKeys ?? item.factKeys ?? [])
      if (invalidatedFactKeys.size) {
        const receipts = next.data.semanticReceipts ?? []
        for (const dependent of receipts) {
          if (dependent.id === item.id
            || compareReceiptCreationOrder(item, dependent) >= 0
            || dependent.status !== 'committed') continue
          const existingInvalidations = dependent.factInvalidations ?? []
          const alreadyInvalidated = new Set(existingInvalidations.map((entry) => entry.factKey))
          const overlap = (dependent.factKeys ?? []).filter((key) =>
            invalidatedFactKeys.has(key)
            && !alreadyInvalidated.has(key)
            && !ownsIndependentFactMutation(item, dependent, key))
          if (!overlap.length) continue
          dependent.factInvalidations = [
            ...existingInvalidations,
            ...overlap.map((factKey) => ({
              factKey,
              invalidatedByReceiptId: item.id,
              invalidatedAt: timestamp,
              invalidatedAfterSequence: undoAfterSequence,
            })),
          ]
        }
      }
      item.status = 'undone'
      item.undoneAfterSequence = undoAfterSequence
      item.undoAvailable = false
      item.updatedAt = timestamp
    }
  }
  next.data.timeline = [...(next.data.timeline ?? []), ...correctiveIngestion, {
    id: `timeline:semantic-undo:${stableHash(`${timestamp}|${compensation.payload.receiptIds.join(',')}`)}`,
    kind: 'semantic_undo_applied',
    category: 'change',
    source: 'system',
    occurredAt: timestamp,
    recordedAt: timestamp,
    title: '撤销语义写入',
    detail: `${compensation.payload.domainCompensations.length} compensation operation(s)`,
  }]
  next.exportedAt = exportedAt
  validateSnapshot(next)
  return next
}

export function semanticSourceRecordIdentity(observation: SemanticIntakeObservation) {
  return sourceRecordIdentity(observation)
}

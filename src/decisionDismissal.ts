import { canonicalOpportunityId } from './opportunityCanonicalization.js'
import type { DecisionRequest, SemanticCandidate, SemanticIntakeObservation } from './model.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'

export interface DismissSemanticDecisionCommand {
  kind: 'dismiss_semantic_decision'
  commandId: string
  requestId: string
  expectedRequestUpdatedAt: string
  expectedFingerprint: string
  reason: string
  evidenceRefs: string[]
}

export interface DecisionDismissalCompensation {
  operation: 'restore_dismissed_decision'
  payload: {
    commandId: string
    requestId: string
    before: DecisionRequest
    expectedPostFingerprint: string
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]))
  return value
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

/** Full request content, including choices and source binding, is review-bound. */
export async function decisionRequestFingerprint(request: DecisionRequest): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(request))))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function assertCommand(command: DismissSemanticDecisionCommand) {
  if (command.kind !== 'dismiss_semantic_decision' || !command.commandId.trim() || command.commandId.length > 240
    || !command.requestId.trim() || command.requestId.length > 240
    || !/^[a-f0-9]{64}$/.test(command.expectedFingerprint)
    || Number.isNaN(Date.parse(command.expectedRequestUpdatedAt))
    || !command.reason.trim() || command.reason.length > 800
    || !command.evidenceRefs.length || command.evidenceRefs.length > 20
    || command.evidenceRefs.some(ref => !ref.trim() || ref.length > 1000)) {
    throw new Error('Dismissal requires an exact request, full fingerprint, reason and bounded evidence references.')
  }
}

/** Dismiss the question only. No business candidate is executed or rewritten. */
export async function dismissSemanticDecision(snapshot: PJSDASSnapshot, command: DismissSemanticDecisionCommand, now = new Date()) {
  assertCommand(command)
  const timestamp = now.toISOString()
  const next = upgradeSnapshotToLatest(snapshot)
  const request = next.data.decisionRequests?.find(item => item.id === command.requestId)
  if (!request) throw new Error('DecisionRequest was not found.')
  const existing = (next.data.timeline ?? []).find(item => item.commandId === command.commandId)
  if (existing) {
    const previous = request.dismissal
    if (existing.commandOperation !== command.kind || request.state !== 'dismissed' || !previous
      || previous.commandId !== command.commandId || previous.reason !== command.reason
      || previous.expectedRequestUpdatedAt !== command.expectedRequestUpdatedAt
      || previous.expectedFingerprint !== command.expectedFingerprint || !same(previous.evidenceRefs, command.evidenceRefs)) {
      throw new Error('Dismissal command ID was reused or its applied state has changed.')
    }
    return { status: 'ALREADY_APPLIED' as const, snapshot, changed: false, summary: 'This decision was already dismissed.' }
  }
  if (request.state !== 'open' && request.state !== 'expired') throw new Error('Only open or expired decisions may be dismissed.')
  if (request.updatedAt !== command.expectedRequestUpdatedAt || await decisionRequestFingerprint(request) !== command.expectedFingerprint) {
    throw new Error('DecisionRequest changed since review; refresh its timestamp and fingerprint.')
  }
  const before = structuredClone(request)
  request.state = 'dismissed'
  request.updatedAt = timestamp
  request.dismissal = {
    commandId: command.commandId, dismissedAt: timestamp, reason: command.reason,
    evidenceRefs: [...command.evidenceRefs], expectedRequestUpdatedAt: command.expectedRequestUpdatedAt,
    expectedFingerprint: command.expectedFingerprint,
  }
  next.data.timeline = [...(next.data.timeline ?? []), {
    id: `timeline:decision-dismissal:${command.commandId}`, kind: 'decision_resolved', category: 'change', source: 'mcp',
    occurredAt: timestamp, recordedAt: timestamp, title: '决定请求已忽略', detail: command.reason,
    decisionRequestId: request.id, commandId: command.commandId, commandOperation: command.kind,
    sourceRef: `${request.payloadBinding.source.kind}:${request.payloadBinding.source.sourceId}:${request.payloadBinding.source.sourceRecordId}`,
    changes: { state: { before: before.state, after: 'dismissed' } },
  }]
  next.exportedAt = timestamp
  validateSnapshot(next)
  const compensation: DecisionDismissalCompensation = { operation: 'restore_dismissed_decision', payload: {
    commandId: command.commandId, requestId: request.id, before, expectedPostFingerprint: await decisionRequestFingerprint(request),
  } }
  return { status: 'DISMISSED' as const, snapshot: next, changed: true, summary: 'Decision dismissed; business facts were preserved.', compensation }
}

/** Restore only if the exact dismissed request still owns the post-state. */
export async function applyDecisionDismissalCompensation(snapshot: PJSDASSnapshot, compensation: DecisionDismissalCompensation, now = new Date()) {
  if (compensation.operation !== 'restore_dismissed_decision') throw new Error('Unsupported decision compensation.')
  const next = upgradeSnapshotToLatest(snapshot)
  const { commandId, requestId, before, expectedPostFingerprint } = compensation.payload
  const request = next.data.decisionRequests?.find(item => item.id === requestId)
  if (!request || before.id !== requestId || !['open', 'expired'].includes(before.state)
    || request.state !== 'dismissed' || request.dismissal?.commandId !== commandId
    || await decisionRequestFingerprint(request) !== expectedPostFingerprint
    || await decisionRequestFingerprint(before) !== request.dismissal.expectedFingerprint) {
    throw new Error('Decision changed after dismissal; compensation cannot overwrite later work.')
  }
  const timestamp = now.toISOString()
  next.data.decisionRequests = next.data.decisionRequests!.map(item => item.id === requestId ? structuredClone(before) : item)
  next.data.timeline = [...(next.data.timeline ?? []), {
    id: `timeline:decision-dismissal-undo:${commandId}`, kind: 'decision_resolved', category: 'change', source: 'mcp',
    occurredAt: timestamp, recordedAt: timestamp, title: '已撤销忽略决定请求', decisionRequestId: requestId,
    commandOperation: 'restore_dismissed_decision', changes: { state: { before: 'dismissed', after: before.state } },
  }]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return next
}

function candidateIdentity(snapshot: PJSDASSnapshot, candidate: SemanticCandidate) {
  const { id: _id, ...content } = candidate
  return content.target?.opportunityId
    ? { ...content, target: { ...content.target, opportunityId: canonicalOpportunityId(snapshot, content.target.opportunityId) } }
    : content
}

function sourceContentFingerprint(observation: SemanticIntakeObservation) {
  if (observation.originalTextFingerprint) return observation.originalTextFingerprint
  if (!observation.originalText) return undefined
  let hash = 2166136261
  for (let index = 0; index < observation.originalText.length; index += 1) {
    hash ^= observation.originalText.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a:${(hash >>> 0).toString(36)}`
}

/** Recover old bindings only from the immutable ledger of their creation. */
export function dismissalSourceFingerprint(snapshot: PJSDASSnapshot, request: DecisionRequest): string | undefined {
  if (request.payloadBinding.originalTextFingerprint) return request.payloadBinding.originalTextFingerprint
  const source = request.payloadBinding.source
  if (source.kind !== 'gmail') return undefined
  const fingerprints = new Set((snapshot.data.timeline ?? []).flatMap(record => {
    const entry = record.ingestion
    return entry && entry.sourceKind === source.kind && entry.sourceId === source.sourceId
      && entry.sourceRecordId === source.sourceRecordId && entry.accountedAt === request.createdAt
      && entry.fingerprint ? [entry.fingerprint] : []
  }))
  return fingerprints.size === 1 ? [...fingerprints][0] : undefined
}

/** Only these two Gmail parser tags describe the same bytes, not new source versions. */
function sameGmailInterpreterContent(snapshot: PJSDASSnapshot, request: DecisionRequest, observation: SemanticIntakeObservation) {
  const known = new Set(['uu06-v1', 'reconciliation-v1'])
  return observation.source.kind === 'gmail'
    && request.payloadBinding.source.kind === 'gmail'
    && known.has(request.payloadBinding.source.sourceVersion ?? '')
    && known.has(observation.source.sourceVersion ?? '')
    && Boolean(dismissalSourceFingerprint(snapshot, request))
    && dismissalSourceFingerprint(snapshot, request) === observation.originalTextFingerprint
}
function interpreterCandidate(candidate: ReturnType<typeof candidateIdentity>, sourceRecordId: string, sourceVersion: string | undefined) {
  // Tagged tuples cannot collide with an arbitrary source reference string.
  return { ...candidate, sourceVersionRefs: candidate.sourceVersionRefs.map(ref =>
    ref === `${sourceRecordId}:${sourceVersion}` ? ['known_gmail_interpreter', sourceRecordId] : ['source_ref', ref]) }
}

/** Observation clocks and input IDs may change during replay; source facts may not. */
export function dismissedSemanticCandidate(snapshot: PJSDASSnapshot, observation: SemanticIntakeObservation, candidate: SemanticCandidate): boolean {
  return (snapshot.data.decisionRequests ?? []).some(request => {
    const interpreterEquivalent = sameGmailInterpreterContent(snapshot, request, observation)
    const source = request.payloadBinding.source
    const fingerprint = dismissalSourceFingerprint(snapshot, request)
    const gmailParserBinding = source.kind === 'gmail'
    const originalCandidate = interpreterEquivalent
      ? interpreterCandidate(candidateIdentity(snapshot, request.payloadBinding.candidate), source.sourceRecordId, source.sourceVersion) : candidateIdentity(snapshot, request.payloadBinding.candidate)
    const replayCandidate = interpreterEquivalent
      ? interpreterCandidate(candidateIdentity(snapshot, candidate), observation.source.sourceRecordId, observation.source.sourceVersion) : candidateIdentity(snapshot, candidate)
    return request.state === 'dismissed' && Boolean(request.dismissal)
      && source.kind === observation.source.kind
      && source.sourceId === observation.source.sourceId
      && source.sourceRecordId === observation.source.sourceRecordId
      && ((source.sourceVersion ?? '') === (observation.source.sourceVersion ?? '') || interpreterEquivalent)
      && (fingerprint ? fingerprint === sourceContentFingerprint(observation) : !gmailParserBinding)
      && request.payloadBinding.statementMode === observation.statementMode
      && same(originalCandidate, replayCandidate)
  })
}

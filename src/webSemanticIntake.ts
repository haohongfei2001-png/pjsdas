import { getAllDiscoveryInboxItems } from './discoveryInboxStore.js'
import {
  exportLocalSnapshot,
  getAllOpportunities,
  replaceLocalSnapshotFromCloud,
} from './db.js'
import {
  applySemanticCompensation,
  applySemanticIntake,
  resolveSemanticDecision,
  type SemanticBatchCompensation,
} from './semanticIntake.js'
import { fingerprintWorkspace } from './cloud/workspaceFingerprint.js'
import { type CanonicalJobReference } from './progressUpdate.js'
import { buildWebSemanticInterpretation } from './webSemanticInterpretation.js'
import type { SemanticCandidate, SemanticIntakeObservation, SemanticStatementMode } from './model.js'
import { connectedWorkspaceAuthorityEnabled } from './cloud/connectedWorkspaceRepository.js'
import {
  createConnectedCommandId,
  executeConnectedBusinessCommand,
  undoConnectedBusinessCommand,
} from './cloud/authoritativeCommandClient.js'

export type LocalSemanticUndoToken =
  | {
      kind?: 'local'
      workspaceFingerprint: string
      compensation: SemanticBatchCompensation
    }
  | {
      kind: 'connected'
      accountKey: string
      targetCommandId: string
    }

export interface WebSemanticCaptureResult {
  status: 'APPLIED' | 'DECISION_REQUIRED' | 'NO_WRITE' | 'ALREADY_APPLIED'
  summary: string
  unresolved: string[]
  ignored: string[]
  decisionRequestIds: string[]
  undo?: LocalSemanticUndoToken
}

export interface WebSemanticCapturePreview {
  mode: SemanticStatementMode
  candidates: SemanticCandidate[]
  unresolved: string[]
  ignored: string[]
}

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

async function canonicalReferences(): Promise<CanonicalJobReference[]> {
  const items = await getAllDiscoveryInboxItems()
  return items
    .filter((item) => item.status !== 'dismissed')
    .map((item) => ({
      opportunityId: item.promotedOpportunityId ?? item.candidateOpportunityId,
      company: item.company,
      role: item.role,
      sourceBacked: true,
      sourceLabel: item.sourceUrl,
    }))
}

async function optimisticReplace(
  baselineFingerprint: string,
  nextSnapshot: Parameters<typeof replaceLocalSnapshotFromCloud>[0],
) {
  const latest = await exportLocalSnapshot()
  const currentFingerprint = await fingerprintWorkspace(latest)
  if (currentFingerprint !== baselineFingerprint) {
    throw new Error('工作区在处理期间已变化；为避免覆盖新数据，本次输入没有写入。请重新提交。')
  }
  await replaceLocalSnapshotFromCloud(nextSnapshot)
  const committed = await exportLocalSnapshot()
  const committedFingerprint = await fingerprintWorkspace(committed)
  window.dispatchEvent(new CustomEvent('pjsdas:workspace-replaced'))
  return committedFingerprint
}

export async function previewWebSemanticCapture(
  text: string,
  options: { now?: Date } = {},
): Promise<WebSemanticCapturePreview> {
  const trimmed = text.trim()
  if (!trimmed) return { mode: 'assertion', candidates: [], unresolved: [], ignored: [] }
  const now = options.now ?? new Date()
  const [opportunities, references, baseline] = await Promise.all([
    getAllOpportunities(),
    canonicalReferences(),
    exportLocalSnapshot(),
  ])
  const interpretation = buildWebSemanticInterpretation(trimmed, opportunities, baseline, references, now)
  return {
    mode: interpretation.mode,
    candidates: interpretation.candidates,
    unresolved: interpretation.unresolved,
    ignored: interpretation.ignored,
  }
}

export async function submitWebSemanticCapture(
  text: string,
  options: { now?: Date; timezone?: string; accountKey?: string; commandId?: string; contextRefs?: string[] } = {},
): Promise<WebSemanticCaptureResult> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('请输入要告诉 PJSDAS 的内容。')
  const now = options.now ?? new Date()
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  const [opportunities, references, baseline] = await Promise.all([
    getAllOpportunities(),
    canonicalReferences(),
    exportLocalSnapshot(),
  ])
  const baselineFingerprint = await fingerprintWorkspace(baseline)
  const interpretation = buildWebSemanticInterpretation(trimmed, opportunities, baseline, references, now)
  const recordId = `capture:${now.getTime()}:${stableHash(trimmed)}`
  const observation: SemanticIntakeObservation = {
    contractVersion: 1,
    inputId: `web:${recordId}`,
    source: {
      kind: 'web',
      sourceId: 'todayaction-web',
      sourceRecordId: recordId,
      sourceVersion: '1',
      observedAt: now.toISOString(),
      assertedAt: now.toISOString(),
      timezone,
    },
    statementMode: interpretation.mode,
    originalText: trimmed,
    contextRefs: [...(options.contextRefs ?? [])],
    candidates: interpretation.candidates,
  }

  if (options.accountKey && connectedWorkspaceAuthorityEnabled()) {
    const commandId = options.commandId ?? createConnectedCommandId('web-semantic')
    const authoritative = await executeConnectedBusinessCommand(options.accountKey, {
      type: 'semantic_intake',
      value: observation,
    }, { commandId })
    if (authoritative.outcome === 'CONFLICT') {
      throw new Error(authoritative.conflict?.message ?? 'Semantic Intake conflicted with newer authoritative state.')
    }
    const status = String(authoritative.result?.status ?? (authoritative.outcome === 'ALREADY_APPLIED' ? 'ALREADY_APPLIED' : 'NO_WRITE')) as WebSemanticCaptureResult['status']
    const decisionRequestIds = Array.isArray(authoritative.result?.decisionRequestIds)
      ? authoritative.result!.decisionRequestIds.filter((value): value is string => typeof value === 'string')
      : []
    return {
      status,
      summary: typeof authoritative.result?.summary === 'string' ? authoritative.result.summary : 'PJSDAS processed the authoritative update.',
      unresolved: interpretation.unresolved,
      ignored: interpretation.ignored,
      decisionRequestIds,
      undo: authoritative.receipt?.undoAvailable === true
        ? { kind: 'connected', accountKey: options.accountKey, targetCommandId: commandId }
        : undefined,
    }
  }

  const result = applySemanticIntake(baseline, observation, {
    authorized: true,
    workspaceRevision: `local:${baselineFingerprint}`,
    now,
  })

  if (!result.changed) {
    return {
      status: result.status,
      summary: result.summary,
      unresolved: interpretation.unresolved,
      ignored: interpretation.ignored,
      decisionRequestIds: result.decisionRequests.map((item) => item.id),
    }
  }

  const committedFingerprint = await optimisticReplace(baselineFingerprint, result.snapshot)
  return {
    status: result.status,
    summary: result.summary,
    unresolved: interpretation.unresolved,
    ignored: interpretation.ignored,
    decisionRequestIds: result.decisionRequests.map((item) => item.id),
    undo: result.compensation ? {
      workspaceFingerprint: committedFingerprint,
      compensation: result.compensation,
    } : undefined,
  }
}

export async function resolveWebDecision(
  requestId: string,
  choiceId: string,
  options: { now?: Date; accountKey?: string } = {},
) {
  const now = options.now ?? new Date()
  if (options.accountKey && connectedWorkspaceAuthorityEnabled()) {
    const commandId = createConnectedCommandId('web-decision')
    const authoritative = await executeConnectedBusinessCommand(options.accountKey, {
      type: 'resolve_semantic_decision',
      value: { requestId, choiceId },
    }, { commandId })
    if (authoritative.outcome === 'CONFLICT') {
      throw new Error(authoritative.conflict?.message ?? 'Decision resolution conflicted with newer authoritative state.')
    }
    return {
      status: String(authoritative.result?.status ?? 'ALREADY_RESOLVED'),
      changed: authoritative.outcome === 'COMMITTED',
      snapshot: authoritative.snapshot,
      summary: typeof authoritative.result?.summary === 'string' ? authoritative.result.summary : 'Decision handled.',
      undo: authoritative.receipt?.undoAvailable === true
        ? { kind: 'connected' as const, accountKey: options.accountKey, targetCommandId: commandId }
        : undefined,
    }
  }
  const baseline = await exportLocalSnapshot()
  const baselineFingerprint = await fingerprintWorkspace(baseline)
  const result = resolveSemanticDecision(baseline, requestId, choiceId, now)
  if (!result.changed) return { ...result, undo: undefined as LocalSemanticUndoToken | undefined }
  const committedFingerprint = await optimisticReplace(baselineFingerprint, result.snapshot)
  return {
    ...result,
    undo: result.compensation ? {
      workspaceFingerprint: committedFingerprint,
      compensation: result.compensation,
    } : undefined,
  }
}

export async function undoWebSemanticChange(token: LocalSemanticUndoToken, now = new Date()) {
  if (token.kind === 'connected') {
    const result = await undoConnectedBusinessCommand(token.accountKey, token.targetCommandId)
    if (result.outcome === 'CONFLICT') {
      throw new Error(result.conflict?.message ?? 'Undo conflicted with a dependent authoritative update.')
    }
    return result
  }
  const baseline = await exportLocalSnapshot()
  const baselineFingerprint = await fingerprintWorkspace(baseline)
  if (baselineFingerprint !== token.workspaceFingerprint) {
    throw new Error('工作区已有后续变化，无法自动撤销而不影响新数据。')
  }
  const next = applySemanticCompensation(baseline, token.compensation, now)
  return optimisticReplace(baselineFingerprint, next)
}

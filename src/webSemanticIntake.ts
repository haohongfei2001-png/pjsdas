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
import { parseProgressUpdate, type CanonicalJobReference } from './progressUpdate.js'
import type {
  ProcessEventType,
  ScheduleNodeKind,
  SemanticCandidate,
  SemanticIntakeObservation,
  SemanticStatementMode,
} from './model.js'

export interface LocalSemanticUndoToken {
  workspaceFingerprint: string
  compensation: SemanticBatchCompensation
}

export interface WebSemanticCaptureResult {
  status: 'APPLIED' | 'DECISION_REQUIRED' | 'NO_WRITE' | 'ALREADY_APPLIED'
  summary: string
  unresolved: string[]
  ignored: string[]
  decisionRequestIds: string[]
  undo?: LocalSemanticUndoToken
}

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function statementMode(text: string): SemanticStatementMode {
  const trimmed = text.trim()
  if (/(改写|润色|翻译|重写|rewrite|translate)/i.test(trimmed)) return 'rewrite_request'
  if (/^(?:如果|假如|假设|比如|例如|举例|hypothetical|for example)/i.test(trimmed)) return 'hypothetical'
  if (/[?？]s*$/.test(trimmed) || /^(?:是否|是不是|要不要|该不该|怎么|如何|为什么|what|should|how|why)/i.test(trimmed)) return 'question'
  if (/^(?:引用|原话|quote)s*[:：]/i.test(trimmed)) return 'quote'
  return 'assertion'
}

function hasExplicitClock(text: string) {
  return /d{1,2}:d{2}|d{1,2}s*(?:点|时)(?:d{1,2}s*分)?/i.test(text)
}

function occurrenceKind(type: ProcessEventType): ScheduleNodeKind | undefined {
  if (type === 'assessment_invite') return 'assessment'
  if (type === 'written_test_invite') return 'written_test'
  if (type === 'interview_invite') return 'interview'
  return undefined
}

function confidence(value: 'high' | 'medium' | 'low') {
  return value
}

function candidateBase(id: string, sourceText: string, level: 'high' | 'medium' | 'low') {
  return {
    id,
    objectConfidence: confidence(level),
    eventConfidence: confidence(level),
    temporalConfidence: confidence(level),
    evidenceRefs: [`web-input:${stableHash(sourceText)}`],
    sourceVersionRefs: [],
  }
}

function operationCandidate(operation: ReturnType<typeof parseProgressUpdate>['executable'][number]): SemanticCandidate | undefined {
  const base = candidateBase(operation.id, operation.sourceText, operation.confidence)

  if (operation.kind === 'upsert_opportunity') {
    if (operation.mode !== 'submitted') return undefined
    return {
      ...base,
      kind: 'application_submitted',
      target: { opportunityId: operation.opportunityId, company: operation.company, role: operation.role },
      occurredAt: operation.occurredAt,
    }
  }

  if (operation.kind === 'process_event') {
    if (operation.completed) {
      const kind = occurrenceKind(operation.eventType)
      if (!kind) return undefined
      return {
        ...base,
        kind: 'occurrence_completed',
        target: {
          opportunityId: operation.opportunityId,
          company: operation.company,
          role: operation.role,
          occurrenceKind: kind,
        },
        occurredAt: operation.occurredAt,
      }
    }
    const duePrecision = operation.dueAt
      ? (hasExplicitClock(operation.sourceText) ? 'datetime' as const : 'date' as const)
      : undefined
    return {
      ...base,
      kind: 'process_event',
      target: { opportunityId: operation.opportunityId, company: operation.company, role: operation.role },
      eventType: operation.eventType,
      occurredAt: operation.occurredAt,
      dueAt: operation.dueAt,
      duePrecision,
      timingMode: operation.timingMode,
      estimatedMinutes: operation.estimatedMinutes,
    }
  }

  if (operation.kind === 'manual_action') {
    return {
      ...base,
      kind: 'manual_action',
      title: operation.title,
      dueAt: operation.dueAt,
      duePrecision: operation.dueAt
        ? (hasExplicitClock(operation.sourceText) ? 'datetime' : 'date')
        : undefined,
      estimatedMinutes: operation.estimatedMinutes,
    }
  }

  if (operation.kind === 'close_opportunity' && /(不投|放弃|不考虑|不继续|退出)/.test(operation.sourceText)) {
    return {
      ...base,
      kind: 'abandon_opportunity',
      target: { opportunityId: operation.opportunityId, company: operation.company, role: operation.role },
      occurredAt: operation.occurredAt,
    }
  }

  return undefined
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

async function optimisticReplace(baselineFingerprint: string, nextSnapshot: Parameters<typeof replaceLocalSnapshotFromCloud>[0]) {
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

export async function submitWebSemanticCapture(
  text: string,
  options: { now?: Date; timezone?: string } = {},
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
  const plan = parseProgressUpdate(trimmed, opportunities, now, references)
  const candidates = plan.executable
    .map(operationCandidate)
    .filter((item): item is SemanticCandidate => Boolean(item))
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
    statementMode: statementMode(trimmed),
    originalText: trimmed,
    contextRefs: [],
    candidates,
  }

  const result = applySemanticIntake(baseline, observation, {
    authorized: true,
    workspaceRevision: `local:${baselineFingerprint}`,
    now,
  })
  const unresolved = plan.unresolved.map((item) => item.reason)
  const ignored = plan.ignored.map((item) => item.reason)

  if (!result.changed) {
    return {
      status: result.status,
      summary: result.summary,
      unresolved,
      ignored,
      decisionRequestIds: result.decisionRequests.map((item) => item.id),
    }
  }

  const committedFingerprint = await optimisticReplace(baselineFingerprint, result.snapshot)
  return {
    status: result.status,
    summary: result.summary,
    unresolved,
    ignored,
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
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date()
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
  const baseline = await exportLocalSnapshot()
  const baselineFingerprint = await fingerprintWorkspace(baseline)
  if (baselineFingerprint !== token.workspaceFingerprint) {
    throw new Error('工作区已有后续变化，无法自动撤销而不影响新数据。')
  }
  const next = applySemanticCompensation(baseline, token.compensation, now)
  return optimisticReplace(baselineFingerprint, next)
}

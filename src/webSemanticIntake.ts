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
  if (/[?？]\s*$/.test(trimmed) || /^(?:是否|是不是|要不要|该不该|怎么|如何|为什么|what|should|how|why)\b/i.test(trimmed)) return 'question'
  if (/^(?:引用|原话|quote)\s*[:：]/i.test(trimmed)) return 'quote'
  return 'assertion'
}

function hasExplicitClock(text: string) {
  return /\b\d{1,2}:\d{2}\b|\d{1,2}\s*(?:点|时)(?:\d{1,2}\s*分)?/i.test(text)
}

function explicitCompletionKind(text: string, mode: SemanticStatementMode): ScheduleNodeKind | undefined {
  if (mode !== 'assertion' && mode !== 'current_intent') return undefined
  const trimmed = text.trim()
  if (/(?:完成时间|完成日期|完成期限|完成要求|截止|最晚|请|需要|需|待).{0,12}(?:面试|笔试|测评)/.test(trimmed)) return undefined
  const patterns: Array<[ScheduleNodeKind, RegExp]> = [
    ['interview', /(?:面试|一面|二面|三面|终面|AI面|业务面|HR面).{0,8}(?:已经|已|刚刚?|刚)?(?:完成(?:了)?|结束(?:了)?|面完(?:了)?|完毕)|(?:完成(?:了)?|结束(?:了)?|面完(?:了)?).{0,8}(?:面试|一面|二面|三面|终面|AI面|业务面|HR面)/i],
    ['written_test', /(?:笔试|考试).{0,8}(?:已经|已|刚刚?|刚)?(?:完成(?:了)?|做完(?:了)?|考完(?:了)?|结束(?:了)?|完毕)|(?:完成(?:了)?|做完(?:了)?|考完(?:了)?).{0,8}(?:笔试|考试)/i],
    ['assessment', /(?:测评|在线测试|性格测试).{0,8}(?:已经|已|刚刚?|刚)?(?:完成(?:了)?|做完(?:了)?|结束(?:了)?|完毕)|(?:完成(?:了)?|做完(?:了)?).{0,8}(?:测评|在线测试|性格测试)/i],
  ]
  return patterns.find(([, pattern]) => pattern.test(trimmed))?.[0]
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
      const completedBase = candidateBase(operation.id, operation.sourceText, 'high')
      return {
        ...completedBase,
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

function unresolvedCandidate(
  operation: ReturnType<typeof parseProgressUpdate>['unresolved'][number],
  opportunities: Awaited<ReturnType<typeof getAllOpportunities>>,
): SemanticCandidate | undefined {
  const ids = operation.candidates?.map((item) => item.id) ?? []
  const matched = ids
    .map((id) => opportunities.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
  if (matched.length < 2) return undefined
  const companies = [...new Set(matched.map((item) => item.company))]
  if (companies.length !== 1) return undefined

  const base = candidateBase(`semantic-${operation.id}`, operation.sourceText, 'high')
  const target = { company: companies[0] }
  if (/(?:不投|放弃|不考虑|不继续|退出)/.test(operation.sourceText)) {
    return { ...base, kind: 'abandon_opportunity', target, occurredAt: operation.occurredAt }
  }
  if (/(?:投递|已投|申请)/.test(operation.sourceText)) {
    return { ...base, kind: 'application_submitted', target, occurredAt: operation.occurredAt }
  }
  if (/(?:笔试).*(?:完成|做完|结束)|(?:完成|做完|结束).*(?:笔试)/.test(operation.sourceText)) {
    return {
      ...base,
      kind: 'occurrence_completed',
      target: { ...target, occurrenceKind: 'written_test' },
      occurredAt: operation.occurredAt,
    }
  }
  if (/(?:面试).*(?:完成|结束)|(?:完成|结束).*(?:面试)/.test(operation.sourceText)) {
    return {
      ...base,
      kind: 'occurrence_completed',
      target: { ...target, occurrenceKind: 'interview' },
      occurredAt: operation.occurredAt,
    }
  }
  if (/(?:测评).*(?:完成|做完|结束)|(?:完成|做完|结束).*(?:测评)/.test(operation.sourceText)) {
    return {
      ...base,
      kind: 'occurrence_completed',
      target: { ...target, occurrenceKind: 'assessment' },
      occurredAt: operation.occurredAt,
    }
  }
  return undefined
}

function operationOpportunityIds(plan: ReturnType<typeof parseProgressUpdate>) {
  const ids = new Set<string>()
  for (const operation of plan.operations) {
    if ('opportunityId' in operation && typeof operation.opportunityId === 'string') ids.add(operation.opportunityId)
    if (operation.kind === 'unresolved') {
      for (const candidate of operation.candidates ?? []) ids.add(candidate.id)
    }
  }
  return [...ids]
}

function explicitCompletionCandidate(
  text: string,
  mode: SemanticStatementMode,
  plan: ReturnType<typeof parseProgressUpdate>,
  opportunities: Awaited<ReturnType<typeof getAllOpportunities>>,
  baseline: Awaited<ReturnType<typeof exportLocalSnapshot>>,
): SemanticCandidate | undefined {
  const kind = explicitCompletionKind(text, mode)
  if (!kind) return undefined

  const ids = operationOpportunityIds(plan)
  const exactMentions = opportunities
    .filter((item) => text.includes(item.company) && text.includes(item.role))
    .map((item) => item.id)
  const candidateIds = [...new Set([...ids, ...exactMentions])]
  const activeNodes = [...(baseline.data.scheduleNodes ?? [])]
    .filter((node) => node.kind === kind)
    .filter((node) => node.state !== 'completed' && node.state !== 'cancelled' && node.state !== 'superseded')
  const latestByOccurrence = new Map<string, typeof activeNodes[number]>()
  for (const node of activeNodes) {
    const current = latestByOccurrence.get(node.occurrenceId)
    if (!current || node.version > current.version) latestByOccurrence.set(node.occurrenceId, node)
  }
  let nodes = [...latestByOccurrence.values()]
  if (candidateIds.length === 1) nodes = nodes.filter((node) => node.opportunityId === candidateIds[0])

  const target = candidateIds.length === 1
    ? { opportunityId: candidateIds[0], occurrenceKind: kind }
    : nodes.length === 1
      ? { occurrenceId: nodes[0]!.occurrenceId, occurrenceKind: kind }
      : { occurrenceKind: kind }

  return {
    ...candidateBase('explicit-completion:' + stableHash(text), text, 'high'),
    kind: 'occurrence_completed',
    target,
    occurredAt: plan.operations[0]?.occurredAt,
  }
}

export function buildWebSemanticInterpretation(
  text: string,
  opportunities: Awaited<ReturnType<typeof getAllOpportunities>>,
  baseline: Awaited<ReturnType<typeof exportLocalSnapshot>>,
  references: CanonicalJobReference[],
  now = new Date(),
) {
  const mode = statementMode(text)
  const plan = parseProgressUpdate(text, opportunities, now, references)
  const explicitCompletion = explicitCompletionCandidate(text, mode, plan, opportunities, baseline)
  let executableCandidates = plan.executable
    .map(operationCandidate)
    .filter((item): item is SemanticCandidate => Boolean(item))
  if (explicitCompletion) {
    executableCandidates = executableCandidates.filter((item) => item.kind !== 'process_event' && item.kind !== 'occurrence_completed')
    executableCandidates.unshift(explicitCompletion)
  }
  const convertedUnresolved = plan.unresolved
    .map((item) => ({ operation: item, candidate: unresolvedCandidate(item, opportunities) }))
  const candidates = [
    ...executableCandidates,
    ...convertedUnresolved.flatMap((item) => item.candidate ? [item.candidate] : []),
  ]
  return {
    mode,
    candidates: interpretation.candidates,
    unresolved: convertedUnresolved.filter((item) => !item.candidate).map((item) => item.operation.reason),
    ignored: plan.ignored.map((item) => item.reason),
  }
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
    contextRefs: [],
    candidates,
  }

  const result = applySemanticIntake(baseline, observation, {
    authorized: true,
    workspaceRevision: `local:${baselineFingerprint}`,
    now,
  })
  const unresolved = interpretation.unresolved
  const ignored = interpretation.ignored

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

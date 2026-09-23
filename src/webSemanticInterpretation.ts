import { parseProgressUpdate, type CanonicalJobReference } from './progressUpdate.js'
import type {
  Opportunity,
  ProcessEventType,
  ScheduleNodeKind,
  SemanticCandidate,
  SemanticCandidateBase,
  SemanticStatementMode,
} from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function webStatementMode(text: string): SemanticStatementMode {
  const trimmed = text.trim()
  if (/(改写|润色|翻译|重写|rewrite|translate)/i.test(trimmed)) return 'rewrite_request'
  if (/^(?:如果|假如|假设|比如|例如|举例|hypothetical|for example)/i.test(trimmed)) return 'hypothetical'
  if (/[?？]\s*$/.test(trimmed) || /^(?:是否|是不是|要不要|该不该|怎么|如何|为什么|what|should|how|why)\b/i.test(trimmed)) return 'question'
  if (/^(?:引用|原话|quote)\s*[:：]/i.test(trimmed)
    || (/^“[^\n]*”$/.test(trimmed) || /^"[^\n]*"$/.test(trimmed))) return 'quote'
  return 'assertion'
}

// Quoted email/thread context is evidence, not a second current assertion.
// Only explicit quote boundaries are removed; quoted role names inside a
// current statement remain available for identity resolution.
function withoutQuotedContext(text: string) {
  const current: string[] = []
  let excluded = false
  for (const line of text.split(/\r?\n/)) {
    // Email quote headers often precede unprefixed old content. Once a clear
    // boundary appears, later lines cannot safely be treated as current facts.
    if (/^\s*(?:>|[- ]*Original Message[- ]*|[- ]*Forwarded message[- ]*|On .+ wrote:|转发邮件|原始邮件|引用\s*[:：]|原话\s*[:：]|quote\s*[:：])/i.test(line)) { excluded = true; break }
    const inlineQuote = /(?:^|\s)(?:引用|原话|quote)\s*[:：]/i.exec(line)
    if (inlineQuote) {
      current.push(line.slice(0, inlineQuote.index))
      excluded = true
      break
    }
    current.push(line)
  }
  return { text: current.join('\n').trim(), excluded }
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

function candidateBase(
  id: string,
  sourceText: string,
  level: 'high' | 'medium' | 'low',
): SemanticCandidateBase {
  return {
    id,
    objectConfidence: level,
    eventConfidence: level,
    temporalConfidence: level,
    evidenceRefs: ['web-input:' + stableHash(sourceText)],
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
        ...candidateBase(operation.id, operation.sourceText, 'high'),
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
  opportunities: Opportunity[],
): SemanticCandidate | undefined {
  if (/(?:已投递成功|投递成功|申请已提交|申请成功)/.test(operation.sourceText)) {
    const exact = opportunities.filter((item) => operation.sourceText.includes(item.company) && operation.sourceText.includes(item.role))
    if (exact.length === 1) return {
      ...candidateBase('semantic-' + operation.id, operation.sourceText, 'high'),
      kind: 'application_submitted',
      target: { opportunityId: exact[0]!.id, company: exact[0]!.company, role: exact[0]!.role },
      occurredAt: operation.occurredAt,
    }
  }
  const ids = operation.candidates?.map((item) => item.id) ?? []
  const matched = ids
    .map((id) => opportunities.find((item) => item.id === id))
    .filter((item): item is Opportunity => Boolean(item))
  if (matched.length < 2) return undefined
  const companies = [...new Set(matched.map((item) => item.company))]
  if (companies.length !== 1) return undefined

  const base = candidateBase('semantic-' + operation.id, operation.sourceText, 'high')
  const target = { company: companies[0] }
  if (/(?:不投|放弃|不考虑|不继续|退出)/.test(operation.sourceText)) {
    return { ...base, kind: 'abandon_opportunity', target, occurredAt: operation.occurredAt }
  }
  if (/(?:投递|已投|申请)/.test(operation.sourceText)) {
    return { ...base, kind: 'application_submitted', target, occurredAt: operation.occurredAt }
  }
  if (/(?:笔试).*(?:完成|做完|结束)|(?:完成|做完|结束).*(?:笔试)/.test(operation.sourceText)) {
    return { ...base, kind: 'occurrence_completed', target: { ...target, occurrenceKind: 'written_test' }, occurredAt: operation.occurredAt }
  }
  if (/(?:面试).*(?:完成|结束)|(?:完成|结束).*(?:面试)/.test(operation.sourceText)) {
    return { ...base, kind: 'occurrence_completed', target: { ...target, occurrenceKind: 'interview' }, occurredAt: operation.occurredAt }
  }
  if (/(?:测评).*(?:完成|做完|结束)|(?:完成|做完|结束).*(?:测评)/.test(operation.sourceText)) {
    return { ...base, kind: 'occurrence_completed', target: { ...target, occurrenceKind: 'assessment' }, occurredAt: operation.occurredAt }
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
  opportunities: Opportunity[],
  baseline: PJSDASSnapshot,
): SemanticCandidate | undefined {
  const kind = explicitCompletionKind(text, mode)
  if (!kind) return undefined

  const ids = operationOpportunityIds(plan)
  const exactMentions = opportunities
    .filter((item) => text.includes(item.company) && text.includes(item.role))
    .map((item) => item.id)
  const candidateIds = [...new Set([...ids, ...exactMentions])]

  const latestByOccurrence = new Map<string, NonNullable<PJSDASSnapshot['data']['scheduleNodes']>[number]>()
  for (const node of baseline.data.scheduleNodes ?? []) {
    if (node.kind !== kind || node.state === 'completed' || node.state === 'cancelled' || node.state === 'superseded') continue
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

function sameCompletionTarget(a: SemanticCandidate, b: SemanticCandidate) {
  if (a.kind !== 'occurrence_completed') return false
  const aKind = a.target?.occurrenceKind
  const bKind = b.kind === 'process_event' ? occurrenceKind(b.eventType) : b.kind === 'occurrence_completed' ? b.target?.occurrenceKind : undefined
  if (!aKind || aKind !== bKind) return false
  const aOpportunity = a.target?.opportunityId
  const bOpportunity = b.target?.opportunityId
  return !aOpportunity || !bOpportunity || aOpportunity === bOpportunity
}

export function buildWebSemanticInterpretation(
  text: string,
  opportunities: Opportunity[],
  baseline: PJSDASSnapshot,
  references: CanonicalJobReference[],
  now = new Date(),
) {
  const mode = webStatementMode(text)
  if (mode !== 'assertion' && mode !== 'current_intent') {
    return { mode, candidates: [], unresolved: [], ignored: [] }
  }
  const current = withoutQuotedContext(text)
  const plan = parseProgressUpdate(current.text, opportunities, now, references)
  const explicitCompletion = explicitCompletionCandidate(current.text, mode, plan, opportunities, baseline)
  const explicitKind = explicitCompletion?.target?.occurrenceKind
  const executableOperations = explicitCompletion && explicitKind
    ? plan.executable.filter((operation) => explicitCompletionKind(operation.sourceText, mode) !== explicitKind)
    : plan.executable
  let executableCandidates = executableOperations
    .map(operationCandidate)
    .filter((item): item is SemanticCandidate => Boolean(item))

  if (explicitCompletion) {
    executableCandidates = executableCandidates.filter((item) => !sameCompletionTarget(explicitCompletion, item))
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
    candidates,
    unresolved: convertedUnresolved.filter((item) => !item.candidate).map((item) => item.operation.reason),
    ignored: [...plan.ignored.map((item) => item.reason), ...(current.excluded ? ['Quoted thread context was excluded from current facts.'] : [])],
  }
}

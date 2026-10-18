import { readImportedInterviewReschedule } from './boundInterviewReschedule.js'
import { resolveSourceTemporal } from './sourceTemporal.js'
import { readWebPlanningTime } from './webPlanningTime.js'
import { readExplicitStructuredQuotedJob } from './explicitStructuredQuotedJob.js'
import { completedWebRecruitingKind, resolveWebRecruitingTime } from './webRecruitingTime.js'
import { latestScheduleOccurrence } from './scheduleNodes.js'
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

/** Only the explicit outer request selects this source as data. The selected
 * text cannot grant identity, authority or permission to perform operations. */
function explicitlyImportedNotice(text: string) {
  const lines = text.split(/\r?\n/)
  const boundary = lines.findIndex(line => /^\s*(?:>|[- ]*(?:Original Message|Forwarded message)[- ]*\s*$|转发邮件\s*[:：]?\s*$|原始邮件\s*[:：]?\s*$|(?:引用|原话|quote)\s*[:：])/i.test(line))
  if (boundary < 1) return undefined
  const outer = lines.slice(0, boundary).join('\n').trim()
  if (!/^(?:请(?:帮我)?(?:导入|保存|记录)(?:以下|下面|这条|这份|这封|这段)(?:的)?(?:(?:引用|转发)的)?(?:面试|笔试|测评|招聘)(?:通知|邀请|邮件)|(?:please\s+)?(?:import|save|record)\s+(?:the\s+)?(?:following|below|this)\s+(?:(?:quoted|forwarded)\s+)?(?:interview|assessment|test|recruiting)\s+(?:notice|invitation|email))[。.!！:：]?$/i.test(outer)) return undefined
  const first = lines[boundary]!
  let body: string
  if (/^\s*>/.test(first)) {
    const block: string[] = []
    for (const line of lines.slice(boundary)) {
      if (!line.trim()) { block.push(''); continue }
      // An unquoted tail may withdraw or qualify the first-party request.
      if (!/^\s*>/.test(line)) return undefined
      block.push(line.replace(/^\s*>\s?/, ''))
    }
    body = block.join('\n')
  } else if (/^\s*(?:引用|原话|quote)\s*[:：]/i.test(first)) {
    body = [first.replace(/^\s*(?:引用|原话|quote)\s*[:：]\s*/i, ''), ...lines.slice(boundary + 1)].join('\n')
  } else body = lines.slice(boundary + 1).join('\n')
  return { outer, ...withoutQuotedContext(body) }
}

function importedNoticeCandidates(plan: ReturnType<typeof parseProgressUpdate>, baseline: PJSDASSnapshot, now: Date, timezone: string) {
  const candidates: SemanticCandidate[] = []
  const seen = new Map<string, string>()
  const jobKinds = new Map<string, ProcessEventType>()
  for (const operation of plan.executable) {
    if (operation.kind !== 'process_event') return undefined
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const label = operation.eventType === 'interview_invite' ? '面试'
      : operation.eventType === 'written_test_invite' ? '笔试' : '测评'
    const header = new RegExp(`^\\s*${escape(operation.company)}\\s+${escape(operation.role)}\\s+${label}(?:通知|邀请)\\s*[：:，,]?`)
    if (!header.test(operation.sourceText)) return undefined
    // The source timestamp is unknown: no inferred year/relative date/round.
    if (!/20\d{2}[年\/-]\d{1,2}[月\/-]\d{1,2}/.test(operation.sourceText)
      || /今天|明天|后天|昨天|前天|本周|下周|这周|today|tomorrow|yesterday|(?:this|next)\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|改期|改到|改为|调整为|reschedul|[一二三四五六七八九十终]面|第.{1,3}轮|round\s*\d/i.test(operation.sourceText)) return undefined
    const links = [...operation.sourceText.matchAll(/https:\/\/[^\s<>()，,；;。]+/g)].map(match => match[0])
    if (links.length > 1) return undefined
    let joinUrl: string | undefined
    if (links[0]) {
      // Keep adjacent prose visible to remainder validation. This bounded
      // adapter only accepts isolated ASCII URLs; unusual URLs stay unresolved.
      if (!/^[\x21-\x7e]+$/.test(links[0])) return undefined
      try {
        const url = new URL(links[0])
        if (url.username || url.password || url.href.length > 500) return undefined
        joinUrl = url.href
      } catch { return undefined }
    }
    const locations = [...operation.sourceText.matchAll(/(?:地点|location|venue)\s*[:：]\s*([^，,；;。\n]+)/gi)]
    if (locations.length > 1) return undefined
    // Do not erase unrestricted prose under a metadata label: it may say the
    // invitation is an example, another person's, or use a different timezone.
    // Broader postal addresses need their own supported interpretation path.
    if (locations[0] && !/^(?:线上|视频|(?:会议室|Room)\s*[A-Za-z0-9][A-Za-z0-9-]{0,39})$/i.test(locations[0][1]!.trim())) return undefined
    const temporalText = [...links, ...locations.map(location => location[0])]
      .reduce((value, metadata) => value.replace(metadata, ''), operation.sourceText)
    const timeEvidence = temporalText.replace(header, '')
    const meridiems = timeEvidence.match(/上午|下午|(?:am|pm)\b/gi) ?? []
    if (meridiems.length > 1 || /晚上|早上|中午/.test(timeEvidence)) return undefined
    const temporal = resolveSourceTemporal(timeEvidence, { receivedAt: now.toISOString(), timezone, mode: operation.timingMode })
    // A supplied half-day cannot be silently downgraded to a whole-day fact.
    // The current DTO has no half-day representation, so require its clock.
    if (!temporal || temporal.latestStartAt || temporal.shape === 'availability_window'
      || meridiems.length > 0 && temporal.precision !== 'datetime') return undefined
    const weekday = /[（(](?:星期|周)([一二三四五六日天])[）)]/.exec(timeEvidence)
    const day = /(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})/.exec(timeEvidence)
    if (weekday && day && new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))).getUTCDay()
      !== ('一二三四五六日'.indexOf(weekday[1] === '天' ? '日' : weekday[1]!) + 1) % 7) return undefined
    const candidate = operationCandidate(operation)
    if (candidate?.kind !== 'process_event') return undefined
    candidate.temporal = temporal
    candidate.dueAt = temporal.startAt ?? temporal.deadlineAt ?? temporal.date
    candidate.duePrecision = temporal.precision
    candidate.joinUrl = joinUrl
    candidate.location = locations[0]?.[1]?.trim()
    if (candidate.location && candidate.location.length > 200) return undefined
    let remainder = temporalText.replace(header, '')
    for (const location of locations) remainder = remainder.replace(location[0], '')
    remainder = remainder
      .replace(/20\d{2}[年\/-]\d{1,2}[月\/-]\d{1,2}日?/, '')
      .replace(/[（(](?:星期|周)[一二三四五六日天][）)]/, '')
      .replace(/\d{1,2}(?:[:：]|时)\d{2}分?\s*(?:am|pm)?/i, '')
      .replace(/请于|请在|定于|安排于|安排在|时间为|时间|参加|视频|线上|在线|面试|笔试|测评|上午|下午/g, '')
      .replace(operation.timingMode === 'deadline' ? /截止|之前|前|完成/g : /$^/g, '')
      .replace(/[\s，,。.;；：:！!]/g, '')
    if (remainder) return undefined
    const instant = (value?: string) => value ? (Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : value) : ''
    const temporalKey = (value: typeof temporal) => JSON.stringify([value.shape, value.precision,
      instant(value.startAt), instant(value.endAt), instant(value.latestStartAt), instant(value.deadlineAt), value.date ?? '',
      value.precision === 'date' ? value.timezone : ''])
    const factKey = temporalKey(temporal)
    const suppliedMeaning = JSON.stringify([factKey, candidate.location ?? '', joinUrl ?? ''])
    const groupKey = JSON.stringify([operation.opportunityId, operation.eventType])
    if (jobKinds.has(operation.opportunityId) && jobKinds.get(operation.opportunityId) !== operation.eventType) return undefined
    jobKinds.set(operation.opportunityId, operation.eventType)
    if (seen.has(groupKey) && seen.get(groupKey) !== suppliedMeaning) return undefined
    if (seen.has(groupKey)) continue
    seen.set(groupKey, suppliedMeaning)
    const related = baseline.data.processEvents.filter(event => !event.invalidation
      && event.opportunityId === operation.opportunityId && event.type === operation.eventType)
    const nodes = baseline.data.scheduleNodes ?? []
    const exact = related.flatMap(event => {
      const oldNode = nodes.find(node => node.processEventId === event.id)
      const latest = oldNode && latestScheduleOccurrence(nodes, oldNode.occurrenceId)
      const currentTemporal = latest?.temporal ?? event.temporal
      return currentTemporal && temporalKey(currentTemporal) === factKey
        && (candidate.location === undefined || candidate.location === event.location)
        && (joinUrl === undefined || joinUrl === event.joinUrl)
        ? [{ event, occurrenceId: latest?.occurrenceId ?? event.sourceOccurrenceId }] : []
    })
    if (exact.length > 1 || related.length > 0 && (exact.length !== 1 || !exact[0]!.occurrenceId)) return undefined
    const opportunity = baseline.data.opportunities.find(item => item.id === operation.opportunityId)
    const process = baseline.data.processes.find(item => item.opportunityId === operation.opportunityId)
    const initialStages = ['unknown', 'not_applied', 'screening']
    if (!exact.length && (opportunity?.participationStatus === 'abandoned' || process?.participationState === 'abandoned'
      || opportunity && !initialStages.includes(opportunity.processStage)
      || process && !initialStages.includes(process.stage)
      || process?.result && process.result !== 'pending'
      || baseline.data.processEvents.some(event => !event.invalidation && event.opportunityId === operation.opportunityId
        && ['assessment_invite', 'written_test_invite', 'interview_invite', 'offer', 'rejection'].includes(event.type)))) return undefined
    const occurrenceId = exact[0]?.occurrenceId ?? `web-import:notice:${groupKey}:${factKey}`
    if (occurrenceId.length > 320) return undefined
    candidate.target = { ...candidate.target, occurrenceId }
    if (candidates.length >= 12) return undefined
    candidates.push(candidate)
  }
  return candidates
}

function explicitDeadlineInstruction(text: string) {
  return /(?:请|需要|需|须|必须|务必|应当)[^。！？；;\n]*(?:前|之前)\s*完成[^。！？；;\n]*(?:面试|笔试|测评)/.test(text)
}

function explicitCompletionKind(text: string, mode: SemanticStatementMode, opportunities: Opportunity[]): ScheduleNodeKind | undefined {
  if (mode !== 'assertion' && mode !== 'current_intent') return undefined
  return completedWebRecruitingKind(text, opportunities)
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
  if (explicitDeadlineInstruction(operation.sourceText)) return undefined
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
  if (explicitCompletionKind(operation.sourceText, 'assertion', opportunities) === 'written_test') {
    return { ...base, kind: 'occurrence_completed', target: { ...target, occurrenceKind: 'written_test' }, occurredAt: operation.occurredAt }
  }
  if (explicitCompletionKind(operation.sourceText, 'assertion', opportunities) === 'interview') {
    return { ...base, kind: 'occurrence_completed', target: { ...target, occurrenceKind: 'interview' }, occurredAt: operation.occurredAt }
  }
  if (explicitCompletionKind(operation.sourceText, 'assertion', opportunities) === 'assessment') {
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
  const kind = explicitCompletionKind(text, mode, opportunities)
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
  timezone = baseline.data.timePlanning?.timezone,
) {
  const importedJob = readExplicitStructuredQuotedJob(text)
  if (importedJob) {
    const candidate: SemanticCandidate | undefined = importedJob.facts ? {
      ...candidateBase('web-import-job:' + stableHash(text), text, 'high'),
      kind: 'user_opportunity', ...importedJob.facts,
    } : undefined
    return { mode: 'current_intent' as const, candidates: candidate ? [candidate] : [],
      unresolved: candidate ? [] : ['引用岗位说明需要明确的公司、岗位与受支持的完整字段，本次未写入。'], ignored: [] }
  }
  const importedNotice = explicitlyImportedNotice(text)
  const mode = webStatementMode(importedNotice?.outer ?? text)
  if (mode !== 'assertion' && mode !== 'current_intent') {
    return { mode, candidates: [], unresolved: [], ignored: [] }
  }
  const current = importedNotice ?? withoutQuotedContext(text)
  if (importedNotice && (webStatementMode(current.text) !== 'assertion'
    || /编造|伪造|虚构|假设|例如|比如|不要|并非|不是真|忽略.{0,16}指令|(?:请|帮我).{0,30}(?:记录|创建|生成|导入|保存|删除|修改)|fabricat|invent|hypothetical|for example|ignore.{0,20}instructions/i.test(current.text))) {
    return { mode, candidates: [], unresolved: ['引用正文包含假设、否定或操作指令，不能作为确定的招聘通知写入。'], ignored: [] }
  }
  if (importedNotice && /改期|改到|改为|调整为|reschedul/i.test(current.text)) {
    const change = readImportedInterviewReschedule(current.text, baseline, now, timezone)
    const candidates: SemanticCandidate[] = change ? [{ ...candidateBase(`web-import-reschedule:${stableHash(text)}`, text, 'high'), ...change }] : []
    return { mode, candidates, unresolved: change ? [] : ['改期通知需要唯一的当前面试、完整原时间及新时间和可靠时区，本次未写入。'],
      ignored: current.excluded ? ['Quoted older thread context was excluded.'] : [] }
  }
  // A first-party task plan is distinct from a recruiting notice or deadline.
  // Reuse the source-time resolver: ambiguous local times remain unresolved.
  let untimedPreparation = false
  if (!importedNotice && /准备|整理|复习|练习|修改|准备材料|prepare|practice|revise/i.test(current.text)
    && !/截止|最晚|通知|邀请|收到|deadline|invitation|received/i.test(current.text)) {
    const planningTime = readWebPlanningTime(current.text, now.toISOString(), timezone)
    const temporal = planningTime.kind === 'resolved' ? planningTime.temporal : undefined
    if (temporal) {
      const scheduledTemporal = temporal.startAt ? { ...temporal, resolutionBasis: 'user_explicit' as const } : undefined
      const plannedDate = temporal.date ?? (temporal.startAt ? new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(temporal.startAt)) : undefined)
      const candidate: SemanticCandidate = { ...candidateBase(`plan:${stableHash(current.text)}`, current.text, 'high'),
        kind: 'manual_action', title: current.text, plannedDate, scheduledTemporal }
      return { mode, candidates: [candidate], unresolved: [], ignored: current.excluded ? [text] : [] }
    }
    if (planningTime.kind === 'unresolved') {
      return { mode, candidates: [], unresolved: ['任务的时间或可靠时区尚未确定，本次未写入。'], ignored: current.excluded ? [text] : [] }
    }
    // A task without a time claim has no timezone dependency. Preserve the
    // existing general-task parser, including its title and quoted-tail rules.
    untimedPreparation = true
  }
  let plan = parseProgressUpdate(current.text, opportunities, now, references)
  if (importedNotice) {
    if (plan.executable.length === 1 && plan.unresolved.length > 0
      && plan.unresolved.every(item => /^(?:(?:地点|location|venue)\s*[:：]\s*[^；;。\n]+|https:\/\/[^\s<>()；;。]+)$/i.test(item.sourceText.trim()))) {
      plan = { ...plan, executable: [{ ...plan.executable[0]!, sourceText: current.text }], unresolved: [] }
    }
    const unsupported = plan.executable.some(operation => operation.kind !== 'process_event' || operation.completed || operation.confidence !== 'high'
      || !['interview_invite', 'written_test_invite', 'assessment_invite'].includes(operation.eventType))
    const candidates = timezone && !unsupported && !plan.unresolved.length && !plan.ignored.length && plan.executable.length
      ? importedNoticeCandidates(plan, baseline, now, timezone) : undefined
    return { mode, candidates: candidates ?? [], unresolved: candidates ? [] : ['引用通知的岗位、时间、招聘轮次或已有安排仍需核实，本次未写入。'],
      ignored: current.excluded ? ['Quoted older thread context was excluded.'] : [] }
  }
  const conflictingCompletion = current.text.split(/[。！？；;\n]/).some(clause => {
    const completedKind = explicitCompletionKind(clause, mode, opportunities)
    return completedKind && plan.executable.some(operation => operation.kind === 'process_event'
      && occurrenceKind(operation.eventType) === completedKind && explicitDeadlineInstruction(operation.sourceText)
      && clause.includes(operation.company) && clause.includes(operation.role))
  })
  if (conflictingCompletion) return { mode, candidates: [], unresolved: ['同一岗位的完成事实与新的截止义务需要区分具体轮次，本次未写入。'], ignored: [] }
  const explicitCompletion = explicitCompletionCandidate(current.text, mode, plan, opportunities, baseline)
  const explicitKind = explicitCompletion?.target?.occurrenceKind
  const executableOperations = explicitCompletion && explicitKind
    ? plan.executable.filter((operation) => explicitCompletionKind(operation.sourceText, mode, opportunities) !== explicitKind)
    : plan.executable
  const unresolvedTimes: string[] = []
  let executableCandidates = executableOperations
    .map(originalOperation => {
      // The legacy standalone-task adapter manufactures host-midnight dueAt.
      // No time claim means no deadline, regardless of that parser default.
      const operation = untimedPreparation && originalOperation.kind === 'manual_action'
        ? { ...originalOperation, dueAt: undefined } : originalOperation
      const obligation = operation.kind === 'process_event' && explicitDeadlineInstruction(operation.sourceText)
      const candidate = operationCandidate(obligation ? { ...operation, completed: false, timingMode: 'deadline' } : operation)
      if (candidate?.kind === 'occurrence_completed' && !explicitCompletionKind(operation.sourceText, mode, opportunities)) {
        unresolvedTimes.push('完成事实仍需明确的既成证据，本次未写入该事件。')
        return undefined
      }
      if (candidate?.kind !== 'process_event' || !candidate.dueAt) return candidate
      // The legacy progress parser uses the execution host's local clock.
      // Its date cannot cross the semantic boundary as source-time evidence.
      const temporal = operation.kind === 'process_event' ? resolveWebRecruitingTime(operation.sourceText, {
        company: operation.company, role: operation.role, eventType: operation.eventType,
        receivedAt: now.toISOString(), timezone, mode: candidate.timingMode,
      }) : undefined
      if (!temporal) {
        unresolvedTimes.push('招聘事件的时间或可靠时区尚未确定，本次未写入该事件。')
        return undefined
      }
      return { ...candidate, temporal, dueAt: temporal.startAt ?? temporal.deadlineAt ?? temporal.date,
        duePrecision: temporal.precision, temporalConfidence: 'high' as const }
    })
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
    unresolved: [...unresolvedTimes, ...convertedUnresolved.filter((item) => !item.candidate).map((item) => item.operation.reason)],
    ignored: [...plan.ignored.map((item) => item.reason), ...(current.excluded ? ['Quoted thread context was excluded from current facts.'] : [])],
  }
}

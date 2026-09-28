import type { DecisionRequest, DecisionRequestChoice, Opportunity, SemanticCandidate } from './model.js'
import { localDateKey } from './todayBrief.js'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}

/** Presentation only: records and resolution identities are never merged. */
export function groupOpenDecisions(requests: DecisionRequest[]) {
  const groups = new Map<string, DecisionRequest[]>()
  for (const request of requests.filter(item => item.state === 'open')) {
    const binding = request.payloadBinding
    const source = binding?.source
    const candidate = binding?.candidate
    // Only a complete same-source replay can be grouped. Changed choices,
    // bindings or business content must remain separate even at equal counts.
    const key = source?.sourceRecordId && source.sourceId && candidate
      ? JSON.stringify(canonical({ source: { kind: source.kind, sourceId: source.sourceId, sourceRecordId: source.sourceRecordId,
          assertedAt: source.assertedAt, timezone: source.timezone, authorizationGrantId: source.authorizationGrantId },
        statementMode: binding.statementMode, candidate: { ...candidate, sourceVersionRefs: undefined },
        reason: request.reason, choices: request.choices, affectedObjects: request.affectedObjects,
        expiresAt: request.expiresAt, recommendedChoiceId: request.recommendedChoiceId, recommendationBasis: request.recommendationBasis }))
      : request.id
    const group = groups.get(key)
    if (group) group.push(request)
    else groups.set(key, [request])
  }
  return [...groups.values()]
}

function day(value: string | undefined, timezone: string) {
  if (!value) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const instant = new Date(value)
  return Number.isFinite(instant.getTime()) ? localDateKey(instant, timezone) : undefined
}

export function decisionNeedsToday(request: DecisionRequest, now: Date, timezone: string) {
  if (request.state !== 'open' || (request.expiresAt && new Date(request.expiresAt) < now)) return false
  const today = localDateKey(now, timezone)
  if (day(request.expiresAt, timezone) === today) return true
  const binding = request.payloadBinding
  if (binding?.statementMode === 'current_intent' && binding.source?.kind !== 'gmail'
    && day(binding.source?.assertedAt ?? request.createdAt, timezone) === today) return true
  const candidate = binding?.candidate
  if (!candidate) return false
  if (candidate.kind === 'opportunity_deadline') return day(candidate.deadline, timezone) === today
  if (candidate.kind === 'manual_action') return day(candidate.dueAt, timezone) === today
  if (candidate.kind === 'reminder_intent') return day(candidate.triggerAt, timezone) === today
  if (candidate.kind === 'process_event' || candidate.kind === 'occurrence_rescheduled') {
    const temporal = candidate.temporal
    if (temporal) {
      const start = day(temporal.date ?? temporal.startAt ?? temporal.deadlineAt, timezone)
      const end = day(temporal.endAt, timezone)
      return start === today || Boolean(start && end && start <= today && today <= end)
    }
    if (candidate.kind === 'process_event') return day(candidate.dueAt, timezone) === today
  }
  // An old assertion or a newly ingested undated notification is not a task
  // for today. It remains available in the complete decision inbox.
  return false
}

const eventLabels: Record<string, string> = {
  assessment_invite: '测评邀请', written_test_invite: '笔试邀请', interview_invite: '面试邀请',
  application_submitted: '投递记录', opportunity_deadline: '申请截止', occurrence_completed: '完成记录',
  occurrence_cancelled: '取消安排', occurrence_rescheduled: '调整时间', abandon_opportunity: '放弃机会',
  manual_action: '任务', reminder_intent: '提醒', reminder_cancelled: '取消提醒', external_withdrawal: '撤回申请',
  offer_received: '录用进展', rejected: '流程结果', follow_up: '跟进', prep: '准备',
  interview: '面试', assessment: '测评', written_test: '笔试', application_deadline: '申请截止',
}
const reasons: Record<DecisionRequest['reason'], string> = {
  ambiguous_target: '确认对应岗位', ambiguous_occurrence: '确认对应安排', low_confidence: '核对这条进展',
  material_conflict: '核对不一致的信息', shared_governance: '确认共享选择', external_consequence: '确认外部操作',
  missing_required_field: '补充必要信息', target_abandoned: '确认是否恢复机会',
}
function candidateTime(candidate?: SemanticCandidate) {
  if (!candidate) return undefined
  if (candidate.kind === 'process_event' || candidate.kind === 'occurrence_rescheduled') {
    return candidate.temporal?.date ?? candidate.temporal?.startAt ?? candidate.temporal?.deadlineAt
      ?? (candidate.kind === 'process_event' ? candidate.dueAt : undefined)
  }
  if (candidate.kind === 'opportunity_deadline') return candidate.deadline
  if (candidate.kind === 'manual_action') return candidate.dueAt
  if (candidate.kind === 'reminder_intent') return candidate.triggerAt
  return undefined
}
export function presentDecision(request: DecisionRequest, opportunities: Opportunity[], zh: boolean) {
  const binding = request.payloadBinding
  const candidate = binding?.candidate
  const target = candidate?.target
  const exact = target?.opportunityId ? opportunities.find(item => item.id === target.opportunityId) : undefined
  const object = [exact?.company ?? target?.company, exact?.role ?? target?.role].filter(Boolean).join(' · ')
    || (zh ? '对应岗位待确认' : 'Posting to confirm')
  const kind = candidate?.kind === 'process_event' ? candidate.eventType : candidate?.kind
  const event = zh ? eventLabels[kind ?? ''] ?? '求职进展' : kind?.replaceAll('_', ' ') ?? 'Recruiting update'
  const time = candidateTime(candidate)
  const source = binding?.source
  const sourceDay = source?.assertedAt?.slice(0, 10) ?? source?.observedAt?.slice(0, 10) ?? request.createdAt.slice(0, 10)
  const fragment = candidate?.id?.match(/^fragment:(\d+)$/)?.[1]
  const sourceName = source?.kind === 'gmail' ? (zh ? '邮件' : 'Email') : (zh ? '记录' : 'Record')
  return {
    sourceUrl: source?.kind === 'gmail' && /^[a-f0-9]+$/i.test(source.sourceRecordId) ? `https://mail.google.com/mail/u/0/#all/${source.sourceRecordId}` : undefined,
    title: `${zh ? reasons[request.reason] ?? '核对进展' : request.question} · ${event}`,
    context: [object, candidate?.kind === 'manual_action' ? candidate.title : candidate?.kind === 'process_event' ? candidate.notes : undefined, time, `${sourceName} ${sourceDay}`, source?.sourceRecordId ? `#${source.sourceRecordId.slice(-8)}` : '',
      fragment !== undefined ? (zh ? `片段 ${Number(fragment) + 1}` : `Part ${Number(fragment) + 1}`) : ''].filter(Boolean).join(' · '),
  }
}

export function presentChoice(choice: DecisionRequestChoice, zh: boolean) {
  if (!zh) return { label: choice.label, consequence: choice.consequence }
  const resolution = choice.resolution
  if (resolution?.dismiss) return { label: '不记录这条信息', consequence: '保留现有业务状态，并记录你的选择。' }
  if (resolution?.confirm) return { label: '确认这条信息', consequence: '仅执行这条信息对应的更新。' }
  if (resolution?.opportunityId) return { label: choice.label, consequence: '只更新所选岗位。' }
  if (resolution?.occurrenceId) return { label: choice.label.replace(/^(\w+) · /, (_, kind: string) => `${eventLabels[kind] ?? '安排'} · `), consequence: '只更新所选安排。' }
  return { label: choice.label, consequence: choice.consequence }
}

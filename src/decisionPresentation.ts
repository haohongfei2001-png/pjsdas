import { scheduleDisplayTimezone } from './scheduleDisplayTime.js'
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
        reason: request.reason, question: request.question, choices: request.choices, affectedObjects: request.affectedObjects,
        expiresAt: request.expiresAt, recommendedChoiceId: request.recommendedChoiceId, recommendationBasis: request.recommendationBasis }))
      : request.id
    const group = groups.get(key)
    if (group) group.push(request)
    else groups.set(key, [request])
  }
  return [...groups.values()]
}

function day(value: string | undefined, timezone: string, precision?: string) {
  if (!value) return undefined
  // Legacy date-precision facts may carry an ISO timestamp, but its clock is not asserted.
  if (precision === 'date' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
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
  if (candidate.kind === 'opportunity_deadline') return day(candidate.deadline, timezone, candidate.precision) === today
  if (candidate.kind === 'manual_action') return day(candidate.dueAt, timezone, candidate.duePrecision) === today
  if (candidate.kind === 'reminder_intent') return day(candidate.triggerAt, timezone) === today
  if (candidate.kind === 'process_event' || candidate.kind === 'occurrence_rescheduled') {
    const temporal = candidate.temporal
    if (temporal) {
      if (temporal.date) return temporal.date === localDateKey(now, scheduleDisplayTimezone(temporal.timezone, temporal.resolutionBasis, timezone) ?? timezone)
      const start = day(temporal.date ?? temporal.startAt ?? temporal.deadlineAt, timezone)
      const end = day(temporal.endAt, timezone)
      return start === today || Boolean(start && end && start <= today && today <= end)
    }
    if (candidate.kind === 'process_event') return day(candidate.dueAt, timezone, candidate.duePrecision) === today
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
  prep_trigger: '准备提醒', interview: '面试', assessment: '测评', written_test: '笔试', application_deadline: '申请截止',
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
const decisionTranslations: Record<string, string> = {
  'Several opportunities match this input.': '这条信息可能对应多个岗位，请核对来源后选择准确岗位。',
  'No unique existing opportunity matches this input.': '暂时无法确定对应岗位，请补充准确公司和岗位信息。',
  'Several recruiting occurrences match this input.': '这条信息可能对应多个安排，请选择准确的那一次。',
  'No active recruiting occurrence matches this input.': '未找到对应的有效安排，请补充具体是哪次面试、笔试或测评。',
  'Reminder intent needs an exact trigger time or an offset from a datetime ScheduleNode.': '提醒缺少时间，请提供准确触发时间，或相对已定时安排的提前时长。',
  'A relative reminder offset requires an exact datetime ScheduleNode; TodayAction will not invent a clock time.': '相对提醒需要已确定具体时间的安排，不会自动猜测时刻。',
  'Several reminder intents match this cancellation.': '有多个提醒可能对应这次取消，请选择准确的提醒。',
  'No active reminder intent matches this cancellation.': '未找到可取消的对应提醒，请补充准确提醒信息。',
  'Confidence is below the automatic-write threshold.': '信息尚不足以自动记录，请核对来源后决定。',
  'This fact is not confident enough for automatic write. Record it anyway?': '信息尚不足以自动记录；核对来源后，是否仍要记录？',
  'This opportunity participates in shared application governance.': '这个岗位涉及共享投递规则，确认前请核对是否影响其他岗位的选择。',
  'TodayAction will not withdraw an external application automatically.': '不会自动撤回外部申请；这里的选择只记录内部决定。',
  'The source occurrence conflicts with an existing event; use an explicit reschedule or clarify the occurrence.': '来源中的安排与已有记录冲突，请明确改期，或补充准确的安排和时间。',
  'This observation predates a newer process fact. Confirm only if it is an intentional correction.': '这条观察早于已记录的最新进展。只有你确实有意纠正最新进展时，才应确认。',
  'This opportunity is marked abandoned; confirm whether it should be reactivated before recording an application.': '这个岗位已被标记放弃；记录投递前，请确认是否恢复这个机会。',
  'This schedule occurrence is no longer active; confirm the intended occurrence before completing it.': '这次安排已不再有效，标记完成前请确认准确的安排。',
  'This occurrence is already completed or cancelled; confirm before creating another occurrence.': '这次安排已完成或取消；创建另一次安排前，请确认你的意图。',
  'The reminder target is no longer an active schedule node.': '提醒所对应的安排已不再有效。',
  'Confirm this fact': '确认这条信息', 'Do not record it': '不记录这条信息',
  'Do not create reminder': '不创建提醒', 'Do not cancel': '不取消提醒',
  'Keep the existing occurrence': '保留现有安排', 'Keep TodayAction unchanged': '保持现有记录',
  'Record only an internal note later': '稍后仅记录内部备注',
  'Clarify the target': '暂不记录，补充岗位', 'Clarify reminder timing': '暂不创建，补充提醒时间',
  'Clarify the occurrence': '暂不记录，补充具体安排', 'Provide exact reminder time': '暂不创建，补充准确时间',
  'Clarify the reminder': '暂不取消，补充具体提醒', 'Clarify the change': '暂不更改，补充改期信息',
  'Commit the bounded internal update.': '仅执行这条信息对应的内部更新。',
  'Keep the current TodayAction state unchanged.': '保留现有业务状态，并记录你的选择。',
  'Keep the workspace unchanged.': '保留现有业务状态，并记录你的选择。',
  'Keep reminder state unchanged.': '不更改提醒状态，并记录你的选择。',
  'Provide the exact company/role or stable opportunity id.': '本次暂不记录，请另行提供准确公司、岗位或岗位编号。',
  'Provide an exact time or offset.': '本次暂不创建提醒，请另行提供准确时间或提前时长。',
  'Provide which interview, test, or assessment this refers to.': '本次暂不记录，请另行说明对应哪次面试、笔试或测评。',
  'Use an explicit datetime reminder trigger.': '本次暂不创建提醒，请另行提供准确日期和时刻。',
  'Provide the exact reminder intent.': '本次暂不取消提醒，请另行说明具体是哪条提醒。',
  'No internal or external change is made.': '不更改业务记录，也不执行外部操作。',
  'No external withdrawal is performed.': '不会撤回外部申请。',
  'No schedule is replaced.': '不会替换已有安排。',
  'Provide the intended occurrence and corrected time.': '本次暂不更改，请另行提供准确的安排及修正后的时间。',
  'Only this opportunity will be updated.': '只更新所选岗位。',
  'Only this recruiting occurrence will be updated.': '只更新所选安排。',
  'Only this ReminderIntent will be cancelled; the ScheduleNode remains unchanged.': '只取消所选提醒，不改变原有安排。',
}
/** Unknown explanations stay visible: localization must never remove a guard. */
export function decisionText(text: string, zh: boolean) {
  return zh ? decisionTranslations[text] ?? text : text
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
    explanation: decisionText(request.question, zh),
    sourceUrl: source?.kind === 'gmail' && /^[a-f0-9]+$/i.test(source.sourceRecordId) ? `https://mail.google.com/mail/u/0/#all/${source.sourceRecordId}` : undefined,
    title: `${zh ? reasons[request.reason] ?? '核对进展' : request.question} · ${event}`,
    context: [object, candidate?.kind === 'manual_action' ? candidate.title : candidate?.kind === 'process_event' ? candidate.notes : undefined, time, `${sourceName} ${sourceDay}`, source?.sourceRecordId ? `#${source.sourceRecordId.slice(-8)}` : '',
      fragment !== undefined ? (zh ? `片段 ${Number(fragment) + 1}` : `Part ${Number(fragment) + 1}`) : ''].filter(Boolean).join(' · '),
  }
}

export function presentChoice(choice: DecisionRequestChoice, zh: boolean) {
  const consequence = decisionText(choice.consequence, zh)
  let label = decisionText(choice.label, zh)
  if (zh && choice.resolution?.occurrenceId) label = label.replace(/^(\w+) · /, (_, kind: string) => `${eventLabels[kind] ?? '安排'} · `)
  if (zh && choice.resolution?.reminderIntentId) label = label.replace(/^(\w+) · /, (_, purpose: string) => `${({ upcoming: '临近安排提醒', deadline: '截止提醒', prep: '准备提醒', follow_up: '跟进提醒', custom: '自定义提醒' } as Record<string, string>)[purpose] ?? purpose} · `)
  return { label, consequence }
}

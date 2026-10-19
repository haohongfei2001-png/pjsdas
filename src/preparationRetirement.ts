import type { Action, ScheduleNode, SemanticCandidate, TimelineRecord, ReminderIntent, ReminderOutboxRecord, DecisionRequest } from './model.js'

export const PREPARATION_RETIRED_MESSAGE = 'Preparation and preparation-related tasks have been retired. Existing history is retained; applications and recruiting appointments remain available.'
export class PreparationRetiredError extends Error {
  readonly code = 'PREPARATION_RETIRED'
  readonly retryable = false
  constructor() { super(PREPARATION_RETIRED_MESSAGE); this.name = 'PreparationRetiredError' }
}

/** Only call for an explicit task intent/title, never arbitrary job or mail text. */
export function isPreparationTaskText(text: string) {
  const date = '(?:20\\d{2}[年/-]\\d{1,2}[月/-]\\d{1,2}日?|大后天|后天|明天|今天|(?:本|下)周[一二三四五六日天]|day after tomorrow|tomorrow|today|(?:this|next)\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))'
  const clock = '(?:(?:上午|下午|晚上)?\\s*\\d{1,2}(?:[:：]\\d{2}|[点时](?:\\d{1,2}分?)?)|上午|下午|晚上)'
  const task = text.trim().replace(/^(?:事项|待办|其他事项|个人事项|非求职)\s*[:：]\s*/i, '')
    .replace(/^(?:(?:请|帮我|我要|我想|计划|需要)\s*)+/, '')
    .replace(new RegExp(`^(?:${date}\\s*)?(?:${clock}\\s*)?`, 'i'), '')
  if (/^准备\s*(?:投递|申请)/.test(task)
    && !/^准备\s*申请(?:所需|需要的)?(?:材料|资料|简历|作品集)[。.!！]?\s*$/.test(task)) return false
  return /^(?:准备(?:$|\s|[：:｜|]|[^好就绪])|复习|练习|整理(?:材料|简历|面试|作品集)|修改简历|prep(?:are|aration)?\b|practice\b|revise\s+(?:my\s+)?(?:resume|cv)\b)/i.test(task) || /(?:面试|笔试|测评|考试|申请材料|简历)(?:准备|练习|复习)$/.test(task)
    || /^(?:interview|exam|assessment|application|resume|cv)\s+(?:prep(?:aration)?|practice|revision)\b/i.test(task)
}

export function isPreparationAction(action: Action, timeline: readonly TimelineRecord[] = []) {
  // A recruiting event owns its action even if an old row also linked a Prep.
  if (action.processEventId || action.kind === 'apply' || action.kind === 'group_decision') return false
  if (action.kind === 'prep' || action.prepId) return true
  if (action.kind !== 'manual') return false
  if (['用户明确命令', '用户明确计划', '自然语言更新'].includes(action.sourceLabel ?? '') && isPreparationTaskText(action.title)) return true
  if (action.sourceLabel !== '自然语言更新' || !action.id.startsWith('progress-action:')) return false
  const id = `timeline:progress:${action.id.slice('progress-action:'.length)}`
  const source = timeline.find(row => row.id === id && row.kind === 'action_added' && row.source === 'natural_language')
  return Boolean(source?.detail && isPreparationTaskText(source.detail))
}

export function isPreparationNode(node: ScheduleNode, data: { actions: Action[]; timeline?: TimelineRecord[] }) {
  if (['interview', 'written_test', 'assessment'].includes(node.kind)) return false
  if (node.kind === 'prep_trigger') return true
  return node.relatedActionIds.length > 0 && node.relatedActionIds.every(id => {
    const action = data.actions.find(item => item.id === id)
    return Boolean(action && isPreparationAction(action, data.timeline))
  })
}

export function isPreparationCandidate(candidate: SemanticCandidate, context?: {
  actions?: Action[]; timeline?: TimelineRecord[]; scheduleNodes?: ScheduleNode[]; reminderIntents?: ReminderIntent[]
}) {
  if (candidate.kind === 'manual_action' && isPreparationTaskText(candidate.title)
    || candidate.kind === 'reminder_intent' && candidate.purpose === 'prep'
    || candidate.target?.occurrenceKind === 'prep_trigger') return true
  const target = candidate.target
  if (!context || !target || !['reminder_intent', 'reminder_cancelled', 'occurrence_completed', 'occurrence_cancelled', 'occurrence_rescheduled'].includes(candidate.kind)) return false
  const reminder = target.reminderIntentId ? context.reminderIntents?.find(row => row.id === target.reminderIntentId) : undefined
  if (reminder?.purpose === 'prep') return true
  const matches = context.scheduleNodes?.filter(node => target.scheduleNodeId ? node.id === target.scheduleNodeId
    : target.occurrenceId ? node.occurrenceId === target.occurrenceId : reminder ? node.id === reminder.scheduleNodeId : false) ?? []
  const latest = matches.reduce<ScheduleNode | undefined>((prior, node) => !prior || node.version > prior.version ? node : prior, undefined)
  return Boolean(latest && isPreparationNode(latest, { actions: context.actions ?? [], timeline: context.timeline }))
}

/** New bounded operations only. Never apply to snapshots, receipts or Undo. */
export function assertNoPreparationOperations(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const value = raw as Record<string, unknown>
  if (['create_prep', 'update_prep', 'archive_prep'].includes(String(value.kind))) throw new PreparationRetiredError()
  if (value.kind === 'create_manual_action' && typeof value.value === 'object' && value.value && isPreparationTaskText(String((value.value as { title?: unknown }).title ?? ''))) throw new PreparationRetiredError()
  if (value.kind === 'update_manual_action' && typeof value.patch === 'object' && value.patch && isPreparationTaskText(String((value.patch as { title?: unknown }).title ?? ''))) throw new PreparationRetiredError()
  if (Array.isArray(value.operations)) value.operations.forEach(assertNoPreparationOperations)
}

/** Product projection only. Backups, audit, receipt hashes and Undo use raw rows. */
export function withoutPreparationSurfaces<T extends { data: { actions: Action[]; scheduleNodes?: ScheduleNode[]; timeline?: TimelineRecord[]; reminderIntents?: ReminderIntent[]; reminderOutbox?: ReminderOutboxRecord[]; decisionRequests?: DecisionRequest[] } }>(snapshot: T): T {
  // One index for exact legacy provenance; avoid rescanning a large history per task.
  const timelineById = new Map(snapshot.data.timeline?.map(row => [row.id, row]))
  const retired = new Set(snapshot.data.actions.filter(action => {
    const source = timelineById.get(`timeline:progress:${action.id.slice('progress-action:'.length)}`)
    return isPreparationAction(action, source ? [source] : [])
  }).map(action => action.id))
  const retainedActionIds = new Set(snapshot.data.actions.filter(action => !retired.has(action.id)).map(action => action.id))
  const retiredNodeIds = new Set(snapshot.data.scheduleNodes?.filter(node => !['interview', 'written_test', 'assessment'].includes(node.kind)
    && (node.kind === 'prep_trigger' || node.relatedActionIds.length > 0 && node.relatedActionIds.every(id => retired.has(id)))).map(node => node.id))
  // A legacy prep node may still carry canonical negative timing evidence for
  // an ambiguous manual task. Keep that evidence internally so hiding a feature
  // cannot revive its raw date. scheduleNodeEligible still excludes the node.
  const nodes = snapshot.data.scheduleNodes?.filter(node => !retiredNodeIds.has(node.id)
    || node.relatedActionIds.some(id => retainedActionIds.has(id)))
  const retiredReminderIds = new Set(snapshot.data.reminderIntents?.filter(row => row.purpose === 'prep' || retiredNodeIds.has(row.scheduleNodeId)).map(row => row.id))
  const reminders = snapshot.data.reminderIntents?.filter(row => !retiredReminderIds.has(row.id))
  const outbox = snapshot.data.reminderOutbox?.filter(row => !retiredReminderIds.has(row.reminderIntentId))
  const decisions = snapshot.data.decisionRequests?.filter(row => !isPreparationCandidate(row.payloadBinding.candidate, snapshot.data))
  if (!retired.size && nodes?.length === snapshot.data.scheduleNodes?.length
    && reminders?.length === snapshot.data.reminderIntents?.length && outbox?.length === snapshot.data.reminderOutbox?.length && decisions?.length === snapshot.data.decisionRequests?.length) return snapshot
  return { ...snapshot, data: { ...snapshot.data,
    actions: snapshot.data.actions.filter(action => !retired.has(action.id)),
    scheduleNodes: nodes,
    reminderIntents: reminders,
    reminderOutbox: outbox,
    decisionRequests: decisions,
    timeline: snapshot.data.timeline?.filter(row => !row.actionId || !retired.has(row.actionId)),
  } }
}

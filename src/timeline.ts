import type { DecisionRules } from './decisionRules'
import type { ChangeSetRecord } from './changeSet'
import type { ProgressOperation } from './progressUpdate'
import type {
  Action,
  ImportMeta,
  Opportunity,
  ProcessEvent,
  TimelineCategory,
  TimelineChangeValue,
  TimelineFieldChange,
  TimelineRecord,
} from './model'

export const TIMELINE_BACKFILL_MARKER_ID = 'timeline:system:backfill-v1'

function timelineNow(now?: string) {
  return now ?? new Date().toISOString()
}

function processEventTitle(type: ProcessEvent['type'], completed = false) {
  if (completed) {
    if (type === 'assessment_invite') return '完成测评'
    if (type === 'written_test_invite') return '完成笔试'
    if (type === 'interview_invite') return '完成面试'
  }
  if (type === 'assessment_invite') return '收到测评节点'
  if (type === 'written_test_invite') return '收到笔试节点'
  if (type === 'interview_invite') return '收到面试节点'
  if (type === 'offer') return '收到 Offer'
  if (type === 'rejection') return '流程结束'
  if (type === 'status_update') return '流程状态更新'
  return '记录流程事件'
}

export function timelineCategoryFromHistoryType(type: string): TimelineCategory {
  if (/投递|申请|网申/.test(type)) return 'opportunity'
  if (/测评|笔试|面试|流程|offer|录用|结果|筛选/i.test(type)) return 'process'
  if (/准备|简历|材料|作品|复盘|学习|观念/.test(type)) return 'note'
  return 'note'
}

export function stableTimelineHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function timelineFromImportedHistory(input: {
  occurredAt: string
  importedAt: string
  type: string
  relation?: string
  event: string
  result?: string
  learning?: string
  reflection?: string
  opportunity?: Opportunity
  filename?: string
}): TimelineRecord {
  const detailParts = [
    input.result ? `结果：${input.result}` : '',
    input.learning ? `学习/产出：${input.learning}` : '',
    input.reflection ? `复盘：${input.reflection}` : '',
  ].filter(Boolean)
  const signature = [input.occurredAt, input.type, input.relation, input.event, input.result].join('|')
  return {
    id: `timeline:excel-history:${stableTimelineHash(signature)}`,
    kind: 'history_imported',
    category: timelineCategoryFromHistoryType(input.type),
    source: 'excel',
    occurredAt: input.occurredAt,
    recordedAt: input.importedAt,
    title: input.event || input.type || '历史记录',
    detail: detailParts.join('\n') || undefined,
    opportunityId: input.opportunity?.id,
    company: input.opportunity?.company,
    role: input.opportunity?.role,
    sourceRef: input.relation || input.filename,
  }
}

export function timelineFromProcessEvent(
  event: ProcessEvent,
  source: TimelineRecord['source'] = 'process_event',
  recordedAt = new Date().toISOString(),
  completed = false,
): TimelineRecord {
  const detail = [
    event.notes,
    event.dueAt ? `${event.timingMode === 'fixed' ? '固定时间' : '截止'}：${event.dueAt}` : '',
  ].filter(Boolean).join('\n')
  return {
    id: `timeline:process:${event.id}`,
    kind: event.type === 'rejection' ? 'process_closed' : 'process_event_recorded',
    category: 'process',
    source,
    occurredAt: event.occurredAt,
    recordedAt,
    title: processEventTitle(event.type, completed),
    detail: detail || undefined,
    opportunityId: event.opportunityId,
    processEventId: event.id,
    company: event.company,
    role: event.role,
  }
}

export function timelineFromDeletedProcessEvent(event: ProcessEvent, now = new Date().toISOString()): TimelineRecord {
  return {
    id: `timeline:process-delete:${event.id}:${now}`,
    kind: 'process_event_deleted',
    category: 'process',
    source: 'user_action',
    occurredAt: now,
    recordedAt: now,
    title: '删除错误流程事件',
    detail: event.notes,
    opportunityId: event.opportunityId,
    processEventId: event.id,
    company: event.company,
    role: event.role,
    changes: { processEvent: { before: event.type, after: null } },
  }
}

export function timelineFromActionStatus(
  action: Action,
  before: Action['status'],
  after: Action['status'],
  now = new Date().toISOString(),
): TimelineRecord {
  const actionLabel = after === 'done' ? '完成行动' : after === 'skipped' ? '跳过行动' : after === 'doing' ? '开始行动' : '恢复待办'
  return {
    id: `timeline:action:${stableTimelineHash(`${action.id}|${before}|${after}|${now}`)}`,
    kind: 'action_status_changed',
    category: 'action',
    source: 'user_action',
    occurredAt: now,
    recordedAt: now,
    title: `${actionLabel}｜${action.title}`,
    opportunityId: action.opportunityId,
    actionId: action.id,
    processEventId: action.processEventId,
    changes: { status: { before, after } },
  }
}

function flattenRules(rules: DecisionRules): Record<string, TimelineChangeValue> {
  return {
    hardDeadlineHorizonHours: rules.hardDeadlineHorizonHours,
    fixedEventHorizonHours: rules.fixedEventHorizonHours,
    nearDeadlineStretchMinutes: rules.nearDeadlineStretchMinutes,
    followUpDailyCap: rules.followUpDailyCap,
    prepDailyCap: rules.prepDailyCap,
    upcomingHorizonDays: rules.upcomingHorizonDays,
    upcomingNodeLimit: rules.upcomingNodeLimit,
    riskCriticalHours: rules.riskCriticalHours,
    riskHighHours: rules.riskHighHours,
    riskNearHours: rules.riskNearHours,
    riskWatchHours: rules.riskWatchHours,
    'weights.opportunity': rules.weights.opportunity,
    'weights.fit': rules.weights.fit,
    'weights.urgency': rules.weights.urgency,
    'weights.stage': rules.weights.stage,
    'weights.leverage': rules.weights.leverage,
    'weights.delayCost': rules.weights.delayCost,
    'weights.timeEfficiency': rules.weights.timeEfficiency,
  }
}

export function decisionRuleChanges(before: DecisionRules, after: DecisionRules) {
  const beforeFlat = flattenRules(before)
  const afterFlat = flattenRules(after)
  const changes: Record<string, TimelineFieldChange> = {}
  for (const key of Object.keys(afterFlat)) {
    if (beforeFlat[key] !== afterFlat[key]) changes[key] = { before: beforeFlat[key], after: afterFlat[key] }
  }
  return changes
}

export function timelineFromRuleChange(
  before: DecisionRules,
  after: DecisionRules,
  mode: 'save' | 'reset',
): TimelineRecord | undefined {
  const changes = decisionRuleChanges(before, after)
  if (Object.keys(changes).length === 0) return undefined
  return {
    id: `timeline:rules:${after.updatedAt}`,
    kind: 'rules_changed',
    category: 'rules',
    source: 'rules',
    occurredAt: after.updatedAt,
    recordedAt: after.updatedAt,
    title: mode === 'reset' ? '恢复推荐决策规则' : '修改决策规则',
    detail: `${Object.keys(changes).length} 项参数发生变化`,
    changes,
  }
}

export function timelineFromProgressOperation(
  operation: ProgressOperation,
  beforeOpportunity?: Opportunity,
): TimelineRecord | undefined {
  if (operation.kind === 'unresolved' || operation.kind === 'ignored') return undefined
  const base = {
    id: `timeline:progress:${operation.id}`,
    source: 'natural_language' as const,
    occurredAt: operation.occurredAt,
    recordedAt: new Date().toISOString(),
    detail: operation.sourceText,
  }

  if (operation.kind === 'upsert_opportunity') {
    if (operation.mode === 'submitted') {
      return {
        ...base,
        kind: 'application_submitted',
        category: 'opportunity',
        title: '完成投递',
        opportunityId: operation.opportunityId,
        company: operation.company,
        role: operation.role,
        changes: { stage: { before: beforeOpportunity?.processStage ?? null, after: 'screening' } },
      }
    }
    return {
      ...base,
      kind: beforeOpportunity ? 'opportunity_updated' : 'opportunity_added',
      category: 'opportunity',
      title: beforeOpportunity ? '更新机会' : '新增机会',
      opportunityId: operation.opportunityId,
      company: operation.company,
      role: operation.role,
    }
  }

  if (operation.kind === 'rename_opportunity') {
    return {
      ...base,
      kind: 'opportunity_renamed',
      category: 'opportunity',
      title: '岗位名称变更',
      opportunityId: operation.opportunityId,
      company: operation.company,
      role: operation.newRole,
      changes: { role: { before: operation.oldRole, after: operation.newRole } },
    }
  }

  if (operation.kind === 'close_opportunity') {
    return {
      ...base,
      kind: 'process_closed',
      category: 'process',
      title: '流程结束',
      opportunityId: operation.opportunityId,
      company: operation.company,
      role: operation.role,
      changes: { stage: { before: beforeOpportunity?.processStage ?? null, after: 'closed' } },
    }
  }

  if (operation.kind === 'process_event') {
    return {
      ...base,
      kind: operation.eventType === 'rejection' ? 'process_closed' : 'process_event_recorded',
      category: 'process',
      title: processEventTitle(operation.eventType, Boolean(operation.completed)),
      opportunityId: operation.opportunityId,
      company: operation.company,
      role: operation.role,
      sourceRef: operation.dueAt,
    }
  }

  return {
    ...base,
    kind: 'action_added',
    category: 'action',
    title: `新增行动｜${operation.title}`,
    sourceRef: operation.dueAt,
  }
}

export function timelineFromImport(meta: ImportMeta, historyCount = 0): TimelineRecord {
  return {
    id: `timeline:import:${meta.importedAt}`,
    kind: 'excel_imported',
    category: 'data',
    source: 'excel',
    occurredAt: meta.importedAt,
    recordedAt: meta.importedAt,
    title: '导入 Excel 基线',
    detail: `${meta.opportunities} 个岗位 · ${meta.processes} 个流程${historyCount ? ` · ${historyCount} 条历史记录` : ''}`,
    sourceRef: meta.filename,
  }
}

export function timelineFromRestore(snapshotExportedAt: string, now = new Date().toISOString()): TimelineRecord {
  return {
    id: `timeline:restore:${now}`,
    kind: 'backup_restored',
    category: 'data',
    source: 'backup',
    occurredAt: now,
    recordedAt: now,
    title: '恢复本地备份',
    detail: `恢复的快照导出于 ${snapshotExportedAt}`,
  }
}

export function timelineBackfillMarker(now = new Date().toISOString()): TimelineRecord {
  return {
    id: TIMELINE_BACKFILL_MARKER_ID,
    kind: 'baseline_backfill',
    category: 'data',
    source: 'system',
    occurredAt: now,
    recordedAt: now,
    title: 'Timeline 初始化',
    detail: '从升级前仍可验证的本地事实保守回填。',
  }
}

export function buildTimelineBackfill(input: {
  processEvents: ProcessEvent[]
  actions: Action[]
  lastImport?: ImportMeta
  decisionRules?: DecisionRules
  now?: string
}) {
  const now = timelineNow(input.now)
  const records: TimelineRecord[] = []
  for (const event of input.processEvents) records.push(timelineFromProcessEvent(event, 'process_event', event.updatedAt))
  for (const action of input.actions) {
    if (action.status !== 'done' && action.status !== 'skipped') continue
    records.push({
      ...timelineFromActionStatus(action, 'todo', action.status, action.updatedAt),
      id: `timeline:backfill-action:${action.id}:${action.status}`,
      source: 'system',
    })
  }
  if (input.lastImport) records.push(timelineFromImport(input.lastImport))
  if (input.decisionRules && input.decisionRules.updatedAt !== '1970-01-01T00:00:00.000Z') {
    records.push({
      id: `timeline:backfill-rules:${input.decisionRules.updatedAt}`,
      kind: 'rules_changed',
      category: 'rules',
      source: 'system',
      occurredAt: input.decisionRules.updatedAt,
      recordedAt: now,
      title: '现有决策规则',
      detail: '升级时保留当前规则状态；更早的逐次修改历史无法从旧数据库可靠重建。',
    })
  }
  records.push(timelineBackfillMarker(now))
  return records
}


export function timelineFromChangeSetApplied(changeSet: ChangeSetRecord): TimelineRecord {
  const occurredAt = changeSet.appliedAt ?? changeSet.updatedAt
  return {
    id: `timeline:changeset:${changeSet.id}`,
    kind: 'change_set_applied',
    category: 'change',
    source: 'changeset',
    occurredAt,
    recordedAt: occurredAt,
    title: `应用 ChangeSet｜${changeSet.title}`,
    detail: changeSet.operations.map((operation) => operation.summary).join('\n'),
    changeSetId: changeSet.id,
    sourceRef: changeSet.source,
  }
}

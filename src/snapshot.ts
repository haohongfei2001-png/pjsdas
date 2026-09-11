import type {
  Action,
  ApplicationGroup,
  ImportMeta,
  Opportunity,
  Prep,
  ProcessEvent,
  ProcessRecord,
  TimelineRecord,
} from './model.js'
import { validateDecisionRules, type DecisionRules } from './decisionRules.js'
import { validateChangeSet, type ChangeSetRecord } from './changeSet.js'

export const SNAPSHOT_SCHEMA = 'pjsdas-local-snapshot' as const
export const SNAPSHOT_VERSION = 1 as const

export interface SnapshotData {
  opportunities: Opportunity[]
  processes: ProcessRecord[]
  processEvents: ProcessEvent[]
  actions: Action[]
  prep: Prep[]
  applicationGroups: ApplicationGroup[]
  decisionRules?: DecisionRules
  timeline?: TimelineRecord[]
  changeSets?: ChangeSetRecord[]
  meta?: ImportMeta
}

export interface PJSDASSnapshot {
  schema: typeof SNAPSHOT_SCHEMA
  version: typeof SNAPSHOT_VERSION
  exportedAt: string
  data: SnapshotData
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertArray(value: unknown, name: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`备份损坏：${name} 不是数组。`)
}

function assertStringId(value: unknown, label: string) {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id.trim()) {
    throw new Error(`备份损坏：${label} 存在无效 ID。`)
  }
}

function assertUniqueIds(items: unknown[], label: string) {
  const seen = new Set<string>()
  for (const item of items) {
    assertStringId(item, label)
    const id = (item as { id: string }).id
    if (seen.has(id)) throw new Error(`备份损坏：${label} ID 重复（${id}）。`)
    seen.add(id)
  }
  return seen
}

function assertIsoDate(value: unknown, label: string) {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`备份损坏：${label} 不是有效时间。`)
  }
}

export function createSnapshot(data: SnapshotData, exportedAt = new Date().toISOString()): PJSDASSnapshot {
  const snapshot: PJSDASSnapshot = {
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    exportedAt,
    data,
  }
  validateSnapshot(snapshot)
  return snapshot
}

export function validateSnapshot(value: unknown): asserts value is PJSDASSnapshot {
  if (!isObject(value)) throw new Error('备份损坏：根对象无效。')
  if (value.schema !== SNAPSHOT_SCHEMA) throw new Error('这不是 PJSDAS 本地备份。')
  if (value.version !== SNAPSHOT_VERSION) {
    throw new Error(`不支持的备份版本：${String(value.version)}。当前仅支持 v${SNAPSHOT_VERSION}。`)
  }
  assertIsoDate(value.exportedAt, 'exportedAt')
  if (!isObject(value.data)) throw new Error('备份损坏：缺少 data。')

  const data = value.data
  assertArray(data.opportunities, 'opportunities')
  assertArray(data.processes, 'processes')
  assertArray(data.processEvents, 'processEvents')
  assertArray(data.actions, 'actions')
  assertArray(data.prep, 'prep')
  assertArray(data.applicationGroups, 'applicationGroups')
  if (data.timeline !== undefined) assertArray(data.timeline, 'timeline')
  if (data.changeSets !== undefined) assertArray(data.changeSets, 'changeSets')
  if (data.decisionRules !== undefined) {
    if (!isObject(data.decisionRules)) throw new Error('备份损坏：decisionRules 格式无效。')
    const errors = validateDecisionRules(data.decisionRules as unknown as DecisionRules)
    if (errors.length) throw new Error(`备份损坏：决策规则无效（${errors[0]}）`)
  }

  const opportunityIds = assertUniqueIds(data.opportunities, 'Opportunity')
  const processIds = assertUniqueIds(data.processes, 'Process')
  const eventIds = assertUniqueIds(data.processEvents, 'Process Event')
  const actionIds = assertUniqueIds(data.actions, 'Action')
  const prepIds = assertUniqueIds(data.prep, 'Prep')
  const groupIds = assertUniqueIds(data.applicationGroups, 'Application Group')
  if (data.timeline) assertUniqueIds(data.timeline, 'Timeline')
  if (data.changeSets) assertUniqueIds(data.changeSets, 'ChangeSet')
  void processIds
  void actionIds
  void prepIds

  for (const raw of data.opportunities) {
    const opportunity = raw as Opportunity
    if (!opportunity.company?.trim() || !opportunity.role?.trim()) {
      throw new Error(`备份损坏：岗位 ${opportunity.id} 缺少公司或岗位名称。`)
    }
    if (opportunity.applicationGroupId && !groupIds.has(opportunity.applicationGroupId)) {
      throw new Error(`备份损坏：岗位 ${opportunity.id} 引用了不存在的申请组 ${opportunity.applicationGroupId}。`)
    }
  }

  for (const raw of data.processes) {
    const process = raw as ProcessRecord
    if (process.opportunityId && !opportunityIds.has(process.opportunityId)) {
      throw new Error(`备份损坏：流程 ${process.id} 引用了不存在的岗位 ${process.opportunityId}。`)
    }
  }

  // Process Events are durable historical facts. If a later Excel import removes
  // an old opportunity, the event may intentionally become archival/orphaned.
  // It still carries company/role text and must remain backup-safe, but it will
  // no longer project into current decisions because no active Opportunity exists.
  for (const raw of data.processEvents) {
    const event = raw as ProcessEvent
    if (!event.opportunityId?.trim() || !event.company?.trim() || !event.role?.trim()) {
      throw new Error(`备份损坏：流程事件 ${event.id} 缺少岗位身份信息。`)
    }
    assertIsoDate(event.occurredAt, `流程事件 ${event.id} 的 occurredAt`)
    if (event.dueAt) assertIsoDate(event.dueAt, `流程事件 ${event.id} 的 dueAt`)
  }

  if (data.timeline) {
    const categories = new Set(['opportunity', 'process', 'action', 'rules', 'change', 'data', 'note'])
    const sources = new Set(['excel', 'natural_language', 'process_event', 'user_action', 'rules', 'backup', 'system', 'changeset'])
    for (const raw of data.timeline) {
      const item = raw as TimelineRecord
      if (!item.title?.trim() || !categories.has(item.category) || !sources.has(item.source)) {
        throw new Error(`备份损坏：Timeline ${item.id} 的基础字段无效。`)
      }
      assertIsoDate(item.occurredAt, `Timeline ${item.id} 的 occurredAt`)
      assertIsoDate(item.recordedAt, `Timeline ${item.id} 的 recordedAt`)
    }
  }

  if (data.changeSets) {
    for (const raw of data.changeSets) {
      const errors = validateChangeSet(raw)
      if (errors.length) throw new Error(`备份损坏：ChangeSet 无效（${errors[0]}）`)
    }
  }

  for (const raw of data.actions) {
    const action = raw as Action
    if (action.processEventId && !eventIds.has(action.processEventId)) {
      throw new Error(`备份损坏：Action ${action.id} 引用了不存在的流程事件 ${action.processEventId}。`)
    }
    if (action.opportunityId && !opportunityIds.has(action.opportunityId) && !action.processEventId) {
      throw new Error(`备份损坏：Action ${action.id} 引用了不存在的岗位 ${action.opportunityId}。`)
    }
    if (action.applicationGroupId && !groupIds.has(action.applicationGroupId)) {
      throw new Error(`备份损坏：Action ${action.id} 引用了不存在的申请组 ${action.applicationGroupId}。`)
    }
  }

  if (data.meta !== undefined) {
    if (!isObject(data.meta) || data.meta.key !== 'lastImport') {
      throw new Error('备份损坏：meta 格式无效。')
    }
  }
}

export function parseSnapshotText(text: string): PJSDASSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('无法解析备份文件：JSON 格式无效。')
  }
  validateSnapshot(parsed)
  return parsed
}

import type {
  Action,
  ApplicationGroup,
  DiscoveryInboxItem,
  ImportMeta,
  IngestionLedgerEntry,
  IngestionOutcome,
  IngestionRunSummary,
  Opportunity,
  Prep,
  ProcessEvent,
  ProcessRecord,
  TimelineRecord,
} from './model.js'
import { validateDecisionRules, type DecisionRules } from './decisionRules.js'
import { validateChangeSet, type ChangeSetRecord } from './changeSet.js'
import { validateDiscoveryProfile, type DiscoveryProfile } from './discoveryProfile.js'
import { validateDiscoveryInboxItem } from './discoveryInbox.js'
import { validateJobPostingEvidence } from './jobPosting.js'
import { validateOpportunityAssessment } from './opportunityAssessment.js'
import { validateOpportunityFacts } from './richOpportunity.js'

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
  discoveryProfile?: DiscoveryProfile
  discoveryInbox?: DiscoveryInboxItem[]
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

const INGESTION_SOURCE_KINDS = new Set(['gpt_monitor', 'gmail', 'natural_language', 'manual'])
const INGESTION_RECORD_TYPES = new Set(['job_observation', 'recruiting_message'])
const INGESTION_OUTCOMES = new Set<IngestionOutcome>([
  'created', 'merged', 'updated', 'duplicate', 'filtered', 'ignored', 'unresolved',
])

function validateIngestionEntry(entry: IngestionLedgerEntry, timelineId: string) {
  if (entry.version !== 1) throw new Error(`备份损坏：Timeline ${timelineId} 的 ingestion 版本无效。`)
  if (!INGESTION_SOURCE_KINDS.has(entry.sourceKind)) throw new Error(`备份损坏：Timeline ${timelineId} 的 ingestion sourceKind 无效。`)
  if (!entry.sourceId?.trim() || !entry.sourceRecordId?.trim() || !entry.runId?.trim() || !entry.fingerprint?.trim()) {
    throw new Error(`备份损坏：Timeline ${timelineId} 的 ingestion 身份字段不完整。`)
  }
  if (!INGESTION_RECORD_TYPES.has(entry.recordType)) throw new Error(`备份损坏：Timeline ${timelineId} 的 ingestion recordType 无效。`)
  if (!INGESTION_OUTCOMES.has(entry.outcome)) throw new Error(`备份损坏：Timeline ${timelineId} 的 ingestion outcome 无效。`)
  assertIsoDate(entry.receivedAt, `Timeline ${timelineId} ingestion.receivedAt`)
  assertIsoDate(entry.accountedAt, `Timeline ${timelineId} ingestion.accountedAt`)
}

function validateIngestionRun(run: IngestionRunSummary, timelineId: string) {
  if (run.version !== 1) throw new Error(`备份损坏：Timeline ${timelineId} 的 ingestionRun 版本无效。`)
  if (!INGESTION_SOURCE_KINDS.has(run.sourceKind) || !run.runId?.trim() || !run.sourceId?.trim()) {
    throw new Error(`备份损坏：Timeline ${timelineId} 的 ingestionRun 身份无效。`)
  }
  assertIsoDate(run.startedAt, `Timeline ${timelineId} ingestionRun.startedAt`)
  assertIsoDate(run.completedAt, `Timeline ${timelineId} ingestionRun.completedAt`)
  if (!Number.isInteger(run.receivedCount) || run.receivedCount < 0 || !Number.isInteger(run.accountedCount) || run.accountedCount < 0) {
    throw new Error(`备份损坏：Timeline ${timelineId} 的 ingestionRun 计数无效。`)
  }
  let outcomeTotal = 0
  for (const [key, value] of Object.entries(run.outcomes)) {
    if (!INGESTION_OUTCOMES.has(key as IngestionOutcome) || !Number.isInteger(value) || Number(value) < 0) {
      throw new Error(`备份损坏：Timeline ${timelineId} 的 ingestionRun outcome 计数无效。`)
    }
    outcomeTotal += Number(value)
  }
  if (outcomeTotal !== run.accountedCount || run.accountedCount !== run.receivedCount) {
    throw new Error(`备份损坏：Timeline ${timelineId} ingestionRun 未守恒（received=${run.receivedCount}, accounted=${run.accountedCount}, outcomes=${outcomeTotal}）。`)
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
  if (data.discoveryInbox !== undefined) assertArray(data.discoveryInbox, 'discoveryInbox')
  if (data.timeline !== undefined) assertArray(data.timeline, 'timeline')
  if (data.changeSets !== undefined) assertArray(data.changeSets, 'changeSets')
  if (data.decisionRules !== undefined) {
    if (!isObject(data.decisionRules)) throw new Error('备份损坏：decisionRules 格式无效。')
    const errors = validateDecisionRules(data.decisionRules as unknown as DecisionRules)
    if (errors.length) throw new Error(`备份损坏：决策规则无效（${errors[0]}）`)
  }
  if (data.discoveryProfile !== undefined) {
    if (!isObject(data.discoveryProfile)) throw new Error('备份损坏：discoveryProfile 格式无效。')
    const errors = validateDiscoveryProfile(data.discoveryProfile as unknown as DiscoveryProfile)
    if (errors.length) throw new Error(`备份损坏：岗位发现偏好无效（${errors[0]}）`)
  }

  const opportunityIds = assertUniqueIds(data.opportunities, 'Opportunity')
  const processIds = assertUniqueIds(data.processes, 'Process')
  const eventIds = assertUniqueIds(data.processEvents, 'Process Event')
  const actionIds = assertUniqueIds(data.actions, 'Action')
  const prepIds = assertUniqueIds(data.prep, 'Prep')
  const groupIds = assertUniqueIds(data.applicationGroups, 'Application Group')
  if (data.discoveryInbox) assertUniqueIds(data.discoveryInbox, 'Discovery Inbox')
  if (data.timeline) assertUniqueIds(data.timeline, 'Timeline')
  if (data.changeSets) assertUniqueIds(data.changeSets, 'ChangeSet')
  void processIds
  void actionIds
  void prepIds

  for (const raw of data.discoveryInbox ?? []) {
    const item = raw as DiscoveryInboxItem
    const errors = validateDiscoveryInboxItem(item)
    if (errors.length) throw new Error(`备份损坏：发现箱条目无效（${errors[0]}）`)
  }

  for (const raw of data.opportunities) {
    const opportunity = raw as Opportunity
    if (!opportunity.company?.trim() || !opportunity.role?.trim()) {
      throw new Error(`备份损坏：岗位 ${opportunity.id} 缺少公司或岗位名称。`)
    }
    if (opportunity.applicationGroupId && !groupIds.has(opportunity.applicationGroupId)) {
      throw new Error(`备份损坏：岗位 ${opportunity.id} 引用了不存在的申请组 ${opportunity.applicationGroupId}。`)
    }
    const facts = opportunity.detail?.facts
    if (facts) {
      const errors = validateOpportunityFacts(facts)
      if (errors.length) throw new Error(`备份损坏：岗位 ${opportunity.id} 的 Rich Opportunity facts 无效（${errors[0]}）`)
    }
    const assessment = opportunity.detail?.assessment
    if (assessment) {
      const errors = validateOpportunityAssessment(assessment)
      if (errors.length) throw new Error(`备份损坏：岗位 ${opportunity.id} 的组件评估无效（${errors[0]}）`)
    }
    const discovery = opportunity.detail?.discovery
    if (discovery?.posting) {
      const errors = validateJobPostingEvidence(discovery.posting)
      if (errors.length) throw new Error(`备份损坏：岗位 ${opportunity.id} 的发布记录无效（${errors[0]}）`)
    }
    for (const posting of discovery?.postingHistory ?? []) {
      const errors = validateJobPostingEvidence(posting)
      if (errors.length) throw new Error(`备份损坏：岗位 ${opportunity.id} 的发布历史无效（${errors[0]}）`)
    }
  }

  for (const raw of data.processes) {
    const process = raw as ProcessRecord
    if (process.opportunityId && !opportunityIds.has(process.opportunityId)) {
      throw new Error(`备份损坏：流程 ${process.id} 引用了不存在的岗位 ${process.opportunityId}。`)
    }
  }

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
    const sources = new Set(['excel', 'natural_language', 'process_event', 'user_action', 'rules', 'backup', 'system', 'changeset', 'automation', 'gmail'])
    for (const raw of data.timeline) {
      const item = raw as TimelineRecord
      if (!item.title?.trim() || !categories.has(item.category) || !sources.has(item.source)) {
        throw new Error(`备份损坏：Timeline ${item.id} 的基础字段无效。`)
      }
      assertIsoDate(item.occurredAt, `Timeline ${item.id} 的 occurredAt`)
      assertIsoDate(item.recordedAt, `Timeline ${item.id} 的 recordedAt`)
      if (item.ingestion) validateIngestionEntry(item.ingestion, item.id)
      if (item.ingestionRun) validateIngestionRun(item.ingestionRun, item.id)
      if (item.kind === 'ingestion_recorded' && !item.ingestion) {
        throw new Error(`备份损坏：Timeline ${item.id} ingestion_recorded 缺少 ingestion payload。`)
      }
      if (item.kind === 'ingestion_run_completed' && !item.ingestionRun) {
        throw new Error(`备份损坏：Timeline ${item.id} ingestion_run_completed 缺少 ingestionRun payload。`)
      }
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

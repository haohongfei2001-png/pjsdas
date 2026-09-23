import type {
  Action,
  ApplicationGroup,
  DecisionRequest,
  DiscoveryInboxItem,
  ImportMeta,
  IngestionLedgerEntry,
  IngestionOutcome,
  IngestionRunSummary,
  Opportunity,
  Prep,
  ProcessEvent,
  ProcessRecord,
  ScheduleNode,
  SemanticIntakeReceipt,
  ReminderIntent,
  ReminderOutboxRecord,
  TimelineRecord,
} from './model.js'
import { validateDecisionRules, type DecisionRules } from './decisionRules.js'
import { validateChangeSet, type ChangeSetRecord } from './changeSet.js'
import { validateDiscoveryProfile, type DiscoveryProfile } from './discoveryProfile.js'
import { validateDiscoveryInboxItem } from './discoveryInbox.js'
import { validateJobPostingEvidence } from './jobPosting.js'
import { validateOpportunityAssessment } from './opportunityAssessment.js'
import { validateOpportunityFacts } from './richOpportunity.js'
import { ensureScheduleContractInPlace, validateScheduleNode } from './scheduleNodes.js'
import { validateReminderIntent, validateReminderOutbox } from './reminders.js'

export const SNAPSHOT_SCHEMA = 'pjsdas-local-snapshot' as const
export const SNAPSHOT_VERSION = 4 as const
export const PREVIOUS_SNAPSHOT_VERSION = 3 as const
export const SCHEDULE_SNAPSHOT_VERSION = 2 as const
export const LEGACY_SNAPSHOT_VERSION = 1 as const

export interface SnapshotData {
  opportunities: Opportunity[]
  processes: ProcessRecord[]
  processEvents: ProcessEvent[]
  actions: Action[]
  scheduleNodes?: ScheduleNode[]
  decisionRequests?: DecisionRequest[]
  semanticReceipts?: SemanticIntakeReceipt[]
  reminderIntents?: ReminderIntent[]
  reminderOutbox?: ReminderOutboxRecord[]
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
  version: typeof LEGACY_SNAPSHOT_VERSION | typeof SCHEDULE_SNAPSHOT_VERSION | typeof PREVIOUS_SNAPSHOT_VERSION | typeof SNAPSHOT_VERSION
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
  if (entry.capabilityBoundaries !== undefined && (!Array.isArray(entry.capabilityBoundaries)
    || entry.capabilityBoundaries.some((boundary) => typeof boundary !== 'string' || !boundary.trim() || boundary.length > 300))) {
    throw new Error(`备份损坏：Timeline ${timelineId} 的 ingestion capabilityBoundaries 无效。`)
  }
  if (entry.issueKinds !== undefined && (!Array.isArray(entry.issueKinds)
    || entry.issueKinds.some((kind) => kind !== 'transport_gap' && kind !== 'interpretation_failure' && kind !== 'business_ambiguity'))) {
    throw new Error(`备份损坏：Timeline ${timelineId} 的 ingestion issueKinds 无效。`)
  }
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
  const normalized = structuredClone(data)
  ensureScheduleContractInPlace(normalized)
  normalized.decisionRequests ??= []
  normalized.semanticReceipts ??= []
  normalized.reminderIntents ??= []
  normalized.reminderOutbox ??= []
  const snapshot: PJSDASSnapshot = {
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    exportedAt,
    data: normalized,
  }
  validateSnapshot(snapshot)
  return snapshot
}

export function upgradeSnapshotToLatest(snapshot: PJSDASSnapshot): PJSDASSnapshot {
  const next = structuredClone(snapshot)
  ensureScheduleContractInPlace(next.data)
  next.data.decisionRequests ??= []
  next.data.semanticReceipts ??= []
  next.data.reminderIntents ??= []
  next.data.reminderOutbox ??= []
  next.version = SNAPSHOT_VERSION
  validateSnapshot(next)
  return next
}

export function validateSnapshot(value: unknown): asserts value is PJSDASSnapshot {
  if (!isObject(value)) throw new Error('备份损坏：根对象无效。')
  if (value.schema !== SNAPSHOT_SCHEMA) throw new Error('这不是 PJSDAS 本地备份。')
  if (
    value.version !== LEGACY_SNAPSHOT_VERSION
    && value.version !== SCHEDULE_SNAPSHOT_VERSION
    && value.version !== PREVIOUS_SNAPSHOT_VERSION
    && value.version !== SNAPSHOT_VERSION
  ) {
    throw new Error(`不支持的备份版本：${String(value.version)}。当前支持 v${LEGACY_SNAPSHOT_VERSION}–v${SNAPSHOT_VERSION}。`)
  }
  assertIsoDate(value.exportedAt, 'exportedAt')
  if (!isObject(value.data)) throw new Error('备份损坏：缺少 data。')

  const data = value.data
  assertArray(data.opportunities, 'opportunities')
  assertArray(data.processes, 'processes')
  assertArray(data.processEvents, 'processEvents')
  assertArray(data.actions, 'actions')
  if (data.scheduleNodes !== undefined) assertArray(data.scheduleNodes, 'scheduleNodes')
  if (data.decisionRequests !== undefined) assertArray(data.decisionRequests, 'decisionRequests')
  if (data.semanticReceipts !== undefined) assertArray(data.semanticReceipts, 'semanticReceipts')
  if (data.reminderIntents !== undefined) assertArray(data.reminderIntents, 'reminderIntents')
  if (data.reminderOutbox !== undefined) assertArray(data.reminderOutbox, 'reminderOutbox')
  if (value.version >= SCHEDULE_SNAPSHOT_VERSION && data.scheduleNodes === undefined) {
    throw new Error('备份损坏：v2+ 缺少 scheduleNodes。')
  }
  if (value.version >= PREVIOUS_SNAPSHOT_VERSION && (data.decisionRequests === undefined || data.semanticReceipts === undefined)) {
    throw new Error('备份损坏：v3+ 缺少 DecisionRequest / SemanticReceipt 数据。')
  }
  if (value.version === SNAPSHOT_VERSION && (data.reminderIntents === undefined || data.reminderOutbox === undefined)) {
    throw new Error('备份损坏：v4 缺少 ReminderIntent / reminderOutbox 数据。')
  }
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
  const scheduleNodeIds = data.scheduleNodes ? assertUniqueIds(data.scheduleNodes, 'Schedule Node') : new Set<string>()
  const decisionRequestIds = data.decisionRequests ? assertUniqueIds(data.decisionRequests, 'Decision Request') : new Set<string>()
  const semanticReceiptIds = data.semanticReceipts ? assertUniqueIds(data.semanticReceipts, 'Semantic Receipt') : new Set<string>()
  const reminderIntentIds = data.reminderIntents ? assertUniqueIds(data.reminderIntents, 'Reminder Intent') : new Set<string>()
  const reminderOutboxIds = data.reminderOutbox ? assertUniqueIds(data.reminderOutbox, 'Reminder Outbox') : new Set<string>()
  const prepIds = assertUniqueIds(data.prep, 'Prep')
  const groupIds = assertUniqueIds(data.applicationGroups, 'Application Group')
  if (data.discoveryInbox) assertUniqueIds(data.discoveryInbox, 'Discovery Inbox')
  if (data.timeline) assertUniqueIds(data.timeline, 'Timeline')
  if (data.changeSets) assertUniqueIds(data.changeSets, 'ChangeSet')
  void actionIds
  void prepIds
  void scheduleNodeIds
  void decisionRequestIds
  void semanticReceiptIds
  void reminderOutboxIds

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

  const processProgress = new Set(['not_started', 'action_required', 'scheduled', 'in_progress', 'completed', 'waiting_result'])
  const processResults = new Set(['pending', 'advanced', 'rejected', 'offer', 'closed_other'])
  const processParticipation = new Set(['active', 'abandoned'])
  for (const raw of data.processes) {
    const process = raw as ProcessRecord
    if (process.opportunityId && !opportunityIds.has(process.opportunityId)) {
      throw new Error(`备份损坏：流程 ${process.id} 引用了不存在的岗位 ${process.opportunityId}。`)
    }
    if (value.version >= SCHEDULE_SNAPSHOT_VERSION) {
      if (!process.progress || !processProgress.has(process.progress)) throw new Error(`备份损坏：流程 ${process.id} 缺少正交 progress。`)
      if (!process.result || !processResults.has(process.result)) throw new Error(`备份损坏：流程 ${process.id} 缺少正交 result。`)
      if (!process.participationState || !processParticipation.has(process.participationState)) throw new Error(`备份损坏：流程 ${process.id} 缺少 participationState。`)
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

  if (data.scheduleNodes) {
    const occurrenceVersions = new Set<string>()
    for (const raw of data.scheduleNodes) {
      const node = raw as ScheduleNode
      const errors = validateScheduleNode(node)
      if (errors.length) throw new Error(`备份损坏：ScheduleNode ${node.id} 无效（${errors[0]}）`)
      const occurrenceVersion = `${node.occurrenceId}@${node.version}`
      if (occurrenceVersions.has(occurrenceVersion)) throw new Error(`备份损坏：ScheduleNode occurrence/version 重复（${occurrenceVersion}）。`)
      occurrenceVersions.add(occurrenceVersion)
      if (node.processId && !processIds.has(node.processId) && node.state !== 'cancelled' && node.state !== 'superseded') {
        throw new Error(`备份损坏：ScheduleNode ${node.id} 引用了不存在的流程 ${node.processId}。`)
      }
      if (node.processEventId && !eventIds.has(node.processEventId) && node.state !== 'cancelled' && node.state !== 'superseded') {
        throw new Error(`备份损坏：ScheduleNode ${node.id} 引用了不存在的流程事件 ${node.processEventId}。`)
      }
    }
  }

  if (data.reminderIntents) {
    const dedupeKeys = new Set<string>()
    for (const raw of data.reminderIntents) {
      const reminder = raw as ReminderIntent
      const errors = validateReminderIntent(reminder, scheduleNodeIds)
      if (errors.length) throw new Error(`备份损坏：ReminderIntent ${reminder.id} 无效（${errors[0]}）`)
      if (dedupeKeys.has(reminder.dedupeKey)) throw new Error(`备份损坏：ReminderIntent dedupeKey 重复（${reminder.dedupeKey}）。`)
      dedupeKeys.add(reminder.dedupeKey)
    }
  }

  if (data.reminderOutbox) {
    for (const raw of data.reminderOutbox) {
      const record = raw as ReminderOutboxRecord
      const errors = validateReminderOutbox(record, reminderIntentIds)
      if (errors.length) throw new Error(`备份损坏：ReminderOutbox ${record.id} 无效（${errors[0]}）`)
    }
  }

  if (data.decisionRequests) {
    const states = new Set(['open', 'answered', 'auto_resolved', 'superseded', 'expired'])
    const reasons = new Set(['ambiguous_target', 'ambiguous_occurrence', 'low_confidence', 'material_conflict', 'shared_governance', 'external_consequence', 'missing_required_field', 'target_abandoned'])
    for (const raw of data.decisionRequests) {
      const request = raw as DecisionRequest
      if (!request.question?.trim() || !states.has(request.state) || !reasons.has(request.reason)) {
        throw new Error(`备份损坏：DecisionRequest ${request.id} 基础字段无效。`)
      }
      if (!Array.isArray(request.choices) || request.choices.length < 2 || request.choices.length > 4) {
        throw new Error(`备份损坏：DecisionRequest ${request.id} 必须包含 2–4 个选项。`)
      }
      const choiceIds = new Set<string>()
      for (const choice of request.choices) {
        if (!choice.id?.trim() || !choice.label?.trim() || !choice.consequence?.trim() || choiceIds.has(choice.id)) {
          throw new Error(`备份损坏：DecisionRequest ${request.id} 选项无效。`)
        }
        choiceIds.add(choice.id)
      }
      if (request.payloadBinding?.contractVersion !== 1 || !request.payloadBinding.inputId?.trim() || !request.payloadBinding.candidateId?.trim()) {
        throw new Error(`备份损坏：DecisionRequest ${request.id} payload binding 无效。`)
      }
      assertIsoDate(request.createdAt, `DecisionRequest ${request.id} createdAt`)
      assertIsoDate(request.updatedAt, `DecisionRequest ${request.id} updatedAt`)
      if (request.expiresAt) assertIsoDate(request.expiresAt, `DecisionRequest ${request.id} expiresAt`)
      if (request.answeredAt) assertIsoDate(request.answeredAt, `DecisionRequest ${request.id} answeredAt`)
    }
  }

  if (data.semanticReceipts) {
    const statuses = new Set(['committed', 'decision_required', 'no_write', 'undone'])
    const inputIds = new Set<string>()
    for (const raw of data.semanticReceipts) {
      const receipt = raw as SemanticIntakeReceipt
      if (!receipt.inputId?.trim() || !receipt.sourceId?.trim() || !receipt.sourceRecordId?.trim() || !statuses.has(receipt.status)) {
        throw new Error(`备份损坏：SemanticReceipt ${receipt.id} 基础字段无效。`)
      }
      if (inputIds.has(receipt.inputId)) throw new Error(`备份损坏：SemanticReceipt inputId 重复（${receipt.inputId}）。`)
      inputIds.add(receipt.inputId)
      assertIsoDate(receipt.createdAt, `SemanticReceipt ${receipt.id} createdAt`)
      assertIsoDate(receipt.updatedAt, `SemanticReceipt ${receipt.id} updatedAt`)
    }
  }

  if (data.timeline) {
    const categories = new Set(['opportunity', 'process', 'action', 'rules', 'change', 'data', 'note'])
    const sources = new Set(['excel', 'natural_language', 'process_event', 'user_action', 'rules', 'backup', 'system', 'changeset', 'automation', 'gmail', 'paia', 'mcp', 'iphone'])
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
  return upgradeSnapshotToLatest(parsed)
}

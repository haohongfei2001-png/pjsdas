from pathlib import Path

# ---------- model: Timeline as a first-class domain ----------
p = Path('src/model.ts')
s = p.read_text()
anchor = "export type PriorityLevel = 'P0' | 'P1' | 'P2' | 'expired' | 'none'\n"
addition = anchor + r'''
export type TimelineCategory = 'opportunity' | 'process' | 'action' | 'rules' | 'data' | 'note'
export type TimelineSource =
  | 'excel'
  | 'natural_language'
  | 'process_event'
  | 'user_action'
  | 'rules'
  | 'backup'
  | 'system'
export type TimelineKind =
  | 'history_imported'
  | 'opportunity_added'
  | 'opportunity_updated'
  | 'application_submitted'
  | 'opportunity_renamed'
  | 'process_event_recorded'
  | 'process_closed'
  | 'process_event_deleted'
  | 'action_added'
  | 'action_status_changed'
  | 'rules_changed'
  | 'excel_imported'
  | 'backup_restored'
  | 'baseline_backfill'
export type TimelineChangeValue = string | number | boolean | null
export interface TimelineFieldChange {
  before?: TimelineChangeValue
  after?: TimelineChangeValue
}
export interface TimelineRecord {
  id: string
  kind: TimelineKind
  category: TimelineCategory
  source: TimelineSource
  occurredAt: string
  recordedAt: string
  title: string
  detail?: string
  opportunityId?: string
  actionId?: string
  processEventId?: string
  company?: string
  role?: string
  sourceRef?: string
  changes?: Record<string, TimelineFieldChange>
}
'''
if anchor not in s:
    raise SystemExit('model priority anchor missing')
s = s.replace(anchor, addition, 1)
old = """export interface ImportBundle {
  opportunities: Opportunity[]
  processes: ProcessRecord[]
  actions: Action[]
  prep: Prep[]
  applicationGroups: ApplicationGroup[]
  summary: ImportSummary
}
"""
new = """export interface ImportBundle {
  opportunities: Opportunity[]
  processes: ProcessRecord[]
  actions: Action[]
  prep: Prep[]
  applicationGroups: ApplicationGroup[]
  timeline?: TimelineRecord[]
  summary: ImportSummary
}
"""
if old not in s:
    raise SystemExit('ImportBundle anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

# ---------- timeline domain helpers ----------
Path('src/timeline.ts').write_text(r'''import type { DecisionRules } from './decisionRules'
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
''')

# ---------- Excel importer: ingest 秋招经历 as history, not as task state ----------
p = Path('src/importExcelV2.ts')
s = p.read_text()
s = s.replace(
"""  Prep,
  ProcessRecord,
  ProcessStage,
} from './model'
""",
"""  Prep,
  ProcessRecord,
  ProcessStage,
  TimelineRecord,
} from './model'
import { timelineFromImportedHistory } from './timeline'
""",
1,
)
s = s.replace("const GROUP_SHEET = '申请组'\n", "const GROUP_SHEET = '申请组'\nconst HISTORY_SHEET = '秋招经历'\n", 1)
anchor = """function getRecords(workbook: XLSX.WorkBook, sheetName: string, firstHeader: string) {
"""
if anchor not in s:
    raise SystemExit('getRecords anchor missing')
# Insert optional reader after getRecords function by locating the next function.
pos = s.index('function excelDate(')
optional_reader = r'''function getOptionalRecords(workbook: XLSX.WorkBook, sheetName: string, firstHeader: string) {
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return [] as Array<Record<string, unknown>>
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null })
  const headerIndex = matrix.findIndex((row) => text(row?.[0]) === firstHeader)
  if (headerIndex < 0) return [] as Array<Record<string, unknown>>
  const headers = matrix[headerIndex].map(text)
  return matrix.slice(headerIndex + 1).flatMap((row) => {
    if (!row || row.every((value) => value === null || text(value) === '')) return []
    const record: Record<string, unknown> = {}
    headers.forEach((header, index) => { if (header) record[header] = row[index] })
    return [record]
  })
}

'''
s = s[:pos] + optional_reader + s[pos:]
s = s.replace(
"""  const groupRows = getRecords(workbook, GROUP_SHEET, '申请组ID')

  const detailById = new Map(details.map((row) => [text(row['岗位ID']), row]))
""",
"""  const groupRows = getRecords(workbook, GROUP_SHEET, '申请组ID')
  const historyRows = getOptionalRecords(workbook, HISTORY_SHEET, '日期')

  const detailById = new Map(details.map((row) => [text(row['岗位ID']), row]))
""",
1,
)
return_anchor = """  return {
    opportunities,
    processes,
    actions,
    prep,
    applicationGroups,
    summary: {
"""
if return_anchor not in s:
    raise SystemExit('import return anchor missing')
history_code = r'''  const opportunityById = new Map(opportunities.map((item) => [item.id, item]))
  const timeline: TimelineRecord[] = historyRows.flatMap((row) => {
    const occurredAt = excelDate(row['日期'])
    const event = text(row['事件'] ?? row['发生了什么'])
    const type = text(row['类型'])
    if (!occurredAt || (!event && !type)) return []
    const relation = cleanOptional(row['关联岗位'] ?? row['关联岗位/主题'])
    const ids = relation?.match(/[A-Z][A-Z0-9]*-\d+/g) ?? []
    const linked = ids.map((id) => opportunityById.get(id)).filter((item): item is Opportunity => Boolean(item))
    const opportunity = linked.length === 1 ? linked[0] : undefined
    return [timelineFromImportedHistory({
      occurredAt,
      importedAt,
      type,
      relation,
      event: event || type,
      result: cleanOptional(row['结果']),
      learning: cleanOptional(row['学习/产出']),
      reflection: cleanOptional(row['重要复盘']),
      opportunity,
      filename: file.name,
    })]
  })

'''
s = s.replace(return_anchor, history_code + return_anchor.replace('    summary:', '    timeline,\n    summary:'), 1)
p.write_text(s)

# ---------- snapshot: timeline is backup-safe and backward compatible ----------
p = Path('src/snapshot.ts')
s = p.read_text()
s = s.replace(
"""  ProcessEvent,
  ProcessRecord,
} from './model'
""",
"""  ProcessEvent,
  ProcessRecord,
  TimelineRecord,
} from './model'
""",
1,
)
s = s.replace(
"""  applicationGroups: ApplicationGroup[]
  decisionRules?: DecisionRules
  meta?: ImportMeta
""",
"""  applicationGroups: ApplicationGroup[]
  decisionRules?: DecisionRules
  timeline?: TimelineRecord[]
  meta?: ImportMeta
""",
1,
)
s = s.replace(
"""  assertArray(data.applicationGroups, 'applicationGroups')
  if (data.decisionRules !== undefined) {
""",
"""  assertArray(data.applicationGroups, 'applicationGroups')
  if (data.timeline !== undefined) assertArray(data.timeline, 'timeline')
  if (data.decisionRules !== undefined) {
""",
1,
)
s = s.replace(
"""  const groupIds = assertUniqueIds(data.applicationGroups, 'Application Group')
  void processIds
""",
"""  const groupIds = assertUniqueIds(data.applicationGroups, 'Application Group')
  if (data.timeline) assertUniqueIds(data.timeline, 'Timeline')
  void processIds
""",
1,
)
insert = """  for (const raw of data.actions) {
"""
timeline_validation = r'''  if (data.timeline) {
    const categories = new Set(['opportunity', 'process', 'action', 'rules', 'data', 'note'])
    const sources = new Set(['excel', 'natural_language', 'process_event', 'user_action', 'rules', 'backup', 'system'])
    for (const raw of data.timeline) {
      const item = raw as TimelineRecord
      if (!item.title?.trim() || !categories.has(item.category) || !sources.has(item.source)) {
        throw new Error(`备份损坏：Timeline ${item.id} 的基础字段无效。`)
      }
      assertIsoDate(item.occurredAt, `Timeline ${item.id} 的 occurredAt`)
      assertIsoDate(item.recordedAt, `Timeline ${item.id} 的 recordedAt`)
    }
  }

'''
if insert not in s:
    raise SystemExit('snapshot timeline validation anchor missing')
s = s.replace(insert, timeline_validation + insert, 1)
p.write_text(s)

# ---------- DB: durable store + write-through journal + conservative backfill ----------
p = Path('src/db.ts')
s = p.read_text()
s = s.replace(
"""import { createDefaultDecisionRules, validateDecisionRules, type DecisionRules } from './decisionRules'
import type { ProgressOperation } from './progressUpdate'
""",
"""import { createDefaultDecisionRules, validateDecisionRules, type DecisionRules } from './decisionRules'
import {
  TIMELINE_BACKFILL_MARKER_ID,
  buildTimelineBackfill,
  timelineFromActionStatus,
  timelineFromDeletedProcessEvent,
  timelineFromImport,
  timelineFromProcessEvent,
  timelineFromProgressOperation,
  timelineFromRestore,
  timelineFromRuleChange,
} from './timeline'
import type { ProgressOperation } from './progressUpdate'
""",
1,
)
s = s.replace(
"""  ProcessEvent,
  ProcessRecord,
} from './model'
""",
"""  ProcessEvent,
  ProcessRecord,
  TimelineCategory,
  TimelineRecord,
} from './model'
""",
1,
)
s = s.replace(
"""  applicationGroups: { key: string; value: ApplicationGroup }
  decisionRules: { key: string; value: DecisionRules }
  meta: { key: string; value: ImportMeta }
""",
"""  applicationGroups: { key: string; value: ApplicationGroup }
  decisionRules: { key: string; value: DecisionRules }
  timeline: {
    key: string
    value: TimelineRecord
    indexes: { 'by-occurred-at': string; 'by-category': TimelineCategory; 'by-opportunity': string }
  }
  meta: { key: string; value: ImportMeta }
""",
1,
)
s = s.replace("""  'decisionRules',
  'meta',
""", """  'decisionRules',
  'timeline',
  'meta',
""", 1)
s = s.replace("openDB<PJSDASDatabase>('pjsdas', 4, {", "openDB<PJSDASDatabase>('pjsdas', 5, {", 1)
s = s.replace(
"""    if (!db.objectStoreNames.contains('decisionRules')) {
      db.createObjectStore('decisionRules', { keyPath: 'key' })
    }
    if (!db.objectStoreNames.contains('meta')) {
""",
"""    if (!db.objectStoreNames.contains('decisionRules')) {
      db.createObjectStore('decisionRules', { keyPath: 'key' })
    }
    if (!db.objectStoreNames.contains('timeline')) {
      const store = db.createObjectStore('timeline', { keyPath: 'id' })
      store.createIndex('by-occurred-at', 'occurredAt')
      store.createIndex('by-category', 'category')
      store.createIndex('by-opportunity', 'opportunityId')
    }
    if (!db.objectStoreNames.contains('meta')) {
""",
1,
)

old = r'''export async function getDecisionRules() {
  const stored = await (await dbPromise).get('decisionRules', 'current')
  return stored ?? createDefaultDecisionRules()
}

export async function saveDecisionRules(rules: DecisionRules) {
  const next: DecisionRules = { ...rules, weights: { ...rules.weights }, key: 'current', version: 1, updatedAt: new Date().toISOString() }
  const errors = validateDecisionRules(next)
  if (errors.length) throw new Error(errors[0])
  await (await dbPromise).put('decisionRules', next)
  return next
}

export async function resetDecisionRules() {
  const next = createDefaultDecisionRules()
  await (await dbPromise).put('decisionRules', next)
  return next
}

export async function updateActionStatus(id: string, status: Action['status']) {
  const db = await dbPromise
  const action = await db.get('actions', id)
  if (!action) return
  await db.put('actions', { ...action, status, updatedAt: new Date().toISOString() })
}

export async function addProcessEvent(event: ProcessEvent) {
  const db = await dbPromise
  const tx = db.transaction(['processEvents', 'actions'], 'readwrite')
  await tx.objectStore('processEvents').put(event)
  const action = actionForProcessEvent(event)
  if (action) await tx.objectStore('actions').put(action)
  await tx.done
}

export async function deleteProcessEvent(id: string) {
  const db = await dbPromise
  const tx = db.transaction(['processEvents', 'actions'], 'readwrite')
  await tx.objectStore('processEvents').delete(id)
  await tx.objectStore('actions').delete(`event-action:${id}`)
  await tx.done
}
'''
new = r'''export async function getDecisionRules() {
  const stored = await (await dbPromise).get('decisionRules', 'current')
  return stored ?? createDefaultDecisionRules()
}

async function ensureTimelineBackfill(db: Awaited<typeof dbPromise>) {
  const marker = await db.get('timeline', TIMELINE_BACKFILL_MARKER_ID)
  if (marker) return
  const [processEvents, actions, lastImport, decisionRules] = await Promise.all([
    db.getAll('processEvents'),
    db.getAll('actions'),
    db.get('meta', 'lastImport'),
    db.get('decisionRules', 'current'),
  ])
  const tx = db.transaction('timeline', 'readwrite')
  for (const record of buildTimelineBackfill({ processEvents, actions, lastImport, decisionRules })) {
    if (!await tx.store.get(record.id)) await tx.store.put(record)
  }
  await tx.done
}

export async function getAllTimelineRecords() {
  const db = await dbPromise
  await ensureTimelineBackfill(db)
  const records = await db.getAll('timeline')
  return records
    .filter((item) => item.kind !== 'baseline_backfill')
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt))
}

export async function saveDecisionRules(rules: DecisionRules) {
  const db = await dbPromise
  const before = await db.get('decisionRules', 'current') ?? createDefaultDecisionRules('1970-01-01T00:00:00.000Z')
  const next: DecisionRules = { ...rules, weights: { ...rules.weights }, key: 'current', version: 1, updatedAt: new Date().toISOString() }
  const errors = validateDecisionRules(next)
  if (errors.length) throw new Error(errors[0])
  const tx = db.transaction(['decisionRules', 'timeline'], 'readwrite')
  await tx.objectStore('decisionRules').put(next)
  const record = timelineFromRuleChange(before, next, 'save')
  if (record) await tx.objectStore('timeline').put(record)
  await tx.done
  return next
}

export async function resetDecisionRules() {
  const db = await dbPromise
  const before = await db.get('decisionRules', 'current') ?? createDefaultDecisionRules('1970-01-01T00:00:00.000Z')
  const next = createDefaultDecisionRules()
  const tx = db.transaction(['decisionRules', 'timeline'], 'readwrite')
  await tx.objectStore('decisionRules').put(next)
  const record = timelineFromRuleChange(before, next, 'reset')
  if (record) await tx.objectStore('timeline').put(record)
  await tx.done
  return next
}

export async function updateActionStatus(id: string, status: Action['status']) {
  const db = await dbPromise
  const tx = db.transaction(['actions', 'timeline'], 'readwrite')
  const action = await tx.objectStore('actions').get(id)
  if (!action || action.status === status) {
    await tx.done
    return
  }
  const now = new Date().toISOString()
  await tx.objectStore('actions').put({ ...action, status, updatedAt: now })
  await tx.objectStore('timeline').put(timelineFromActionStatus(action, action.status, status, now))
  await tx.done
}

export async function addProcessEvent(event: ProcessEvent) {
  const db = await dbPromise
  const tx = db.transaction(['processEvents', 'actions', 'timeline'], 'readwrite')
  await tx.objectStore('processEvents').put(event)
  const action = actionForProcessEvent(event)
  if (action) await tx.objectStore('actions').put(action)
  await tx.objectStore('timeline').put(timelineFromProcessEvent(event))
  await tx.done
}

export async function deleteProcessEvent(id: string) {
  const db = await dbPromise
  const tx = db.transaction(['processEvents', 'actions', 'timeline'], 'readwrite')
  const event = await tx.objectStore('processEvents').get(id)
  await tx.objectStore('processEvents').delete(id)
  await tx.objectStore('actions').delete(`event-action:${id}`)
  if (event) await tx.objectStore('timeline').put(timelineFromDeletedProcessEvent(event))
  await tx.done
}
'''
if old not in s:
    raise SystemExit('db rules/action/event block missing')
s = s.replace(old, new, 1)

s = s.replace(
"""export async function applyProgressUpdate(operations: ProgressOperation[]) {
  const executable = operations.filter((item) => item.kind !== 'unresolved')
""",
"""export async function applyProgressUpdate(operations: ProgressOperation[]) {
  const executable = operations.filter((item) => item.kind !== 'unresolved' && item.kind !== 'ignored')
""",
1,
)
s = s.replace(
"""  const tx = db.transaction(['opportunities', 'processes', 'processEvents', 'actions'], 'readwrite')
  const opportunityStore = tx.objectStore('opportunities')
  const processStore = tx.objectStore('processes')
  const eventStore = tx.objectStore('processEvents')
  const actionStore = tx.objectStore('actions')
""",
"""  const tx = db.transaction(['opportunities', 'processes', 'processEvents', 'actions', 'timeline'], 'readwrite')
  const opportunityStore = tx.objectStore('opportunities')
  const processStore = tx.objectStore('processes')
  const eventStore = tx.objectStore('processEvents')
  const actionStore = tx.objectStore('actions')
  const timelineStore = tx.objectStore('timeline')
""",
1,
)
# Add timeline writes immediately before each branch continue.
s = s.replace(
"""      }
      continue
    }

    if (operation.kind === 'rename_opportunity') {
""",
"""      }
      const record = timelineFromProgressOperation(operation, existing)
      if (record) await timelineStore.put(record)
      continue
    }

    if (operation.kind === 'rename_opportunity') {
""",
1,
)
s = s.replace(
"""      for (const action of actions) {
        const title = action.title.includes(operation.oldRole)
          ? action.title.replace(operation.oldRole, operation.newRole)
          : action.title
        await actionStore.put({ ...action, title, updatedAt: operation.occurredAt })
      }
      continue
    }

    if (operation.kind === 'close_opportunity') {
""",
"""      for (const action of actions) {
        const title = action.title.includes(operation.oldRole)
          ? action.title.replace(operation.oldRole, operation.newRole)
          : action.title
        await actionStore.put({ ...action, title, updatedAt: operation.occurredAt })
      }
      const record = timelineFromProgressOperation(operation, existing)
      if (record) await timelineStore.put(record)
      continue
    }

    if (operation.kind === 'close_opportunity') {
""",
1,
)
s = s.replace(
"""      for (const action of actions) {
        if (action.kind === 'prep') continue
        if (action.status === 'todo' || action.status === 'doing') {
          await actionStore.put({ ...action, status: 'skipped', updatedAt: operation.occurredAt })
        }
      }
      continue
    }

    if (operation.kind === 'process_event') {
""",
"""      for (const action of actions) {
        if (action.kind === 'prep') continue
        if (action.status === 'todo' || action.status === 'doing') {
          await actionStore.put({ ...action, status: 'skipped', updatedAt: operation.occurredAt })
        }
      }
      const record = timelineFromProgressOperation(operation, existing)
      if (record) await timelineStore.put(record)
      continue
    }

    if (operation.kind === 'process_event') {
""",
1,
)
s = s.replace(
"""      if (generated) {
        const previous = await actionStore.get(generated.id)
        await actionStore.put(operation.completed
          ? { ...generated, status: 'done', updatedAt: operation.occurredAt }
          : previous
            ? { ...generated, status: previous.status, updatedAt: previous.updatedAt }
            : generated)
      }
      continue
    }

    if (operation.kind === 'manual_action') {
""",
"""      if (generated) {
        const previous = await actionStore.get(generated.id)
        await actionStore.put(operation.completed
          ? { ...generated, status: 'done', updatedAt: operation.occurredAt }
          : previous
            ? { ...generated, status: previous.status, updatedAt: previous.updatedAt }
            : generated)
      }
      const record = timelineFromProgressOperation(operation)
      if (record) await timelineStore.put(record)
      continue
    }

    if (operation.kind === 'manual_action') {
""",
1,
)
s = s.replace(
"""      }
      await actionStore.put(action)
    }
  }
""",
"""      }
      await actionStore.put(action)
      const record = timelineFromProgressOperation(operation)
      if (record) await timelineStore.put(record)
    }
  }
""",
1,
)

s = s.replace(
"""  const [opportunities, processes, processEvents, actions, prep, applicationGroups, decisionRules, meta] =
    await Promise.all([
      db.getAll('opportunities'),
      db.getAll('processes'),
      db.getAll('processEvents'),
      db.getAll('actions'),
      db.getAll('prep'),
      db.getAll('applicationGroups'),
      db.get('decisionRules', 'current'),
      db.get('meta', 'lastImport'),
    ])
""",
"""  await ensureTimelineBackfill(db)
  const [opportunities, processes, processEvents, actions, prep, applicationGroups, decisionRules, timeline, meta] =
    await Promise.all([
      db.getAll('opportunities'),
      db.getAll('processes'),
      db.getAll('processEvents'),
      db.getAll('actions'),
      db.getAll('prep'),
      db.getAll('applicationGroups'),
      db.get('decisionRules', 'current'),
      db.getAll('timeline'),
      db.get('meta', 'lastImport'),
    ])
""",
1,
)
s = s.replace(
"""    applicationGroups,
    decisionRules: decisionRules ?? createDefaultDecisionRules(),
    meta,
""",
"""    applicationGroups,
    decisionRules: decisionRules ?? createDefaultDecisionRules(),
    timeline,
    meta,
""",
1,
)
s = s.replace(
"""  for (const item of snapshot.data.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  await tx.objectStore('decisionRules').put(snapshot.data.decisionRules ?? createDefaultDecisionRules())
  if (snapshot.data.meta) await tx.objectStore('meta').put(snapshot.data.meta)
""",
"""  for (const item of snapshot.data.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  await tx.objectStore('decisionRules').put(snapshot.data.decisionRules ?? createDefaultDecisionRules())
  for (const item of snapshot.data.timeline ?? []) await tx.objectStore('timeline').put(item)
  await tx.objectStore('timeline').put(timelineFromRestore(snapshot.exportedAt))
  if (snapshot.data.meta) await tx.objectStore('meta').put(snapshot.data.meta)
""",
1,
)
old_tx = """  const tx = db.transaction(
    ['opportunities', 'processes', 'actions', 'prep', 'applicationGroups', 'meta'],
    'readwrite',
  )
"""
new_tx = """  const tx = db.transaction(
    ['opportunities', 'processes', 'actions', 'prep', 'applicationGroups', 'timeline', 'meta'],
    'readwrite',
  )
"""
if old_tx not in s:
    raise SystemExit('replace import tx anchor missing')
s = s.replace(old_tx, new_tx, 1)
s = s.replace(
"""  for (const item of bundle.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  await tx.objectStore('meta').put({ key: 'lastImport', ...bundle.summary })
""",
"""  for (const item of bundle.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  for (const item of bundle.timeline ?? []) {
    if (!await tx.objectStore('timeline').get(item.id)) await tx.objectStore('timeline').put(item)
  }
  const importMeta: ImportMeta = { key: 'lastImport', ...bundle.summary }
  await tx.objectStore('timeline').put(timelineFromImport(importMeta, bundle.timeline?.length ?? 0))
  await tx.objectStore('meta').put(importMeta)
""",
1,
)
p.write_text(s)

# ---------- Timeline UI ----------
Path('src/TimelineView.tsx').write_text(r'''import { useMemo, useState } from 'react'
import type { TimelineCategory, TimelineRecord, TimelineSource } from './model'
import { useUiLanguage } from './uiLanguage'
import './timeline.css'

const categories: TimelineCategory[] = ['opportunity', 'process', 'action', 'rules', 'data', 'note']
const sources: TimelineSource[] = ['excel', 'natural_language', 'process_event', 'user_action', 'rules', 'backup', 'system']

const categoryLabels: Record<TimelineCategory, [string, string]> = {
  opportunity: ['机会', 'Opportunity'],
  process: ['流程', 'Process'],
  action: ['行动', 'Action'],
  rules: ['规则', 'Rules'],
  data: ['数据', 'Data'],
  note: ['记录', 'Note'],
}

const sourceLabels: Record<TimelineSource, [string, string]> = {
  excel: ['Excel 历史', 'Excel history'],
  natural_language: ['自然语言', 'Natural language'],
  process_event: ['流程通知', 'Process event'],
  user_action: ['用户操作', 'User action'],
  rules: ['规则设置', 'Rules'],
  backup: ['本地备份', 'Backup'],
  system: ['系统回填', 'System'],
}

function dayKey(iso: string) {
  const date = new Date(iso)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatDay(iso: string, zh: boolean) {
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    year: 'numeric', month: zh ? 'long' : 'short', day: 'numeric', weekday: 'short',
  }).format(new Date(iso))
}

function formatTime(iso: string, zh: boolean) {
  const date = new Date(iso)
  if (date.getHours() === 0 && date.getMinutes() === 0) return zh ? '当天' : 'Date only'
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function changeValue(value: unknown) {
  if (value === undefined) return '—'
  if (value === null) return '∅'
  return String(value)
}

export default function TimelineView({ records }: { records: TimelineRecord[] }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'all' | TimelineCategory>('all')
  const [source, setSource] = useState<'all' | TimelineSource>('all')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return records.filter((item) => {
      if (category !== 'all' && item.category !== category) return false
      if (source !== 'all' && item.source !== source) return false
      if (!needle) return true
      return [item.title, item.detail, item.company, item.role, item.sourceRef]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle)
    })
  }, [records, query, category, source])

  const groups = useMemo(() => {
    const result: Array<{ key: string; date: string; items: TimelineRecord[] }> = []
    for (const item of filtered) {
      const key = dayKey(item.occurredAt)
      const last = result[result.length - 1]
      if (!last || last.key !== key) result.push({ key, date: item.occurredAt, items: [item] })
      else last.items.push(item)
    }
    return result
  }, [filtered])

  return (
    <section className="timeline-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">TIMELINE · V0.9</div>
          <h1>{zh ? '求职历程' : 'Timeline'}</h1>
          <p>{zh
            ? '已经发生的投递、流程节点、行动完成、规则修改和数据迁移都进入同一条可追溯时间线。Timeline 记录事实，不承担 Today 的任务排序。'
            : 'Applications, process events, completed actions, rule changes and data migrations share one traceable timeline. Timeline records facts; Today decides what to do next.'}</p>
        </div>
      </header>

      <div className="timeline-summary">
        <div><span>{zh ? '全部记录' : 'All records'}</span><strong>{records.length}</strong></div>
        <div><span>{zh ? '流程事件' : 'Process events'}</span><strong>{records.filter((item) => item.category === 'process').length}</strong></div>
        <div><span>{zh ? '机会 / 投递' : 'Opportunity / apply'}</span><strong>{records.filter((item) => item.category === 'opportunity').length}</strong></div>
      </div>

      <div className="timeline-toolbar">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? '搜索公司、岗位或事件' : 'Search company, role or event'} />
        <select value={category} onChange={(event) => setCategory(event.target.value as 'all' | TimelineCategory)}>
          <option value="all">{zh ? '全部类型' : 'All types'}</option>
          {categories.map((item) => <option value={item} key={item}>{categoryLabels[item][zh ? 0 : 1]}</option>)}
        </select>
        <select value={source} onChange={(event) => setSource(event.target.value as 'all' | TimelineSource)}>
          <option value="all">{zh ? '全部来源' : 'All sources'}</option>
          {sources.map((item) => <option value={item} key={item}>{sourceLabels[item][zh ? 0 : 1]}</option>)}
        </select>
        <span>{filtered.length} / {records.length}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-card"><strong>{zh ? '没有匹配的历程记录' : 'No matching timeline records'}</strong><p>{zh ? '调整搜索或筛选条件。' : 'Adjust search or filters.'}</p></div>
      ) : (
        <div className="timeline-groups">
          {groups.map((group) => (
            <section className="timeline-day" key={group.key}>
              <div className="timeline-day-label"><strong>{formatDay(group.date, zh)}</strong><span>{group.items.length} {zh ? '条' : 'events'}</span></div>
              <div className="timeline-day-events">
                {group.items.map((item) => (
                  <article className={`timeline-event category-${item.category}`} key={item.id}>
                    <div className="timeline-marker"><span /></div>
                    <div className="timeline-event-body">
                      <div className="timeline-event-meta">
                        <span className="timeline-category">{categoryLabels[item.category][zh ? 0 : 1]}</span>
                        <span>{sourceLabels[item.source][zh ? 0 : 1]}</span>
                        <span>{formatTime(item.occurredAt, zh)}</span>
                      </div>
                      <h3>{item.title}</h3>
                      {(item.company || item.role) ? <p className="timeline-entity">{[item.company, item.role].filter(Boolean).join('｜')}</p> : null}
                      {item.sourceRef && !item.company ? <p className="timeline-entity">{item.sourceRef}</p> : null}
                      {item.detail ? <p className="timeline-detail">{item.detail}</p> : null}
                      {item.changes && Object.keys(item.changes).length > 0 ? (
                        <div className="timeline-changes">
                          {Object.entries(item.changes).slice(0, 5).map(([key, value]) => (
                            <span key={key}><b>{key}</b> {changeValue(value.before)} → {changeValue(value.after)}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  )
}
''')

Path('src/timeline.css').write_text(r'''.timeline-page { padding-bottom: 64px; }
.timeline-summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin: 8px 0 18px; }
.timeline-summary > div { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; min-height:82px; padding:18px 20px; border:1px solid var(--ds-border,rgba(49,46,42,.12)); border-radius:18px; background:rgba(255,255,255,.62); }
.timeline-summary span { color:#77736d; font-size:13px; }
.timeline-summary strong { color:#282722; font-size:27px; letter-spacing:-.04em; }
.timeline-toolbar { display:grid; grid-template-columns:minmax(260px,1fr) 180px 180px auto; gap:10px; align-items:center; padding:12px; border:1px solid rgba(49,46,42,.12); border-radius:18px; background:rgba(255,255,255,.72); }
.timeline-toolbar input,.timeline-toolbar select { box-sizing:border-box; width:100%; min-height:42px; border:1px solid rgba(49,46,42,.14); border-radius:12px; padding:0 13px; background:#fffdf9; color:#2f2e29; font:inherit; font-size:13px; }
.timeline-toolbar > span { min-width:74px; text-align:right; color:#8a857d; font-size:12px; font-variant-numeric:tabular-nums; }
.timeline-groups { display:grid; gap:26px; margin-top:24px; }
.timeline-day { display:grid; grid-template-columns:170px minmax(0,1fr); gap:28px; }
.timeline-day-label { position:sticky; top:24px; align-self:start; display:grid; gap:4px; padding-top:4px; }
.timeline-day-label strong { color:#393732; font-size:14px; }
.timeline-day-label span { color:#99938b; font-size:12px; }
.timeline-day-events { display:grid; }
.timeline-event { display:grid; grid-template-columns:24px minmax(0,1fr); gap:14px; min-height:96px; }
.timeline-marker { position:relative; display:flex; justify-content:center; }
.timeline-marker::after { content:''; position:absolute; top:22px; bottom:-1px; width:1px; background:rgba(77,72,64,.13); }
.timeline-event:last-child .timeline-marker::after { display:none; }
.timeline-marker span { position:relative; z-index:1; width:10px; height:10px; margin-top:12px; border:3px solid #faf8f3; border-radius:50%; background:#9a948a; box-shadow:0 0 0 1px rgba(49,46,42,.13); }
.timeline-event.category-process .timeline-marker span { background:#765442; }
.timeline-event.category-opportunity .timeline-marker span { background:#5f6f63; }
.timeline-event.category-rules .timeline-marker span { background:#6d6478; }
.timeline-event.category-action .timeline-marker span { background:#7c704f; }
.timeline-event-body { margin-bottom:12px; padding:15px 17px 16px; border:1px solid rgba(49,46,42,.11); border-radius:16px; background:rgba(255,255,255,.72); box-shadow:0 5px 18px rgba(48,43,36,.025); }
.timeline-event-meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; color:#99938b; font-size:11px; }
.timeline-event-meta span + span::before { content:'·'; margin-right:8px; color:#c4bfb6; }
.timeline-category { color:#5f5b55; font-weight:700; }
.timeline-event-body h3 { margin:7px 0 0; color:#282722; font-size:15px; line-height:1.45; letter-spacing:-.01em; }
.timeline-entity { margin:5px 0 0; color:#605c55; font-size:12px; font-weight:650; }
.timeline-detail { margin:8px 0 0; color:#777169; font-size:12px; line-height:1.65; white-space:pre-line; }
.timeline-changes { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
.timeline-changes span { border:1px solid rgba(74,68,60,.1); border-radius:8px; padding:5px 7px; background:#f7f4ee; color:#777169; font-size:10.5px; }
.timeline-changes b { color:#56524c; font-weight:700; }
@media (max-width: 900px) { .timeline-summary { grid-template-columns:1fr; } .timeline-toolbar { grid-template-columns:1fr 1fr; } .timeline-toolbar input { grid-column:1/-1; } .timeline-day { grid-template-columns:1fr; gap:8px; } .timeline-day-label { position:static; } }
@media (max-width: 620px) { .timeline-toolbar { grid-template-columns:1fr; } .timeline-toolbar input { grid-column:auto; } .timeline-toolbar > span { text-align:left; } }
''')

# ---------- App: new top-level Timeline route ----------
p = Path('src/AppV5.tsx')
s = p.read_text()
s = s.replace(
"""  getDecisionRules,
  getLastImport,
""",
"""  getDecisionRules,
  getAllTimelineRecords,
  getLastImport,
""",
1,
)
s = s.replace("import RulesView from './RulesView'\n", "import RulesView from './RulesView'\nimport TimelineView from './TimelineView'\n", 1)
s = s.replace(
"""  ProcessRecord,
} from './model'
""",
"""  ProcessRecord,
  TimelineRecord,
} from './model'
""",
1,
)
s = s.replace("type Page = 'today' | 'opportunities' | 'pipeline' | 'prep' | 'rules' | 'settings'", "type Page = 'today' | 'opportunities' | 'pipeline' | 'prep' | 'timeline' | 'rules' | 'settings'", 1)
s = s.replace("const navigation: Page[] = ['today', 'opportunities', 'pipeline', 'prep', 'rules', 'settings']", "const navigation: Page[] = ['today', 'opportunities', 'pipeline', 'prep', 'timeline', 'rules', 'settings']", 1)
s = s.replace("  const [groups, setGroups] = useState<ApplicationGroup[]>([])\n", "  const [groups, setGroups] = useState<ApplicationGroup[]>([])\n  const [timeline, setTimeline] = useState<TimelineRecord[]>([])\n", 1)
s = s.replace(
"""    const [nextOpportunities, nextActions, nextProcesses, nextPrep, nextGroups, nextRules, nextImport] =
      await Promise.all([
""",
"""    const [nextOpportunities, nextActions, nextProcesses, nextPrep, nextGroups, nextRules, nextTimeline, nextImport] =
      await Promise.all([
""",
1,
)
s = s.replace(
"""        getAllApplicationGroups(),
        getDecisionRules(),
        getLastImport(),
""",
"""        getAllApplicationGroups(),
        getDecisionRules(),
        getAllTimelineRecords(),
        getLastImport(),
""",
1,
)
s = s.replace("    setRules(nextRules)\n    setLastImport(nextImport)\n", "    setRules(nextRules)\n    setTimeline(nextTimeline)\n    setLastImport(nextImport)\n", 1)
s = s.replace(
"""              {t(`nav.${item}` as 'nav.today' | 'nav.opportunities' | 'nav.pipeline' | 'nav.prep' | 'nav.rules' | 'nav.settings')}
""",
"""              {t(`nav.${item}` as 'nav.today' | 'nav.opportunities' | 'nav.pipeline' | 'nav.prep' | 'nav.timeline' | 'nav.rules' | 'nav.settings')}
""",
1,
)
s = s.replace(
"""        {!loading && page === 'prep' ? <PrepView prep={prep} /> : null}
        {!loading && page === 'rules' ? <RulesView rules={rules} onChanged={reload} /> : null}
""",
"""        {!loading && page === 'prep' ? <PrepView prep={prep} /> : null}
        {!loading && page === 'timeline' ? <TimelineView records={timeline} /> : null}
        {!loading && page === 'rules' ? <RulesView rules={rules} onChanged={reload} /> : null}
""",
1,
)
p.write_text(s)

# ---------- i18n: Timeline top-level navigation ----------
p = Path('src/uiLanguage.tsx')
s = p.read_text()
s = s.replace("  'nav.prep': ['准备', 'Prep'],\n", "  'nav.prep': ['准备', 'Prep'],\n  'nav.timeline': ['历程', 'Timeline'],\n", 1)
p.write_text(s)

# ---------- Local backup preview includes timeline ----------
p = Path('src/LocalBackupDock.tsx')
s = p.read_text()
s = s.replace(
"""      setMessage(`已导出：${snapshot.data.opportunities.length} 个岗位、${snapshot.data.processEvents.length} 条流程事件、${snapshot.data.actions.length} 个 Action。`)
""",
"""      setMessage(`已导出：${snapshot.data.opportunities.length} 个岗位、${snapshot.data.processEvents.length} 条流程事件、${snapshot.data.timeline?.length ?? 0} 条历程、${snapshot.data.actions.length} 个 Action。`)
""",
1,
)
s = s.replace(
"""                  <span>申请组 <strong>{preview.data.applicationGroups.length}</strong></span>
""",
"""                  <span>申请组 <strong>{preview.data.applicationGroups.length}</strong></span>
                  <span>历程 <strong>{preview.data.timeline?.length ?? 0}</strong></span>
""",
1,
)
p.write_text(s)

# ---------- tests ----------
Path('tests/timeline.test.ts').write_text(r'''import { describe, expect, it } from 'vitest'
import { createDefaultDecisionRules } from '../src/decisionRules'
import {
  buildTimelineBackfill,
  decisionRuleChanges,
  timelineFromImportedHistory,
  timelineFromProgressOperation,
} from '../src/timeline'
import type { Opportunity, ProcessEvent } from '../src/model'

const opportunity: Opportunity = {
  id: 'J27-001', company: '测试公司', role: '产品经理', currentStageLabel: '待投', processStage: 'not_applied',
  roleType: 'core', early: false, opportunityValue: 90, fitScore: 76, importedAt: '2026-09-01T00:00:00.000Z',
}

describe('Timeline domain', () => {
  it('turns a submitted natural-language update into a durable application event', () => {
    const record = timelineFromProgressOperation({
      id: 'apply-1', kind: 'upsert_opportunity', mode: 'submitted', opportunityId: opportunity.id,
      company: opportunity.company, role: opportunity.role, sourceText: '9月10日投递测试公司产品经理',
      confidence: 'high', occurredAt: '2026-09-10T00:00:00.000Z',
    }, opportunity)
    expect(record).toMatchObject({ kind: 'application_submitted', category: 'opportunity', source: 'natural_language' })
    expect(record?.changes?.stage.after).toBe('screening')
  })

  it('stores imported history as history instead of executable work', () => {
    const record = timelineFromImportedHistory({
      occurredAt: '2026-08-14T00:00:00.000Z', importedAt: '2026-09-10T00:00:00.000Z',
      type: '投递', relation: 'J27-001｜测试公司｜产品经理', event: '完成投递。', result: '已投。', opportunity,
    })
    expect(record.kind).toBe('history_imported')
    expect(record.category).toBe('opportunity')
    expect(record.opportunityId).toBe('J27-001')
  })

  it('captures rule diffs structurally', () => {
    const before = createDefaultDecisionRules('2026-09-10T00:00:00.000Z')
    const after = { ...before, hardDeadlineHorizonHours: 72, weights: { ...before.weights, urgency: 30 } }
    const changes = decisionRuleChanges(before, after)
    expect(changes.hardDeadlineHorizonHours).toEqual({ before: 48, after: 72 })
    expect(changes['weights.urgency']).toEqual({ before: 23, after: 30 })
  })

  it('backfills only facts that can be recovered from the old database', () => {
    const event: ProcessEvent = {
      id: 'evt-1', opportunityId: opportunity.id, company: opportunity.company, role: opportunity.role,
      type: 'assessment_invite', occurredAt: '2026-09-10T01:00:00.000Z', source: 'manual',
      createdAt: '2026-09-10T01:00:00.000Z', updatedAt: '2026-09-10T01:00:00.000Z',
    }
    const records = buildTimelineBackfill({ processEvents: [event], actions: [], now: '2026-09-11T00:00:00.000Z' })
    expect(records.some((item) => item.processEventId === 'evt-1')).toBe(true)
    expect(records.some((item) => item.kind === 'baseline_backfill')).toBe(true)
  })
})
''')

Path('tests/timelineImport.test.ts').write_text(r'''import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parsePJSDASWorkbook } from '../src/importExcelV2'

function sheet(rows: unknown[][]) { return XLSX.utils.aoa_to_sheet(rows) }

function syntheticHistoryFile(): File {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet([
    ['岗位ID', '公司', '具体岗位', '当前阶段', '机会角色', '抢先'],
    ['J27-001', '测试公司', '产品经理', '筛选中', '核心', '否'],
  ]), '投递总表')
  XLSX.utils.book_append_sheet(workbook, sheet([['岗位ID'], ['J27-001']]), '岗位详情')
  XLSX.utils.book_append_sheet(workbook, sheet([['公司']]), '在途流程')
  XLSX.utils.book_append_sheet(workbook, sheet([['能力包']]), '准备中心')
  XLSX.utils.book_append_sheet(workbook, sheet([['申请组ID']]), '申请组')
  XLSX.utils.book_append_sheet(workbook, sheet([
    ['说明'],
    ['日期', '类型', '关联岗位', '事件', '结果'],
    ['2026-08-14', '投递', 'J27-001｜测试公司｜产品经理', '完成测试公司产品经理投递。', '已投。'],
    ['2026-08-16', '笔试/测评', 'J27-001｜测试公司｜产品经理', '完成在线测评。', '测评完成。'],
  ]), '秋招经历')
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  return { name: 'history.xlsx', arrayBuffer: async () => bytes } as File
}

describe('Excel Timeline import', () => {
  it('imports 秋招经历 into Timeline without generating tasks from it', async () => {
    const bundle = await parsePJSDASWorkbook(syntheticHistoryFile())
    expect(bundle.timeline).toHaveLength(2)
    expect(bundle.timeline?.[0]).toMatchObject({ kind: 'history_imported', opportunityId: 'J27-001' })
    expect(bundle.actions).toHaveLength(0)
  })
})
''')

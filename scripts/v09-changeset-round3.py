from pathlib import Path

# ---------- ChangeSet domain ----------
Path('src/changeSet.ts').write_text(r'''import { validateDecisionRules, type DecisionRules } from './decisionRules'
import { progressOperationSummary, type ExecutableProgressOperation } from './progressUpdate'
import type { Action, ActionStatus, ProcessEvent } from './model'

export type ChangeSetStatus = 'pending' | 'applied' | 'discarded' | 'failed'
export type ChangeSetSource = 'natural_language' | 'rules' | 'process_event' | 'user_action' | 'api' | 'mcp'

type StripProgressMetadata<T> = T extends unknown ? Omit<T, 'sourceText' | 'confidence'> : never
export type StoredProgressOperation = StripProgressMetadata<ExecutableProgressOperation>

export type ChangeSetOperation =
  | {
      id: string
      kind: 'progress_update'
      summary: string
      operation: StoredProgressOperation
    }
  | {
      id: string
      kind: 'replace_decision_rules'
      summary: string
      expectedUpdatedAt: string
      mode: 'save' | 'reset'
      rules: DecisionRules
    }
  | {
      id: string
      kind: 'add_process_event'
      summary: string
      event: ProcessEvent
    }
  | {
      id: string
      kind: 'delete_process_event'
      summary: string
      eventId: string
    }
  | {
      id: string
      kind: 'set_action_status'
      summary: string
      actionId: string
      expectedStatus: ActionStatus
      status: ActionStatus
    }

export interface ChangeSetRecord {
  id: string
  version: 1
  source: ChangeSetSource
  status: ChangeSetStatus
  title: string
  createdAt: string
  updatedAt: string
  appliedAt?: string
  discardedAt?: string
  failedAt?: string
  error?: string
  operations: ChangeSetOperation[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validIso(value: unknown) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
}

function changeSetId(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '0')
  return `CS-${stamp}-${suffix}`
}

function baseChangeSet(source: ChangeSetSource, title: string, operations: ChangeSetOperation[], now = new Date()): ChangeSetRecord {
  const timestamp = now.toISOString()
  return {
    id: changeSetId(now),
    version: 1,
    source,
    status: 'pending',
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    operations,
  }
}

function stripProgressOperation(operation: ExecutableProgressOperation): StoredProgressOperation {
  const { sourceText: _sourceText, confidence: _confidence, ...stored } = operation
  return stored as StoredProgressOperation
}

export function createProgressChangeSet(operations: ExecutableProgressOperation[], now = new Date()) {
  const items: ChangeSetOperation[] = operations.map((operation) => ({
    id: `progress:${operation.id}`,
    kind: 'progress_update',
    summary: progressOperationSummary(operation),
    operation: stripProgressOperation(operation),
  }))
  return baseChangeSet('natural_language', `自然语言更新 · ${items.length} 项`, items, now)
}

export function restoreProgressOperation(operation: Extract<ChangeSetOperation, { kind: 'progress_update' }>, changeSetIdValue: string): ExecutableProgressOperation {
  return {
    ...operation.operation,
    sourceText: `ChangeSet ${changeSetIdValue} · ${operation.summary}`,
    confidence: 'high',
  } as ExecutableProgressOperation
}

function comparableRules(rules: DecisionRules) {
  return {
    ...rules,
    updatedAt: '',
    weights: { ...rules.weights },
  }
}

export function decisionRulesEquivalent(a: DecisionRules, b: DecisionRules) {
  return JSON.stringify(comparableRules(a)) === JSON.stringify(comparableRules(b))
}

export function createRulesChangeSet(before: DecisionRules, after: DecisionRules, mode: 'save' | 'reset', now = new Date()) {
  if (decisionRulesEquivalent(before, after)) return undefined
  const timestamp = now.toISOString()
  const proposed: DecisionRules = {
    ...after,
    key: 'current',
    version: 1,
    weights: { ...after.weights },
    updatedAt: timestamp,
  }
  return baseChangeSet('rules', mode === 'reset' ? '恢复推荐决策规则' : '修改决策规则', [{
    id: 'rules:current',
    kind: 'replace_decision_rules',
    summary: mode === 'reset' ? '恢复 PJSDAS 推荐规则' : '应用当前规则修改',
    expectedUpdatedAt: before.updatedAt,
    mode,
    rules: proposed,
  }], now)
}

function processEventName(type: ProcessEvent['type']) {
  if (type === 'assessment_invite') return '测评'
  if (type === 'written_test_invite') return '笔试'
  if (type === 'interview_invite') return '面试'
  if (type === 'offer') return 'Offer'
  if (type === 'rejection') return '流程结束'
  if (type === 'status_update') return '流程更新'
  return '流程事件'
}

export function createProcessEventChangeSet(event: ProcessEvent, now = new Date()) {
  const label = `${event.company}｜${event.role} · ${processEventName(event.type)}`
  return baseChangeSet('process_event', '记录流程通知', [{
    id: `process:add:${event.id}`,
    kind: 'add_process_event',
    summary: `记录 ${label}`,
    event,
  }], now)
}

export function createProcessEventDeleteChangeSet(event: ProcessEvent, now = new Date()) {
  return baseChangeSet('user_action', '删除错误流程事件', [{
    id: `process:delete:${event.id}`,
    kind: 'delete_process_event',
    summary: `删除 ${event.company}｜${event.role} 的 ${processEventName(event.type)}`,
    eventId: event.id,
  }], now)
}

export function createActionStatusChangeSet(action: Action, status: ActionStatus, now = new Date()) {
  if (action.status === status) return undefined
  const verb = status === 'done' ? '完成' : status === 'skipped' ? '跳过' : status === 'doing' ? '开始' : '恢复'
  return baseChangeSet('user_action', `${verb}行动`, [{
    id: `action:${action.id}:${status}`,
    kind: 'set_action_status',
    summary: `${verb}｜${action.title}`,
    actionId: action.id,
    expectedStatus: action.status,
    status,
  }], now)
}

export function validateChangeSet(value: unknown): string[] {
  const errors: string[] = []
  if (!isObject(value)) return ['ChangeSet 必须是对象。']
  if (typeof value.id !== 'string' || !value.id.trim()) errors.push('ChangeSet 缺少 ID。')
  if (value.version !== 1) errors.push('ChangeSet 版本必须为 1。')
  if (!['natural_language', 'rules', 'process_event', 'user_action', 'api', 'mcp'].includes(String(value.source))) errors.push('ChangeSet source 无效。')
  if (!['pending', 'applied', 'discarded', 'failed'].includes(String(value.status))) errors.push('ChangeSet status 无效。')
  if (typeof value.title !== 'string' || !value.title.trim()) errors.push('ChangeSet 缺少标题。')
  if (!validIso(value.createdAt) || !validIso(value.updatedAt)) errors.push('ChangeSet 时间字段无效。')
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    errors.push('ChangeSet 至少需要一个 operation。')
    return errors
  }

  for (const raw of value.operations) {
    if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.summary !== 'string') {
      errors.push('ChangeSet operation 基础字段无效。')
      continue
    }
    if (raw.kind === 'progress_update') {
      if (!isObject(raw.operation) || typeof raw.operation.kind !== 'string' || !validIso(raw.operation.occurredAt)) {
        errors.push(`ChangeSet operation ${raw.id} 的 progress payload 无效。`)
      }
      if ('sourceText' in (raw.operation as Record<string, unknown>)) errors.push(`ChangeSet operation ${raw.id} 不应持久化原始输入。`)
    } else if (raw.kind === 'replace_decision_rules') {
      if (!isObject(raw.rules)) errors.push(`ChangeSet operation ${raw.id} 缺少规则。`)
      else {
        const ruleErrors = validateDecisionRules(raw.rules as unknown as DecisionRules)
        if (ruleErrors.length) errors.push(`ChangeSet operation ${raw.id} 的规则无效：${ruleErrors[0]}`)
      }
      if (typeof raw.expectedUpdatedAt !== 'string') errors.push(`ChangeSet operation ${raw.id} 缺少规则基线版本。`)
    } else if (raw.kind === 'add_process_event') {
      if (!isObject(raw.event) || typeof raw.event.id !== 'string' || !validIso(raw.event.occurredAt)) errors.push(`ChangeSet operation ${raw.id} 的流程事件无效。`)
    } else if (raw.kind === 'delete_process_event') {
      if (typeof raw.eventId !== 'string' || !raw.eventId) errors.push(`ChangeSet operation ${raw.id} 缺少 eventId。`)
    } else if (raw.kind === 'set_action_status') {
      if (typeof raw.actionId !== 'string' || !raw.actionId) errors.push(`ChangeSet operation ${raw.id} 缺少 actionId。`)
      if (!['todo', 'doing', 'done', 'skipped'].includes(String(raw.expectedStatus)) || !['todo', 'doing', 'done', 'skipped'].includes(String(raw.status))) errors.push(`ChangeSet operation ${raw.id} 的 Action 状态无效。`)
    } else {
      errors.push(`ChangeSet operation ${raw.id} kind 无效。`)
    }
  }
  return errors
}

export function assertChangeSetValid(value: unknown): asserts value is ChangeSetRecord {
  const errors = validateChangeSet(value)
  if (errors.length) throw new Error(errors[0])
}
''')

# ---------- model: ChangeSet-aware Timeline ----------
p = Path('src/model.ts')
s = p.read_text()
s = s.replace("export type TimelineCategory = 'opportunity' | 'process' | 'action' | 'rules' | 'data' | 'note'", "export type TimelineCategory = 'opportunity' | 'process' | 'action' | 'rules' | 'change' | 'data' | 'note'")
s = s.replace("  | 'system'\nexport type TimelineKind =", "  | 'system'\n  | 'changeset'\nexport type TimelineKind =")
s = s.replace("  | 'baseline_backfill'\nexport type TimelineChangeValue", "  | 'baseline_backfill'\n  | 'change_set_applied'\nexport type TimelineChangeValue")
s = s.replace("  processEventId?: string\n  company?: string", "  processEventId?: string\n  changeSetId?: string\n  company?: string")
p.write_text(s)

# ---------- timeline: applied ChangeSet audit event ----------
p = Path('src/timeline.ts')
s = p.read_text()
s = s.replace("import type { DecisionRules } from './decisionRules'", "import type { DecisionRules } from './decisionRules'\nimport type { ChangeSetRecord } from './changeSet'")
s += r'''

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
'''
p.write_text(s)

# ---------- snapshot: include ChangeSets ----------
p = Path('src/snapshot.ts')
s = p.read_text()
s = s.replace("import { validateDecisionRules, type DecisionRules } from './decisionRules'", "import { validateDecisionRules, type DecisionRules } from './decisionRules'\nimport { validateChangeSet, type ChangeSetRecord } from './changeSet'")
s = s.replace("  timeline?: TimelineRecord[]\n  meta?: ImportMeta", "  timeline?: TimelineRecord[]\n  changeSets?: ChangeSetRecord[]\n  meta?: ImportMeta")
s = s.replace("  if (data.timeline !== undefined) assertArray(data.timeline, 'timeline')", "  if (data.timeline !== undefined) assertArray(data.timeline, 'timeline')\n  if (data.changeSets !== undefined) assertArray(data.changeSets, 'changeSets')")
s = s.replace("  if (data.timeline) assertUniqueIds(data.timeline, 'Timeline')", "  if (data.timeline) assertUniqueIds(data.timeline, 'Timeline')\n  if (data.changeSets) assertUniqueIds(data.changeSets, 'ChangeSet')")
s = s.replace("    const categories = new Set(['opportunity', 'process', 'action', 'rules', 'data', 'note'])\n    const sources = new Set(['excel', 'natural_language', 'process_event', 'user_action', 'rules', 'backup', 'system'])", "    const categories = new Set(['opportunity', 'process', 'action', 'rules', 'change', 'data', 'note'])\n    const sources = new Set(['excel', 'natural_language', 'process_event', 'user_action', 'rules', 'backup', 'system', 'changeset'])")
anchor = """  for (const raw of data.actions) {
"""
insert = """  if (data.changeSets) {
    for (const raw of data.changeSets) {
      const errors = validateChangeSet(raw)
      if (errors.length) throw new Error(`备份损坏：ChangeSet 无效（${errors[0]}）`)
    }
  }

""" + anchor
if anchor not in s: raise SystemExit('snapshot action anchor missing')
s = s.replace(anchor, insert, 1)
p.write_text(s)

# ---------- db: persist, stage and apply ChangeSets ----------
p = Path('src/db.ts')
s = p.read_text()
s = s.replace("import { createDefaultDecisionRules, validateDecisionRules, type DecisionRules } from './decisionRules'", "import { createDefaultDecisionRules, validateDecisionRules, type DecisionRules } from './decisionRules'\nimport {\n  assertChangeSetValid,\n  createActionStatusChangeSet,\n  createProcessEventChangeSet,\n  createProcessEventDeleteChangeSet,\n  createProgressChangeSet,\n  createRulesChangeSet,\n  decisionRulesEquivalent,\n  restoreProgressOperation,\n  type ChangeSetRecord,\n  type ChangeSetStatus,\n} from './changeSet'")
s = s.replace("  timelineFromRuleChange,\n} from './timeline'", "  timelineFromRuleChange,\n  timelineFromChangeSetApplied,\n} from './timeline'")
s = s.replace("import type { ProgressOperation } from './progressUpdate'", "import type { ExecutableProgressOperation, ProgressOperation } from './progressUpdate'")

old = """  timeline: {
    key: string
    value: TimelineRecord
    indexes: { 'by-occurred-at': string; 'by-category': TimelineCategory; 'by-opportunity': string }
  }
  meta: { key: string; value: ImportMeta }
"""
new = """  timeline: {
    key: string
    value: TimelineRecord
    indexes: { 'by-occurred-at': string; 'by-category': TimelineCategory; 'by-opportunity': string }
  }
  changeSets: {
    key: string
    value: ChangeSetRecord
    indexes: { 'by-status': ChangeSetStatus; 'by-created-at': string }
  }
  meta: { key: string; value: ImportMeta }
"""
if old not in s: raise SystemExit('db schema timeline anchor missing')
s = s.replace(old, new, 1)
s = s.replace("  'timeline',\n  'meta',", "  'timeline',\n  'changeSets',\n  'meta',")
s = s.replace("openDB<PJSDASDatabase>('pjsdas', 5,", "openDB<PJSDASDatabase>('pjsdas', 6,")
old = """    if (!db.objectStoreNames.contains('timeline')) {
      const store = db.createObjectStore('timeline', { keyPath: 'id' })
      store.createIndex('by-occurred-at', 'occurredAt')
      store.createIndex('by-category', 'category')
      store.createIndex('by-opportunity', 'opportunityId')
    }
    if (!db.objectStoreNames.contains('meta')) {
"""
new = """    if (!db.objectStoreNames.contains('timeline')) {
      const store = db.createObjectStore('timeline', { keyPath: 'id' })
      store.createIndex('by-occurred-at', 'occurredAt')
      store.createIndex('by-category', 'category')
      store.createIndex('by-opportunity', 'opportunityId')
    }
    if (!db.objectStoreNames.contains('changeSets')) {
      const store = db.createObjectStore('changeSets', { keyPath: 'id' })
      store.createIndex('by-status', 'status')
      store.createIndex('by-created-at', 'createdAt')
    }
    if (!db.objectStoreNames.contains('meta')) {
"""
if old not in s: raise SystemExit('db upgrade timeline anchor missing')
s = s.replace(old, new, 1)

anchor = """export async function saveDecisionRules(rules: DecisionRules) {
"""
insert = """export async function getAllChangeSets() {
  const records = await (await dbPromise).getAll('changeSets')
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function savePendingChangeSet(changeSet: ChangeSetRecord) {
  assertChangeSetValid(changeSet)
  if (changeSet.status !== 'pending') throw new Error('只能暂存 pending ChangeSet。')
  const db = await dbPromise
  const existing = await db.get('changeSets', changeSet.id)
  if (existing && existing.status === 'applied') throw new Error(`ChangeSet ${changeSet.id} 已应用，不能覆盖。`)
  await db.put('changeSets', changeSet)
  return changeSet
}

export async function discardChangeSet(id: string) {
  const db = await dbPromise
  const existing = await db.get('changeSets', id)
  if (!existing || existing.status !== 'pending') return existing
  const now = new Date().toISOString()
  const discarded: ChangeSetRecord = { ...existing, status: 'discarded', discardedAt: now, updatedAt: now }
  await db.put('changeSets', discarded)
  return discarded
}

""" + anchor
if anchor not in s: raise SystemExit('db saveDecisionRules anchor missing')
s = s.replace(anchor, insert, 1)

# export/restore snapshot includes ChangeSets
s = s.replace("const [opportunities, processes, processEvents, actions, prep, applicationGroups, decisionRules, timeline, meta] =", "const [opportunities, processes, processEvents, actions, prep, applicationGroups, decisionRules, timeline, changeSets, meta] =")
s = s.replace("      db.getAll('timeline'),\n      db.get('meta', 'lastImport'),", "      db.getAll('timeline'),\n      db.getAll('changeSets'),\n      db.get('meta', 'lastImport'),")
s = s.replace("    timeline,\n    meta,", "    timeline,\n    changeSets,\n    meta,")
s = s.replace("  for (const item of snapshot.data.timeline ?? []) await tx.objectStore('timeline').put(item)\n  await tx.objectStore('timeline').put(timelineFromRestore(snapshot.exportedAt))", "  for (const item of snapshot.data.timeline ?? []) await tx.objectStore('timeline').put(item)\n  for (const item of snapshot.data.changeSets ?? []) await tx.objectStore('changeSets').put(item)\n  await tx.objectStore('timeline').put(timelineFromRestore(snapshot.exportedAt))")

# Insert ChangeSet application API before snapshot export.
anchor = """export async function exportLocalSnapshot() {
"""
api = r'''export async function stageProgressChangeSet(operations: ExecutableProgressOperation[]) {
  if (operations.length === 0) throw new Error('没有可执行修改，无法生成 ChangeSet。')
  const changeSet = createProgressChangeSet(operations)
  return savePendingChangeSet(changeSet)
}

export async function applyDecisionRulesChangeSet(rules: DecisionRules, mode: 'save' | 'reset' = 'save') {
  const before = await getDecisionRules()
  const changeSet = createRulesChangeSet(before, rules, mode)
  if (!changeSet) return undefined
  await savePendingChangeSet(changeSet)
  return applyChangeSet(changeSet.id)
}

export async function applyProcessEventChangeSet(event: ProcessEvent) {
  const changeSet = createProcessEventChangeSet(event)
  await savePendingChangeSet(changeSet)
  return applyChangeSet(changeSet.id)
}

export async function applyProcessEventDeleteChangeSet(eventId: string) {
  const db = await dbPromise
  const event = await db.get('processEvents', eventId)
  if (!event) return undefined
  const changeSet = createProcessEventDeleteChangeSet(event)
  await savePendingChangeSet(changeSet)
  return applyChangeSet(changeSet.id)
}

export async function applyActionStatusChangeSet(actionId: string, status: Action['status']) {
  const db = await dbPromise
  const action = await db.get('actions', actionId)
  if (!action) return undefined
  const changeSet = createActionStatusChangeSet(action, status)
  if (!changeSet) return undefined
  await savePendingChangeSet(changeSet)
  return applyChangeSet(changeSet.id)
}

async function markChangeSetFailed(changeSet: ChangeSetRecord, caught: unknown) {
  const now = new Date().toISOString()
  const failed: ChangeSetRecord = {
    ...changeSet,
    status: 'failed',
    failedAt: now,
    updatedAt: now,
    error: caught instanceof Error ? caught.message : String(caught),
  }
  await (await dbPromise).put('changeSets', failed)
}

export async function applyChangeSet(id: string) {
  const db = await dbPromise
  const changeSet = await db.get('changeSets', id)
  if (!changeSet) throw new Error(`找不到 ChangeSet ${id}。`)
  assertChangeSetValid(changeSet)
  if (changeSet.status === 'applied') return changeSet
  if (changeSet.status !== 'pending') throw new Error(`ChangeSet ${id} 当前状态为 ${changeSet.status}，不能应用。`)

  try {
    for (const operation of changeSet.operations) {
      if (operation.kind === 'progress_update') {
        await applyProgressUpdate([restoreProgressOperation(operation, changeSet.id)])
        continue
      }

      if (operation.kind === 'replace_decision_rules') {
        const current = await getDecisionRules()
        const alreadyApplied = decisionRulesEquivalent(current, operation.rules)
        if (!alreadyApplied && current.updatedAt !== operation.expectedUpdatedAt) {
          throw new Error('决策规则在 ChangeSet 创建后已发生变化，请重新审阅再应用。')
        }
        if (!alreadyApplied) await saveDecisionRules(operation.rules)
        continue
      }

      if (operation.kind === 'add_process_event') {
        await addProcessEvent(operation.event)
        continue
      }

      if (operation.kind === 'delete_process_event') {
        await deleteProcessEvent(operation.eventId)
        continue
      }

      const action = await db.get('actions', operation.actionId)
      if (!action) throw new Error(`Action ${operation.actionId} 已不存在。`)
      if (action.status === operation.status) continue
      if (action.status !== operation.expectedStatus) {
        throw new Error(`Action ${operation.actionId} 状态已经变化，请重新操作。`)
      }
      await updateActionStatus(operation.actionId, operation.status)
    }

    const appliedAt = new Date().toISOString()
    const applied: ChangeSetRecord = {
      ...changeSet,
      status: 'applied',
      appliedAt,
      updatedAt: appliedAt,
      error: undefined,
      failedAt: undefined,
    }
    const tx = db.transaction(['changeSets', 'timeline'], 'readwrite')
    await tx.objectStore('changeSets').put(applied)
    await tx.objectStore('timeline').put(timelineFromChangeSetApplied(applied))
    await tx.done
    return applied
  } catch (caught) {
    await markChangeSetFailed(changeSet, caught)
    throw caught
  }
}

''' + anchor
if anchor not in s: raise SystemExit('db export snapshot anchor missing')
s = s.replace(anchor, api, 1)
p.write_text(s)

# ---------- App: load ChangeSets, action mutations use ChangeSet, release label v0.9 ----------
p = Path('src/AppV5.tsx')
s = p.read_text()
s = s.replace("  getAllTimelineRecords,\n  getLastImport,", "  getAllTimelineRecords,\n  getAllChangeSets,\n  getLastImport,")
s = s.replace("  updateActionStatus,\n} from './db'", "  applyActionStatusChangeSet,\n} from './db'")
s = s.replace("import TimelineView from './TimelineView'", "import TimelineView from './TimelineView'\nimport type { ChangeSetRecord } from './changeSet'")
s = s.replace("  const [timeline, setTimeline] = useState<TimelineRecord[]>([])", "  const [timeline, setTimeline] = useState<TimelineRecord[]>([])\n  const [changeSets, setChangeSets] = useState<ChangeSetRecord[]>([])")
s = s.replace("const [nextOpportunities, nextActions, nextProcesses, nextPrep, nextGroups, nextRules, nextTimeline, nextImport] =", "const [nextOpportunities, nextActions, nextProcesses, nextPrep, nextGroups, nextRules, nextTimeline, nextChangeSets, nextImport] =")
s = s.replace("        getAllTimelineRecords(),\n        getLastImport(),", "        getAllTimelineRecords(),\n        getAllChangeSets(),\n        getLastImport(),")
s = s.replace("    setTimeline(nextTimeline)\n    setLastImport(nextImport)", "    setTimeline(nextTimeline)\n    setChangeSets(nextChangeSets)\n    setLastImport(nextImport)")
s = s.replace("    await updateActionStatus(id, status)", "    await applyActionStatusChangeSet(id, status)")
s = s.replace("<span>Local-first · v0.8</span>", "<span>Local-first · v0.9</span>")
s = s.replace("<TimelineView records={timeline} />", "<TimelineView records={timeline} changeSets={changeSets} />")
p.write_text(s)

# ---------- Progress Inbox: pending ChangeSet is the review object ----------
p = Path('src/ProgressInbox.tsx')
s = p.read_text()
s = s.replace("import { applyProgressUpdate, getAllOpportunities } from './db'", "import { applyChangeSet, discardChangeSet, getAllOpportunities, stageProgressChangeSet } from './db'")
s = s.replace("import type { Opportunity } from './model'", "import type { Opportunity } from './model'\nimport type { ChangeSetRecord } from './changeSet'")
s = s.replace("  const [plan, setPlan] = useState<ProgressUpdatePlan | null>(null)", "  const [plan, setPlan] = useState<ProgressUpdatePlan | null>(null)\n  const [changeSet, setChangeSet] = useState<ChangeSetRecord | null>(null)")

old = r'''  async function parse() {
    setMessage('')
    setError('')
    if (!text.trim()) {
      setError('先输入最近的求职历程或接下来安排。')
      return
    }
    let current = opportunities
    if (current.length === 0) {
      current = await getAllOpportunities()
      setOpportunities(current)
    }
    if (current.length === 0) {
      setError('还没有岗位基线，请先导入一次秋招投递表。之后即可只用自然语言维护。')
      return
    }
    setPlan(parseProgressUpdate(text, current, new Date()))
  }
'''
new = r'''  async function parse() {
    setMessage('')
    setError('')
    if (!text.trim()) {
      setError('先输入最近的求职历程或接下来安排。')
      return
    }
    setBusy(true)
    try {
      let current = opportunities
      if (current.length === 0) {
        current = await getAllOpportunities()
        setOpportunities(current)
      }
      if (current.length === 0) {
        setError('还没有岗位基线，请先导入一次秋招投递表。之后即可只用自然语言维护。')
        return
      }
      if (changeSet?.status === 'pending') await discardChangeSet(changeSet.id)
      const nextPlan = parseProgressUpdate(text, current, new Date())
      const nextChangeSet = nextPlan.executable.length > 0
        ? await stageProgressChangeSet(nextPlan.executable)
        : null
      setPlan(nextPlan)
      setChangeSet(nextChangeSet)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法生成 ChangeSet。')
    } finally {
      setBusy(false)
    }
  }

  async function close() {
    if (changeSet?.status === 'pending') await discardChangeSet(changeSet.id)
    setPlan(null)
    setChangeSet(null)
    setOpen(false)
  }
'''
if old not in s: raise SystemExit('ProgressInbox parse block missing')
s = s.replace(old, new, 1)

old = r'''  async function confirm() {
    if (!plan || plan.executable.length === 0) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await applyProgressUpdate(plan.executable)
      const notes: string[] = []
      if (plan.unresolved.length > 0) notes.push(`${plan.unresolved.length} 条歧义未写入`)
      if (plan.ignored.length > 0) notes.push(`${plan.ignored.length} 条背景记录无需写入`)
      setMessage(`已应用 ${result.applied} 项更新${notes.length ? `；${notes.join('，')}。` : '。'}`)
      setText('')
      setPlan(null)
      setOpportunities(await getAllOpportunities())
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '更新失败。')
    } finally {
      setBusy(false)
    }
  }
'''
new = r'''  async function confirm() {
    if (!plan || !changeSet || plan.executable.length === 0) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const applied = await applyChangeSet(changeSet.id)
      const notes: string[] = []
      if (plan.unresolved.length > 0) notes.push(`${plan.unresolved.length} 条歧义未写入`)
      if (plan.ignored.length > 0) notes.push(`${plan.ignored.length} 条背景记录无需写入`)
      setMessage(`ChangeSet ${applied.id} 已应用 ${applied.operations.length} 项修改${notes.length ? `；${notes.join('，')}。` : '。'}`)
      setText('')
      setPlan(null)
      setChangeSet(null)
      setOpportunities(await getAllOpportunities())
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '更新失败。')
    } finally {
      setBusy(false)
    }
  }
'''
if old not in s: raise SystemExit('ProgressInbox confirm block missing')
s = s.replace(old, new, 1)
s = s.replace("<div className=\"progress-inbox-backdrop\" onMouseDown={() => setOpen(false)}>", "<div className=\"progress-inbox-backdrop\" onMouseDown={() => { void close() }}>")
s = s.replace("onClick={() => setOpen(false)} aria-label=\"关闭\"", "onClick={() => { void close() }} aria-label=\"关闭\"")
s = s.replace("系统先生成变更清单，只有你确认后才修改本地数据库；原文默认不保存。", "系统先生成持久化 ChangeSet，只有你确认后才修改业务数据；ChangeSet 只保存规范化修改，原始输入默认不保存。")
s = s.replace("<button className=\"primary-button\" type=\"button\" onClick={parse} disabled={busy}>解析更新</button>", "<button className=\"primary-button\" type=\"button\" onClick={parse} disabled={busy}>{busy ? '处理中…' : '解析并生成 ChangeSet'}</button>")
s = s.replace("<div className=\"eyebrow\">REVIEW DIFF</div>\n                    <h3>准备执行 {plan.executable.length} 项修改</h3>", "<div className=\"eyebrow\">CHANGESET · {changeSet?.id ?? 'NO WRITABLE CHANGE'}</div>\n                    <h3>准备执行 {plan.executable.length} 项修改</h3>")
s = s.replace("确认后会直接更新 Opportunities / Pipeline / Process Events / Actions，并立即重算 Today。", "确认后由 ChangeSet 统一更新 Opportunities / Pipeline / Process Events / Actions；应用结果进入 Timeline，并立即重算 Today。")
s = s.replace("disabled={busy || plan.executable.length === 0}", "disabled={busy || !changeSet || plan.executable.length === 0}")
s = s.replace("{busy ? '更新中…' : `确认并应用 ${plan.executable.length} 项`}", "{busy ? '应用中…' : `确认并应用 ChangeSet · ${plan.executable.length} 项`}")
p.write_text(s)

# ---------- Rules: explicit user save still goes through ChangeSet ----------
p = Path('src/RulesView.tsx')
s = p.read_text()
s = s.replace("import { resetDecisionRules, saveDecisionRules } from './db'", "import { applyDecisionRulesChangeSet } from './db'")
s = s.replace("      await saveDecisionRules(draft)\n      await onChanged()\n      setMessage(zh ? '规则已保存，Today 已按新规则重新计算。' : 'Rules saved. Today has been recalculated.')", "      const changeSet = await applyDecisionRulesChangeSet(draft, 'save')\n      await onChanged()\n      setMessage(changeSet ? (zh ? `ChangeSet ${changeSet.id} 已应用，Today 已按新规则重新计算。` : `ChangeSet ${changeSet.id} applied. Today has been recalculated.`) : (zh ? '规则没有变化。' : 'No rule changes.'))")
s = s.replace("      await resetDecisionRules()\n      await onChanged()\n      setMessage(zh ? '已恢复 PJSDAS 推荐规则。' : 'Recommended PJSDAS rules restored.')", "      const changeSet = await applyDecisionRulesChangeSet(DEFAULT_DECISION_RULES, 'reset')\n      await onChanged()\n      setMessage(changeSet ? (zh ? `ChangeSet ${changeSet.id} 已应用，已恢复 PJSDAS 推荐规则。` : `ChangeSet ${changeSet.id} applied. Recommended rules restored.`) : (zh ? '当前已经是推荐规则。' : 'Recommended rules are already active.'))")
s = s.replace("未来 ChatGPT / MCP 修改规则时也会使用同一份结构化规则对象。", "网站、未来 ChatGPT / MCP 都通过同一种 ChangeSet 修改这份结构化规则。")
s = s.replace("Future ChatGPT / MCP rule changes will target this same structured rule object.", "Website edits and future ChatGPT / MCP changes use the same ChangeSet protocol for this structured rule object.")
p.write_text(s)

# ---------- Process Event dock: direct explicit edits become immediately-applied ChangeSets ----------
p = Path('src/ProcessEventDock.tsx')
s = p.read_text()
s = s.replace("  addProcessEvent,\n  deleteProcessEvent,", "  applyProcessEventChangeSet,\n  applyProcessEventDeleteChangeSet,")
s = s.replace("      await addProcessEvent(processEvent)", "      await applyProcessEventChangeSet(processEvent)")
s = s.replace("      await deleteProcessEvent(id)", "      await applyProcessEventDeleteChangeSet(id)")
p.write_text(s)

# ---------- FixedEventGuard: completion goes through ChangeSet ----------
p = Path('src/FixedEventGuard.tsx')
s = p.read_text()
s = s.replace("import { getAllActions, updateActionStatus } from './db'", "import { applyActionStatusChangeSet, getAllActions } from './db'")
s = s.replace("await updateActionStatus(current.id, 'done')", "await applyActionStatusChangeSet(current.id, 'done')")
p.write_text(s)

# ---------- Timeline UI: ChangeSet ledger ----------
p = Path('src/TimelineView.tsx')
s = p.read_text()
s = s.replace("import type { TimelineCategory, TimelineRecord, TimelineSource } from './model'", "import type { TimelineCategory, TimelineRecord, TimelineSource } from './model'\nimport type { ChangeSetRecord, ChangeSetSource, ChangeSetStatus } from './changeSet'")
s = s.replace("const categories: TimelineCategory[] = ['opportunity', 'process', 'action', 'rules', 'data', 'note']", "const categories: TimelineCategory[] = ['opportunity', 'process', 'action', 'rules', 'change', 'data', 'note']")
s = s.replace("const sources: TimelineSource[] = ['excel', 'natural_language', 'process_event', 'user_action', 'rules', 'backup', 'system']", "const sources: TimelineSource[] = ['excel', 'natural_language', 'process_event', 'user_action', 'rules', 'backup', 'system', 'changeset']")
s = s.replace("  rules: ['规则', 'Rules'],\n  data:", "  rules: ['规则', 'Rules'],\n  change: ['变更集', 'ChangeSet'],\n  data:")
s = s.replace("  system: ['系统回填', 'System'],\n}", "  system: ['系统回填', 'System'],\n  changeset: ['ChangeSet', 'ChangeSet'],\n}\n\nconst changeSetSourceLabels: Record<ChangeSetSource, [string, string]> = {\n  natural_language: ['自然语言', 'Natural language'],\n  rules: ['规则设置', 'Rules'],\n  process_event: ['流程通知', 'Process event'],\n  user_action: ['用户操作', 'User action'],\n  api: ['API', 'API'],\n  mcp: ['MCP', 'MCP'],\n}\n\nconst changeSetStatusLabels: Record<ChangeSetStatus, [string, string]> = {\n  pending: ['待确认', 'Pending'],\n  applied: ['已应用', 'Applied'],\n  discarded: ['已放弃', 'Discarded'],\n  failed: ['失败', 'Failed'],\n}")
s = s.replace("export default function TimelineView({ records }: { records: TimelineRecord[] }) {", "export default function TimelineView({ records, changeSets }: { records: TimelineRecord[]; changeSets: ChangeSetRecord[] }) {")
s = s.replace("        <div><span>{zh ? '机会 / 投递' : 'Opportunity / apply'}</span><strong>{records.filter((item) => item.category === 'opportunity').length}</strong></div>\n      </div>", "        <div><span>{zh ? '机会 / 投递' : 'Opportunity / apply'}</span><strong>{records.filter((item) => item.category === 'opportunity').length}</strong></div>\n        <div><span>ChangeSet</span><strong>{changeSets.filter((item) => item.status === 'applied').length}</strong></div>\n      </div>\n\n      <details className=\"changeset-ledger\">\n        <summary>\n          <div><span className=\"eyebrow\">CHANGESET LEDGER</span><strong>{zh ? '变更集账本' : 'ChangeSet ledger'}</strong></div>\n          <span>{changeSets.filter((item) => item.status === 'pending').length} {zh ? '条待确认' : 'pending'} · {changeSets.length} {zh ? '条记录' : 'records'}</span>\n        </summary>\n        <p>{zh ? '这里保存规范化修改和应用状态，不保存自然语言更新的完整原文。未来 API / MCP 也使用同一种协议。' : 'This ledger stores normalized changes and application status, not the full raw text of natural-language updates. Future API / MCP integrations use the same protocol.'}</p>\n        {changeSets.length === 0 ? <div className=\"changeset-empty\">{zh ? '还没有 ChangeSet。' : 'No ChangeSets yet.'}</div> : (\n          <div className=\"changeset-list\">\n            {changeSets.slice(0, 8).map((item) => (\n              <article className={`changeset-item status-${item.status}`} key={item.id}>\n                <div>\n                  <strong>{item.title}</strong>\n                  <small>{item.id} · {changeSetSourceLabels[item.source][zh ? 0 : 1]} · {item.operations.length} {zh ? '项' : 'ops'}</small>\n                </div>\n                <span>{changeSetStatusLabels[item.status][zh ? 0 : 1]}</span>\n              </article>\n            ))}\n          </div>\n        )}\n      </details>")
s = s.replace("                        <span>{formatTime(item.occurredAt, zh)}</span>", "                        <span>{formatTime(item.occurredAt, zh)}</span>\n                        {item.changeSetId ? <span>{item.changeSetId}</span> : null}")
p.write_text(s)

p = Path('src/timeline.css')
s = p.read_text()
s = s.replace("grid-template-columns:repeat(3,minmax(0,1fr))", "grid-template-columns:repeat(4,minmax(0,1fr))", 1)
s += r'''
.changeset-ledger { margin:0 0 18px; border:1px solid rgba(49,46,42,.12); border-radius:18px; background:rgba(255,255,255,.66); overflow:hidden; }
.changeset-ledger > summary { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:16px 18px; cursor:pointer; list-style:none; }
.changeset-ledger > summary::-webkit-details-marker { display:none; }
.changeset-ledger > summary > div { display:grid; gap:3px; }
.changeset-ledger > summary strong { color:#302e2a; font-size:14px; }
.changeset-ledger > summary > span { color:#8b857d; font-size:11px; font-variant-numeric:tabular-nums; }
.changeset-ledger > p { margin:0; padding:0 18px 13px; color:#7b756d; font-size:12px; line-height:1.6; }
.changeset-list { display:grid; border-top:1px solid rgba(49,46,42,.08); }
.changeset-item { display:flex; justify-content:space-between; gap:18px; padding:12px 18px; border-bottom:1px solid rgba(49,46,42,.07); }
.changeset-item:last-child { border-bottom:0; }
.changeset-item > div { display:grid; gap:3px; min-width:0; }
.changeset-item strong { color:#37342f; font-size:12.5px; }
.changeset-item small { color:#969087; font-size:10.5px; overflow-wrap:anywhere; }
.changeset-item > span { align-self:center; border:1px solid rgba(49,46,42,.1); border-radius:999px; padding:4px 8px; background:#f6f3ed; color:#6d675f; font-size:10.5px; white-space:nowrap; }
.changeset-item.status-pending > span { background:#fff4d9; color:#8b651c; }
.changeset-item.status-failed > span { background:#fbe8e4; color:#9a4c3d; }
.changeset-item.status-applied > span { background:#edf3ed; color:#526654; }
.changeset-empty { padding:14px 18px; border-top:1px solid rgba(49,46,42,.08); color:#99938b; font-size:12px; }
.timeline-event.category-change .timeline-marker span { background:#4f6571; }
@media (max-width:900px) { .timeline-summary { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:620px) { .timeline-summary { grid-template-columns:1fr; } .changeset-ledger > summary { align-items:flex-start; flex-direction:column; } }
'''
p.write_text(s)

# ---------- Local backup UI: surface ChangeSet count ----------
p = Path('src/LocalBackupDock.tsx')
s = p.read_text()
s = s.replace("`${snapshot.data.opportunities.length} 个岗位、${snapshot.data.processEvents.length} 条流程事件、${snapshot.data.actions.length} 个 Action。`", "`${snapshot.data.opportunities.length} 个岗位、${snapshot.data.processEvents.length} 条流程事件、${snapshot.data.actions.length} 个 Action、${snapshot.data.changeSets?.length ?? 0} 个 ChangeSet。`")
s = s.replace("                  <span>申请组 <strong>{preview.data.applicationGroups.length}</strong></span>", "                  <span>申请组 <strong>{preview.data.applicationGroups.length}</strong></span>\n                  <span>ChangeSet <strong>{preview.data.changeSets?.length ?? 0}</strong></span>")
p.write_text(s)

# ---------- README: v0.9 architecture ----------
p = Path('README.md')
s = p.read_text()
s = s.replace("- **Prep** — reusable preparation across multiple opportunities\n", "- **Prep** — reusable preparation across multiple opportunities\n- **Timeline** — first-class chronological facts and audit history across applications, process events, actions, rule changes and data migrations\n- **Rules** — editable, persisted decision policy used by Today instead of hidden constants\n- **ChangeSet** — the single normalized mutation protocol used by natural-language updates and explicit product actions before state is changed\n")
s = s.replace("PJSDAS separates job-search state into six concepts:", "PJSDAS separates job-search state into nine concepts:")
s = s.replace("6. **Today** — the constrained action plan produced by the decision engine under the user's available time.", "6. **Decision Rules** — explicit user-controlled policy for deadlines, planning limits, visibility horizons and ranking weights.\n7. **Timeline** — durable facts about what happened and how the workspace changed.\n8. **ChangeSet** — a reviewable set of normalized mutations with an ID, source and application status.\n9. **Today** — the constrained action plan produced by the decision engine under the user's available time.")
s = s.replace("6. shows a structured diff before any write occurs;\n7. applies only confirmed, executable changes to Opportunities / Pipeline / Process Events / Actions;\n8. leaves ambiguous clauses unresolved instead of guessing.", "6. converts executable changes into a persistent ChangeSet without storing the full raw input;\n7. shows the ChangeSet as a structured diff before any business-state write occurs;\n8. applies only the confirmed ChangeSet to Opportunities / Pipeline / Process Events / Actions and records the application in Timeline;\n9. leaves ambiguous clauses unresolved instead of guessing.")
s = s.replace("- last-import metadata\n", "- Decision Rules\n- Timeline\n- ChangeSets and their application status\n- last-import metadata\n")
status_start = "## Status\n\n"
if status_start in s:
    before, _sep, rest = s.partition(status_start)
    s = before + status_start + "**v0.9** makes PJSDAS's decision and mutation layers explicit. Decision Rules are persisted user-controlled data, Timeline is a first-class factual history, and ChangeSet is the unified review/apply protocol for normalized mutations. Natural-language updates no longer write business state directly: they stage a ChangeSet, the user reviews it, and only confirmation applies it. Explicit UI actions use the same protocol with the click/save action serving as confirmation. Excel remains initialization/history migration and recovery rather than the daily source of truth. Cloud sync, account login, MCP/ChatGPT integration and automatic job discovery remain outside v0.9.\n"
p.write_text(s)

# ---------- tests ----------
Path('tests/changeSet.test.ts').write_text(r'''import { describe, expect, it } from 'vitest'
import {
  createActionStatusChangeSet,
  createProgressChangeSet,
  createRulesChangeSet,
  decisionRulesEquivalent,
  restoreProgressOperation,
  validateChangeSet,
} from '../src/changeSet'
import { createDefaultDecisionRules } from '../src/decisionRules'
import { timelineFromChangeSetApplied } from '../src/timeline'
import type { Action } from '../src/model'
import type { ExecutableProgressOperation } from '../src/progressUpdate'

describe('ChangeSet protocol', () => {
  it('persists normalized natural-language changes without raw input text', () => {
    const operation: ExecutableProgressOperation = {
      id: 'nl:test:manual',
      kind: 'manual_action',
      sourceText: '这是一整段不应该进入持久化 ChangeSet 的原始输入',
      confidence: 'high',
      occurredAt: '2026-09-11T01:00:00.000Z',
      title: '完成毕业生源信息校对',
      estimatedMinutes: 20,
    }
    const changeSet = createProgressChangeSet([operation], new Date('2026-09-11T01:10:00.000Z'))
    expect(validateChangeSet(changeSet)).toEqual([])
    expect(JSON.stringify(changeSet)).not.toContain(operation.sourceText)
    expect(changeSet.operations[0].summary).toContain('毕业生源信息校对')

    const restored = restoreProgressOperation(changeSet.operations[0] as Extract<typeof changeSet.operations[number], { kind: 'progress_update' }>, changeSet.id)
    expect(restored.kind).toBe('manual_action')
    expect(restored.sourceText).toContain(changeSet.id)
  })

  it('creates an optimistic-concurrency rule ChangeSet only when rules differ', () => {
    const before = createDefaultDecisionRules('2026-09-11T00:00:00.000Z')
    const after = { ...before, hardDeadlineHorizonHours: 72 }
    const changeSet = createRulesChangeSet(before, after, 'save', new Date('2026-09-11T01:00:00.000Z'))
    expect(changeSet).toBeTruthy()
    expect(changeSet!.operations[0]).toMatchObject({
      kind: 'replace_decision_rules',
      expectedUpdatedAt: before.updatedAt,
    })
    expect(createRulesChangeSet(before, before, 'save')).toBeUndefined()
    expect(decisionRulesEquivalent(before, { ...before, updatedAt: '2030-01-01T00:00:00.000Z' })).toBe(true)
  })

  it('represents explicit action completion with the same protocol', () => {
    const action: Action = {
      id: 'event-action:test',
      kind: 'manual',
      title: '完成在线测评',
      estimatedMinutes: 30,
      leverage: 80,
      delayCost: 90,
      status: 'todo',
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    }
    const changeSet = createActionStatusChangeSet(action, 'done', new Date('2026-09-11T01:00:00.000Z'))!
    expect(changeSet.source).toBe('user_action')
    expect(changeSet.operations[0]).toMatchObject({ kind: 'set_action_status', expectedStatus: 'todo', status: 'done' })
    expect(validateChangeSet(changeSet)).toEqual([])
  })

  it('creates a Timeline audit record for an applied ChangeSet', () => {
    const operation: ExecutableProgressOperation = {
      id: 'nl:test:task',
      kind: 'manual_action',
      sourceText: '原文',
      confidence: 'high',
      occurredAt: '2026-09-11T01:00:00.000Z',
      title: '测试任务',
      estimatedMinutes: 20,
    }
    const pending = createProgressChangeSet([operation], new Date('2026-09-11T01:10:00.000Z'))
    const applied = { ...pending, status: 'applied' as const, appliedAt: '2026-09-11T01:12:00.000Z', updatedAt: '2026-09-11T01:12:00.000Z' }
    const record = timelineFromChangeSetApplied(applied)
    expect(record.category).toBe('change')
    expect(record.changeSetId).toBe(applied.id)
    expect(record.detail).toContain('测试任务')
  })
})
''')

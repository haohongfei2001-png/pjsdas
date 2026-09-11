import { openDB, type DBSchema } from 'idb'
import { assertImportBundleSafe } from './importDiagnostics.js'
import {
  actionForProcessEvent,
  overlayProcessEventsOnOpportunities,
  overlayProcessEventsOnProcesses,
  reconcileProcessEventActions,
  suppressSupersededActions,
} from './processEvents.js'
import { mergeActionsForReimport } from './reimportState.js'
import { createSnapshot, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import { createDefaultDecisionRules, decisionRulesForSnapshot, validateDecisionRules, type DecisionRules } from './decisionRules.js'
import {
  assertChangeSetValid,
  createActionStatusChangeSet,
  createProcessEventChangeSet,
  createProcessEventDeleteChangeSet,
  createProgressChangeSet,
  createRulesChangeSet,
  decisionRulesEquivalent,
  restoreProgressOperation,
  type ChangeSetRecord,
  type ChangeSetStatus,
} from './changeSet.js'
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
  timelineFromChangeSetApplied,
} from './timeline.js'
import type { ExecutableProgressOperation, ProgressOperation } from './progressUpdate.js'
import type {
  Action,
  ApplicationGroup,
  ImportBundle,
  ImportMeta,
  Opportunity,
  Prep,
  ProcessEvent,
  ProcessRecord,
  TimelineCategory,
  TimelineRecord,
} from './model.js'

interface PJSDASDatabase extends DBSchema {
  opportunities: { key: string; value: Opportunity }
  processes: {
    key: string
    value: ProcessRecord
    indexes: { 'by-opportunity': string }
  }
  processEvents: {
    key: string
    value: ProcessEvent
    indexes: { 'by-opportunity': string }
  }
  actions: {
    key: string
    value: Action
    indexes: { 'by-opportunity': string }
  }
  prep: { key: string; value: Prep }
  applicationGroups: { key: string; value: ApplicationGroup }
  decisionRules: { key: string; value: DecisionRules }
  timeline: {
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
}

const DATA_STORES = [
  'opportunities',
  'processes',
  'processEvents',
  'actions',
  'prep',
  'applicationGroups',
  'decisionRules',
  'timeline',
  'changeSets',
  'meta',
] as const

export const dbPromise = openDB<PJSDASDatabase>('pjsdas', 6, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('opportunities')) {
      db.createObjectStore('opportunities', { keyPath: 'id' })
    }
    if (!db.objectStoreNames.contains('processes')) {
      const store = db.createObjectStore('processes', { keyPath: 'id' })
      store.createIndex('by-opportunity', 'opportunityId')
    }
    if (!db.objectStoreNames.contains('processEvents')) {
      const store = db.createObjectStore('processEvents', { keyPath: 'id' })
      store.createIndex('by-opportunity', 'opportunityId')
    }
    if (!db.objectStoreNames.contains('actions')) {
      const store = db.createObjectStore('actions', { keyPath: 'id' })
      store.createIndex('by-opportunity', 'opportunityId')
    }
    if (!db.objectStoreNames.contains('prep')) {
      db.createObjectStore('prep', { keyPath: 'id' })
    }
    if (!db.objectStoreNames.contains('applicationGroups')) {
      db.createObjectStore('applicationGroups', { keyPath: 'id' })
    }
    if (!db.objectStoreNames.contains('decisionRules')) {
      db.createObjectStore('decisionRules', { keyPath: 'key' })
    }
    if (!db.objectStoreNames.contains('timeline')) {
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
      db.createObjectStore('meta', { keyPath: 'key' })
    }
  },
})

async function effectiveOpportunities(db: Awaited<typeof dbPromise>) {
  const [opportunities, processes, events] = await Promise.all([
    db.getAll('opportunities'),
    db.getAll('processes'),
    db.getAll('processEvents'),
  ])
  return overlayProcessEventsOnOpportunities(opportunities, events, processes)
}

export async function getAllOpportunities() {
  return effectiveOpportunities(await dbPromise)
}

export async function getAllActions() {
  const db = await dbPromise
  const [actions, opportunities, events] = await Promise.all([
    db.getAll('actions'),
    effectiveOpportunities(db),
    db.getAll('processEvents'),
  ])
  return suppressSupersededActions(
    reconcileProcessEventActions(actions, events),
    opportunities,
  )
}

export async function getAllProcesses() {
  const db = await dbPromise
  const [processes, opportunities, events, actions] = await Promise.all([
    db.getAll('processes'),
    db.getAll('opportunities'),
    db.getAll('processEvents'),
    db.getAll('actions'),
  ])
  return overlayProcessEventsOnProcesses(processes, opportunities, events, actions)
}

export async function getAllProcessEvents() {
  return (await dbPromise).getAll('processEvents')
}

export async function getAllPrep() {
  return (await dbPromise).getAll('prep')
}

export async function getAllApplicationGroups() {
  return (await dbPromise).getAll('applicationGroups')
}

export async function getLastImport() {
  return (await dbPromise).get('meta', 'lastImport')
}

export async function getDecisionRules() {
  const stored = await (await dbPromise).get('decisionRules', 'current')
  return stored ?? decisionRulesForSnapshot()
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

export async function getAllChangeSets() {
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
  const stored = await db.get('actions', id)
  const action = stored ?? (await getAllActions()).find((item) => item.id === id)
  if (!action || action.status === status) return
  const now = new Date().toISOString()
  const tx = db.transaction(['actions', 'timeline'], 'readwrite')
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

function defaultLocalOpportunity(
  operation: Extract<ProgressOperation, { kind: 'upsert_opportunity' }>,
): Opportunity {
  const submitted = operation.mode === 'submitted'
  return {
    id: operation.opportunityId,
    company: operation.company,
    role: operation.role,
    currentStageLabel: submitted ? '筛选中' : '待投',
    processStage: submitted ? 'screening' : 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 86,
    fitScore: 60,
    locallyManaged: true,
    importedAt: operation.occurredAt,
  }
}

async function upsertLocalProcess(
  processStore: ReturnType<Awaited<typeof dbPromise>['transaction']>['objectStore'] extends never ? never : any,
  opportunity: Opportunity,
  stage: ProcessRecord['stage'],
  stageLabel: string,
  occurredAt: string,
) {
  const existing = await processStore.index('by-opportunity').getAll(opportunity.id) as ProcessRecord[]
  if (existing.length > 0) {
    for (const process of existing) {
      await processStore.put({
        ...process,
        company: opportunity.company,
        role: opportunity.role,
        stage,
        stageLabel,
        lastProgressAt: occurredAt,
        nextCheckAt: undefined,
        silenceRisk: undefined,
        currentAction: undefined,
        locallyManaged: true,
      })
    }
    return
  }

  await processStore.put({
    id: `local-process:${opportunity.id}`,
    opportunityId: opportunity.id,
    company: opportunity.company,
    role: opportunity.role,
    stage,
    stageLabel,
    lastProgressAt: occurredAt,
    locallyManaged: true,
  })
}

export async function applyProgressUpdate(operations: ProgressOperation[]) {
  const executable = operations.filter((item) => item.kind !== 'unresolved' && item.kind !== 'ignored')
  if (executable.length === 0) return { applied: 0 }

  const db = await dbPromise
  const tx = db.transaction(['opportunities', 'processes', 'processEvents', 'actions', 'timeline'], 'readwrite')
  const opportunityStore = tx.objectStore('opportunities')
  const processStore = tx.objectStore('processes')
  const eventStore = tx.objectStore('processEvents')
  const actionStore = tx.objectStore('actions')
  const timelineStore = tx.objectStore('timeline')

  for (const operation of executable) {
    if (operation.kind === 'upsert_opportunity') {
      const existing = await opportunityStore.get(operation.opportunityId)
      const submitted = operation.mode === 'submitted'
      const opportunity: Opportunity = existing
        ? {
            ...existing,
            company: operation.company,
            role: operation.role,
            currentStageLabel: submitted ? '筛选中' : existing.currentStageLabel,
            processStage: submitted ? 'screening' : existing.processStage,
            locallyManaged: true,
          }
        : defaultLocalOpportunity(operation)
      await opportunityStore.put(opportunity)

      const applyId = `apply:${opportunity.id}`
      const existingApply = await actionStore.get(applyId)
      if (submitted) {
        if (existingApply && (existingApply.status === 'todo' || existingApply.status === 'doing')) {
          await actionStore.put({ ...existingApply, status: 'done', updatedAt: operation.occurredAt })
        }
        await upsertLocalProcess(processStore, opportunity, 'screening', '筛选中', operation.occurredAt)
      } else if (!existingApply) {
        await actionStore.put({
          id: applyId,
          kind: 'apply',
          title: `投递 ${opportunity.company}｜${opportunity.role}`,
          opportunityId: opportunity.id,
          estimatedMinutes: 45,
          leverage: 86,
          delayCost: 40,
          status: 'todo',
          sourceLabel: '自然语言更新',
          createdAt: operation.occurredAt,
          updatedAt: operation.occurredAt,
        })
      }
      const record = timelineFromProgressOperation(operation, existing)
      if (record) await timelineStore.put(record)
      continue
    }

    if (operation.kind === 'rename_opportunity') {
      const existing = await opportunityStore.get(operation.opportunityId)
      if (!existing) continue
      const opportunity: Opportunity = {
        ...existing,
        company: operation.company,
        role: operation.newRole,
        locallyManaged: true,
      }
      await opportunityStore.put(opportunity)

      const processes = await processStore.index('by-opportunity').getAll(operation.opportunityId) as ProcessRecord[]
      for (const process of processes) {
        await processStore.put({ ...process, company: operation.company, role: operation.newRole, locallyManaged: true })
      }
      const actions = await actionStore.index('by-opportunity').getAll(operation.opportunityId) as Action[]
      for (const action of actions) {
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
      const existing = await opportunityStore.get(operation.opportunityId)
      if (!existing) continue
      const opportunity: Opportunity = {
        ...existing,
        currentStageLabel: '流程结束',
        processStage: 'closed',
        locallyManaged: true,
      }
      await opportunityStore.put(opportunity)
      await upsertLocalProcess(processStore, opportunity, 'closed', '流程结束', operation.occurredAt)

      const actions = await actionStore.index('by-opportunity').getAll(operation.opportunityId) as Action[]
      for (const action of actions) {
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
      const eventId = `progress-event:${operation.id}`
      const existingEvent = await eventStore.get(eventId)
      const now = new Date().toISOString()
      const event: ProcessEvent = {
        id: eventId,
        opportunityId: operation.opportunityId,
        company: operation.company,
        role: operation.role,
        type: operation.eventType,
        occurredAt: operation.occurredAt,
        dueAt: operation.dueAt,
        timingMode: operation.timingMode,
        estimatedMinutes: operation.estimatedMinutes,
        source: 'manual',
        createdAt: existingEvent?.createdAt ?? now,
        updatedAt: now,
      }
      await eventStore.put(event)
      const generated = actionForProcessEvent(event)
      if (generated) {
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
      const id = `progress-action:${operation.id}`
      const previous = await actionStore.get(id)
      const action: Action = {
        id,
        kind: 'manual',
        title: operation.title,
        dueAt: operation.dueAt,
        estimatedMinutes: operation.estimatedMinutes,
        leverage: 70,
        delayCost: operation.dueAt ? 65 : 40,
        status: previous?.status ?? 'todo',
        sourceLabel: '自然语言更新',
        createdAt: previous?.createdAt ?? operation.occurredAt,
        updatedAt: previous?.updatedAt ?? operation.occurredAt,
      }
      await actionStore.put(action)
      const record = timelineFromProgressOperation(operation)
      if (record) await timelineStore.put(record)
    }
  }

  await tx.done
  return { applied: executable.length }
}

export async function stageProgressChangeSet(operations: ExecutableProgressOperation[]) {
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
  const action = await db.get('actions', actionId) ?? (await getAllActions()).find((item) => item.id === actionId)
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
    const progressOperations = changeSet.operations.filter((operation) => operation.kind === 'progress_update')
    if (progressOperations.length === changeSet.operations.length) {
      // The primary Natural Language Update path remains one IndexedDB transaction:
      // either every normalized operation is committed or none of them is.
      await applyProgressUpdate(progressOperations.map((operation) => restoreProgressOperation(operation, changeSet.id)))
    } else for (const operation of changeSet.operations) {
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

      const action = await db.get('actions', operation.actionId) ?? (await getAllActions()).find((item) => item.id === operation.actionId)
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

export async function exportLocalSnapshot() {
  const db = await dbPromise
  await ensureTimelineBackfill(db)
  const [opportunities, processes, processEvents, actions, prep, applicationGroups, decisionRules, timeline, changeSets, meta] =
    await Promise.all([
      db.getAll('opportunities'),
      db.getAll('processes'),
      db.getAll('processEvents'),
      db.getAll('actions'),
      db.getAll('prep'),
      db.getAll('applicationGroups'),
      db.get('decisionRules', 'current'),
      db.getAll('timeline'),
      db.getAll('changeSets'),
      db.get('meta', 'lastImport'),
    ])

  return createSnapshot({
    opportunities,
    processes,
    processEvents,
    actions,
    prep,
    applicationGroups,
    decisionRules: decisionRulesForSnapshot(decisionRules),
    timeline,
    changeSets,
    meta,
  })
}

export async function replaceLocalSnapshotFromCloud(snapshot: PJSDASSnapshot) {
  validateSnapshot(snapshot)

  const db = await dbPromise
  const tx = db.transaction([...DATA_STORES], 'readwrite')
  await Promise.all(DATA_STORES.map((storeName) => tx.objectStore(storeName).clear()))

  for (const item of snapshot.data.opportunities) await tx.objectStore('opportunities').put(item)
  for (const item of snapshot.data.processes) await tx.objectStore('processes').put(item)
  for (const item of snapshot.data.processEvents) await tx.objectStore('processEvents').put(item)
  for (const item of snapshot.data.actions) await tx.objectStore('actions').put(item)
  for (const item of snapshot.data.prep) await tx.objectStore('prep').put(item)
  for (const item of snapshot.data.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  await tx.objectStore('decisionRules').put(snapshot.data.decisionRules ?? createDefaultDecisionRules())
  for (const item of snapshot.data.timeline ?? []) await tx.objectStore('timeline').put(item)
  for (const item of snapshot.data.changeSets ?? []) await tx.objectStore('changeSets').put(item)
  if (snapshot.data.meta) await tx.objectStore('meta').put(snapshot.data.meta)
  await tx.done
}

export async function restoreLocalSnapshot(snapshot: PJSDASSnapshot) {
  validateSnapshot(snapshot)

  const db = await dbPromise
  const tx = db.transaction([...DATA_STORES], 'readwrite')

  await Promise.all(DATA_STORES.map((storeName) => tx.objectStore(storeName).clear()))

  for (const item of snapshot.data.opportunities) await tx.objectStore('opportunities').put(item)
  for (const item of snapshot.data.processes) await tx.objectStore('processes').put(item)
  for (const item of snapshot.data.processEvents) await tx.objectStore('processEvents').put(item)
  for (const item of snapshot.data.actions) await tx.objectStore('actions').put(item)
  for (const item of snapshot.data.prep) await tx.objectStore('prep').put(item)
  for (const item of snapshot.data.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  await tx.objectStore('decisionRules').put(snapshot.data.decisionRules ?? createDefaultDecisionRules())
  for (const item of snapshot.data.timeline ?? []) await tx.objectStore('timeline').put(item)
  for (const item of snapshot.data.changeSets ?? []) await tx.objectStore('changeSets').put(item)
  await tx.objectStore('timeline').put(timelineFromRestore(snapshot.exportedAt))
  if (snapshot.data.meta) await tx.objectStore('meta').put(snapshot.data.meta)
  await tx.done
}

function mergeLocallyManagedOpportunities(imported: Opportunity[], previous: Opportunity[]) {
  const local = previous.filter((item) => item.locallyManaged)
  const localById = new Map(local.map((item) => [item.id, item]))
  const merged = imported.map((item) => localById.get(item.id) ?? item)
  const importedIds = new Set(imported.map((item) => item.id))
  for (const item of local) if (!importedIds.has(item.id)) merged.push(item)
  return merged
}

function mergeLocallyManagedProcesses(
  imported: ProcessRecord[],
  previous: ProcessRecord[],
  locallyManagedOpportunityIds: Set<string>,
) {
  const local = previous.filter((item) => item.locallyManaged)
  const importedSafe = imported.filter(
    (item) => !item.opportunityId || !locallyManagedOpportunityIds.has(item.opportunityId),
  )
  return [...importedSafe, ...local]
}

export async function replaceImportedData(bundle: ImportBundle) {
  assertImportBundleSafe(bundle)

  const db = await dbPromise
  const [previousActions, previousOpportunities, previousProcesses] = await Promise.all([
    db.getAll('actions'),
    db.getAll('opportunities'),
    db.getAll('processes'),
  ])
  const localOpportunityIds = new Set(
    previousOpportunities.filter((item) => item.locallyManaged).map((item) => item.id),
  )
  const mergedActions = mergeActionsForReimport(bundle.actions, previousActions, localOpportunityIds)
  const opportunities = mergeLocallyManagedOpportunities(bundle.opportunities, previousOpportunities)
  const processes = mergeLocallyManagedProcesses(bundle.processes, previousProcesses, localOpportunityIds)

  const tx = db.transaction(
    ['opportunities', 'processes', 'actions', 'prep', 'applicationGroups', 'timeline', 'meta'],
    'readwrite',
  )

  await Promise.all([
    tx.objectStore('opportunities').clear(),
    tx.objectStore('processes').clear(),
    tx.objectStore('actions').clear(),
    tx.objectStore('prep').clear(),
    tx.objectStore('applicationGroups').clear(),
    tx.objectStore('meta').clear(),
  ])

  for (const item of opportunities) await tx.objectStore('opportunities').put(item)
  for (const item of processes) await tx.objectStore('processes').put(item)
  for (const item of mergedActions) await tx.objectStore('actions').put(item)
  for (const item of bundle.prep) await tx.objectStore('prep').put(item)
  for (const item of bundle.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  for (const item of bundle.timeline ?? []) {
    if (!await tx.objectStore('timeline').get(item.id)) await tx.objectStore('timeline').put(item)
  }
  const importMeta: ImportMeta = { key: 'lastImport', ...bundle.summary }
  await tx.objectStore('timeline').put(timelineFromImport(importMeta, bundle.timeline?.length ?? 0))
  await tx.objectStore('meta').put(importMeta)
  await tx.done
}

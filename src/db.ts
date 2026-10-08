import { applyMcpSourceRefreshCommand } from './mcpSourceRefreshCommand.js'
import { createMcpProposalEnvelope } from './ai/mcpProposal.js'
import { mergeDiscoveryScope } from './discoveryScopeSchema.js'
import { applyUserDomainCommand } from './domainCommands.js'
import { observationFromVerifiedOpportunity } from './verifiedOpportunityCommand.js'
import { applyDiscoveryPromotionCommand } from './discoveryPromotionCommand.js'
import { ScoringRetiredError, assertNoNewOpportunityRating } from './scoringRetirement.js'
import { interactionMetric } from './cloud/interactionMetrics.js'
import { applyWorkspaceDelta, patchDeltaRow, DELTA_COLLECTIONS, type WorkspaceDelta, type DeltaRow } from './workspaceDelta.js'
import { canonicalWorkspaceJson } from './cloud/workspaceFingerprint.js'
import { AccountCacheChangedError, captureAccountCacheLease, currentAccountCacheSession } from './cloud/accountCacheLease.js'
import { captureActionStatusUndo, restoreActionStatusUndo, type ActionStatusUndo } from './actionStatusUndo.js'
import { openDB, type DBSchema, type IDBPTransaction } from 'idb'
import { assertImportBundleSafe } from './importDiagnostics.js'
import {
  actionForProcessEvent,
  overlayProcessEventsOnOpportunities,
  overlayProcessEventsOnProcesses,
  reconcileProcessEventActions,
  suppressSupersededActions,
} from './processEvents.js'
import { mergeActionsForReimport } from './reimportState.js'
import { createSnapshot, upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import {
  cancelScheduleNodeForProcessEvent,
  processEventHasHistoricalOccurrences,
  PROCESS_EVENT_HISTORY_DELETION_MESSAGE,
  effectiveScheduleNodeState,
  ensureScheduleContractInPlace,
  normalizeProcessSemantics,
  migrateLegacyScheduleNodes,
  supersedeScheduleOccurrence,
  scheduleNodeForProcessEvent,
  syncScheduleNodeForActionStatus,
} from './scheduleNodes.js'
import { type DecisionRules } from './decisionRules.js'
import type { TimePlanningPreferences } from './timePlanningPreferences.js'
import { validateTimePlanningPreferences } from './timePlanningPreferences.js'
import {
  createDefaultDiscoveryProfile,
  type DiscoveryProfile,
} from './discoveryProfile.js'
import {
  assertChangeSetValid,
  createActionStatusChangeSet,
  createProcessEventChangeSet,
  createProcessEventDeleteChangeSet,
  createProgressChangeSet,
  createRulesChangeSet,
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
  timelineFromChangeSetApplied,
} from './timeline.js'
import type { ExecutableProgressOperation, ProgressOperation } from './progressUpdate.js'
import { progressSubmissionProofId } from './progressUpdate.js'
import type {
  Action,
  ApplicationGroup,
  DecisionRequest,
  ImportBundle,
  ImportMeta,
  DiscoveryInboxItem,
  Opportunity,
  OpportunityAlias,
  Prep,
  ProcessEvent,
  ProcessRecord,
  ScheduleNode,
  ScheduleNodeState,
  SemanticIntakeReceipt,
  ReminderIntent,
  ReminderOutboxRecord,
  TimelineCategory,
  TimelineRecord,
} from './model.js'

export interface CommandInteractionRecord {
  id: string; accountKey: string; commandId: string; createdAt: string; state: 'active' | 'confirmed' | 'rejected' | 'conflict' | 'projection_pending' | 'rollback_pending';
  delta: WorkspaceDelta; command?: import('./domainCommands.js').UserDomainCommand; targetCommandId?: string;
  compensation?: { operation: string; payload: unknown }; lastError?: string; serverRevision?: number; predecessors?: string[];
  /** Authoritative no-write acknowledgement, distinct from an owned ledger receipt. */
  noOpRevision?: number;
}
interface PJSDASDatabase extends DBSchema {
  commandInteractions: { key: string; value: CommandInteractionRecord; indexes: { 'by-account': string; 'by-account-state': [string, CommandInteractionRecord['state']] } }
  projectionDeltas: { key: number; value: { sequence?: number; accountKey: string; delta: WorkspaceDelta } }
  opportunities: { key: string; value: Opportunity }
  opportunityAliases: { key: string; value: OpportunityAlias }
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
  scheduleNodes: {
    key: string
    value: ScheduleNode
    indexes: { 'by-opportunity': string; 'by-occurrence': string; 'by-state': ScheduleNodeState }
  }
  decisionRequests: {
    key: string
    value: DecisionRequest
    indexes: { 'by-state': string; 'by-updated-at': string }
  }
  semanticReceipts: {
    key: string
    value: SemanticIntakeReceipt
    indexes: { 'by-input-id': string; 'by-updated-at': string }
  }
  reminderIntents: {
    key: string
    value: ReminderIntent
    indexes: { 'by-schedule-node': string; 'by-state': string; 'by-dedupe-key': string }
  }
  reminderOutbox: {
    key: string
    value: ReminderOutboxRecord
    indexes: { 'by-intent': string; 'by-state': string }
  }
  actions: {
    key: string
    value: Action
    indexes: { 'by-opportunity': string }
  }
  prep: { key: string; value: Prep }
  applicationGroups: { key: string; value: ApplicationGroup }
  decisionRules: { key: string; value: DecisionRules }
  discoveryProfiles: { key: string; value: DiscoveryProfile }
  discoveryInbox: { key: string; value: DiscoveryInboxItem; indexes: { 'by-status': string; 'by-updated-at': string } }
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
  meta: { key: string; value: ImportMeta | { key: 'authoritativeProjection'; accountKey: string; version: string; canonical: string } | (TimePlanningPreferences & { key: 'timePlanning' }) }
}

const DATA_STORES = [
  'opportunities',
  'opportunityAliases',
  'processes',
  'processEvents',
  'scheduleNodes',
  'decisionRequests',
  'semanticReceipts',
  'reminderIntents',
  'reminderOutbox',
  'actions',
  'prep',
  'applicationGroups',
  'decisionRules',
  'discoveryProfiles',
  'discoveryInbox',
  'timeline',
  'changeSets',
  'meta',
] as const

export const dbPromise = openDB<PJSDASDatabase>('pjsdas', 14, {
  upgrade(db, _oldVersion, _newVersion, upgradeTx) {
    if (!db.objectStoreNames.contains('commandInteractions')) {
      const store = db.createObjectStore('commandInteractions', { keyPath: 'id' }); store.createIndex('by-account', 'accountKey')
    }
    const interactions = upgradeTx.objectStore('commandInteractions')
    if (!interactions.indexNames.contains('by-account-state')) interactions.createIndex('by-account-state', ['accountKey', 'state'])
    if (!db.objectStoreNames.contains('projectionDeltas')) db.createObjectStore('projectionDeltas', { keyPath: 'sequence', autoIncrement: true })
    if (!db.objectStoreNames.contains('opportunityAliases')) db.createObjectStore('opportunityAliases', { keyPath: 'id' })
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
    if (!db.objectStoreNames.contains('scheduleNodes')) {
      const store = db.createObjectStore('scheduleNodes', { keyPath: 'id' })
      store.createIndex('by-opportunity', 'opportunityId')
      store.createIndex('by-occurrence', 'occurrenceId')
      store.createIndex('by-state', 'state')
    }
    if (!db.objectStoreNames.contains('decisionRequests')) {
      const store = db.createObjectStore('decisionRequests', { keyPath: 'id' })
      store.createIndex('by-state', 'state')
      store.createIndex('by-updated-at', 'updatedAt')
    }
    if (!db.objectStoreNames.contains('semanticReceipts')) {
      const store = db.createObjectStore('semanticReceipts', { keyPath: 'id' })
      store.createIndex('by-input-id', 'inputId')
      store.createIndex('by-updated-at', 'updatedAt')
    }
    if (!db.objectStoreNames.contains('reminderIntents')) {
      const store = db.createObjectStore('reminderIntents', { keyPath: 'id' })
      store.createIndex('by-schedule-node', 'scheduleNodeId')
      store.createIndex('by-state', 'state')
      store.createIndex('by-dedupe-key', 'dedupeKey', { unique: true })
    }
    if (!db.objectStoreNames.contains('reminderOutbox')) {
      const store = db.createObjectStore('reminderOutbox', { keyPath: 'id' })
      store.createIndex('by-intent', 'reminderIntentId')
      store.createIndex('by-state', 'state')
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
    if (!db.objectStoreNames.contains('discoveryProfiles')) {
      db.createObjectStore('discoveryProfiles', { keyPath: 'key' })
    }
    if (!db.objectStoreNames.contains('discoveryInbox')) {
      const store = db.createObjectStore('discoveryInbox', { keyPath: 'id' })
      store.createIndex('by-status', 'status')
      store.createIndex('by-updated-at', 'updatedAt')
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
  const overlaid = overlayProcessEventsOnProcesses(processes, opportunities, events, actions)
  return normalizeProcessSemantics(overlaid, opportunities, events, actions)
}

export async function getAllProcessEvents() {
  return (await dbPromise).getAll('processEvents')
}

async function ensureLocalScheduleBackfill(db: Awaited<typeof dbPromise>) {
  const [opportunities, processes, processEvents, actions, prep, scheduleNodes] = await Promise.all([
    db.getAll('opportunities'),
    db.getAll('processes'),
    db.getAll('processEvents'),
    db.getAll('actions'),
    db.getAll('prep'),
    db.getAll('scheduleNodes'),
  ])
  const contract = { opportunities, processes, processEvents, actions, prep, scheduleNodes }
  const beforeNodes = JSON.stringify(scheduleNodes)
  const beforeProcesses = JSON.stringify(processes)
  ensureScheduleContractInPlace(contract)
  if (JSON.stringify(contract.scheduleNodes) !== beforeNodes || JSON.stringify(contract.processes) !== beforeProcesses) {
    const tx = db.transaction(['scheduleNodes', 'processes'], 'readwrite')
    for (const node of contract.scheduleNodes ?? []) await tx.objectStore('scheduleNodes').put(node)
    for (const process of contract.processes) await tx.objectStore('processes').put(process)
    await tx.done
  }
  return contract
}

export async function getAllScheduleNodes(now = new Date()) {
  const contract = await ensureLocalScheduleBackfill(await dbPromise)
  return (contract.scheduleNodes ?? []).map((node) => ({
    ...node,
    state: effectiveScheduleNodeState(node, now),
  }))
}

export async function getAllDecisionRequests() {
  const records = await (await dbPromise).getAll('decisionRequests')
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getAllSemanticReceipts() {
  const records = await (await dbPromise).getAll('semanticReceipts')
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getAllReminderIntents() {
  const records = await (await dbPromise).getAll('reminderIntents')
  return records.sort((a, b) => a.triggerAt.localeCompare(b.triggerAt) || a.id.localeCompare(b.id))
}

export async function getAllReminderOutbox() {
  const records = await (await dbPromise).getAll('reminderOutbox')
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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

export async function getDecisionRules(): Promise<never> { throw new ScoringRetiredError() }

export async function getDiscoveryProfile() {
  const stored = await (await dbPromise).get('discoveryProfiles', 'current')
  return stored ?? createDefaultDiscoveryProfile('1970-01-01T00:00:00.000Z')
}

export async function saveDiscoveryProfile(profile: unknown) {
  const previous = await (await dbPromise).get('discoveryProfiles', 'current')
  const next = mergeDiscoveryScope(previous, profile, new Date().toISOString())
  await (await dbPromise).put('discoveryProfiles', next)
  return next
}

export async function getAllTimelineRecords() {
  // History reads share startup's deterministic, read-only projection. Writing
  // a wall-clock backfill marker here would look like an unsynced account edit.
  const records = (await exportLocalSnapshot()).data.timeline ?? []
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

export async function saveDecisionRules(_rules: DecisionRules): Promise<never> { throw new ScoringRetiredError() }
export async function resetDecisionRules(): Promise<never> { throw new ScoringRetiredError() }

export async function updateActionStatus(id: string, status: Action['status'], expectedStatus?: Action['status']) {
  const db = await dbPromise
  return withTimelineMutation(db, async (tx) => {
    const now = new Date().toISOString()
    const [opportunities, processes, processEvents, actions, prep, scheduleNodes] = await Promise.all([
      tx.objectStore('opportunities').getAll(),
      tx.objectStore('processes').getAll(),
      tx.objectStore('processEvents').getAll(),
      tx.objectStore('actions').getAll(),
      tx.objectStore('prep').getAll(),
      tx.objectStore('scheduleNodes').getAll(),
    ])
    const effective = overlayProcessEventsOnOpportunities(opportunities, processEvents, processes)
    const action = actions.find((item) => item.id === id) ?? suppressSupersededActions(
      reconcileProcessEventActions(actions, processEvents), effective).find((item) => item.id === id)
    if (!action) return
    if (expectedStatus !== undefined && action.status !== expectedStatus) throw new Error('Action changed before the transaction; no status change written.')
    if (action.status === status) return
    const beforeContract = { opportunities, processes, processEvents,
      actions: actions.some((item) => item.id === id) ? actions : [...actions, action], prep, scheduleNodes }
    ensureScheduleContractInPlace(beforeContract)
    const beforeData = structuredClone(beforeContract)
    const nextAction = { ...action, status, updatedAt: now }
    const nextActions = actions.some((item) => item.id === id)
      ? actions.map((item) => item.id === id ? nextAction : item)
      : [...actions, nextAction]
    const contract = { opportunities, processes, processEvents, actions: nextActions, prep, scheduleNodes }
    syncScheduleNodeForActionStatus(contract, id, status, now)
    ensureScheduleContractInPlace(contract)

    await tx.objectStore('actions').put(nextAction)
    for (const node of contract.scheduleNodes ?? []) await tx.objectStore('scheduleNodes').put(node)
    for (const process of contract.processes) await tx.objectStore('processes').put(process)
    await tx.objectStore('timeline').put(timelineFromActionStatus(action, action.status, status, now))
    return captureActionStatusUndo(beforeData, contract, [id])
  })
}

export async function undoActionStatusChange(undo: ActionStatusUndo) {
  const db = await dbPromise
  return withTimelineMutation(db, async (tx) => {
    const snapshot = await readLocalSnapshot(tx)
    restoreActionStatusUndo(snapshot.data, undo)
    validateSnapshot(snapshot)
    for (const { before, after } of undo.actions) {
      await tx.objectStore('actions').put(snapshot.data.actions.find((item) => item.id === before.id)!)
      await tx.objectStore('timeline').put(timelineFromActionStatus(after, after.status, before.status, new Date().toISOString()))
    }
    for (const node of snapshot.data.scheduleNodes ?? []) await tx.objectStore('scheduleNodes').put(node)
    for (const process of snapshot.data.processes) await tx.objectStore('processes').put(process)
  })
}

async function localCanonicalOpportunityId(tx: LocalSnapshotTransaction, id: string) {
  const alias = await tx.objectStore('opportunityAliases').get(id)
  if (!alias) return id
  if (await tx.objectStore('opportunities').get(id) || await tx.objectStore('opportunityAliases').get(alias.canonicalOpportunityId)
    || !await tx.objectStore('opportunities').get(alias.canonicalOpportunityId)) throw new Error('Invalid opportunity alias; refresh the authoritative workspace.')
  return alias.canonicalOpportunityId
}

export async function addProcessEvent(event: ProcessEvent) {
  const db = await dbPromise
  return withTimelineMutation(db, async (tx) => {
    event = { ...event, opportunityId: await localCanonicalOpportunityId(tx, event.opportunityId) }
    const [processes] = await Promise.all([tx.objectStore('processes').getAll()])
    const action = actionForProcessEvent(event)
    const process = processes.find((item) => item.opportunityId === event.opportunityId)
    const node = scheduleNodeForProcessEvent(event, action, process)
    await tx.objectStore('processEvents').put(event)
    if (action) await tx.objectStore('actions').put(action)
    if (node) await tx.objectStore('scheduleNodes').put(node)
    await tx.objectStore('timeline').put(timelineFromProcessEvent(event))
  })
}

export async function deleteProcessEvent(id: string) {
  const db = await dbPromise
  return withTimelineMutation(db, async (tx) => {
    const event = await tx.objectStore('processEvents').get(id)
    const now = new Date().toISOString()
    const nodes = await tx.objectStore('scheduleNodes').getAll()
    if (event) {
      const contract = {
        opportunities: await tx.objectStore('opportunities').getAll(),
        processes: await tx.objectStore('processes').getAll(),
        processEvents: await tx.objectStore('processEvents').getAll(),
        actions: await tx.objectStore('actions').getAll(),
        prep: await tx.objectStore('prep').getAll(),
        scheduleNodes: nodes,
      }
      if (processEventHasHistoricalOccurrences(contract, id, new Date(now))) throw new Error(PROCESS_EVENT_HISTORY_DELETION_MESSAGE)
      cancelScheduleNodeForProcessEvent(contract, id, now)
      await tx.objectStore('processEvents').delete(id)
      await tx.objectStore('actions').delete(`event-action:${id}`)
      for (const node of contract.scheduleNodes ?? []) await tx.objectStore('scheduleNodes').put(node)
      await tx.objectStore('timeline').put(timelineFromDeletedProcessEvent(event))
      return
    }
    await tx.objectStore('processEvents').delete(id)
    await tx.objectStore('actions').delete(`event-action:${id}`)
  })
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
    opportunityValue: 0,
    fitScore: 0,
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
  return withTimelineMutation(db, async (tx) => {
    const opportunityStore = tx.objectStore('opportunities')
    const processStore = tx.objectStore('processes')
    const eventStore = tx.objectStore('processEvents')
    const actionStore = tx.objectStore('actions')
    const timelineStore = tx.objectStore('timeline')

    for (const rawOperation of executable) {
      const operation = 'opportunityId' in rawOperation ? { ...rawOperation, opportunityId: await localCanonicalOpportunityId(tx, rawOperation.opportunityId) } : rawOperation
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
        if (submitted) opportunity.applicationSubmissionProofs = {
          ...opportunity.applicationSubmissionProofs, [progressSubmissionProofId(operation)]: 'active',
        }
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
            leverage: 0,
            delayCost: 0,
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
          leverage: 0,
          delayCost: 0,
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

    return { applied: executable.length }
  })
}

export async function stageProgressChangeSet(operations: ExecutableProgressOperation[]) {
  if (operations.length === 0) throw new Error('没有可执行修改，无法生成 ChangeSet。')
  const changeSet = createProgressChangeSet(operations)
  return savePendingChangeSet(changeSet)
}

export async function applyDecisionRulesChangeSet(_rules: DecisionRules, _mode: 'save' | 'reset' = 'save'): Promise<never> { throw new ScoringRetiredError() }

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

type DiscoveredChangeOperation = Extract<ChangeSetRecord['operations'][number], { kind: 'add_discovered_opportunity' }>

async function applyDiscoveredOpportunityOperations(changeSet: ChangeSetRecord) {
  const db = await dbPromise
  return withTimelineMutation(db, async tx => {
    const current = await tx.objectStore('changeSets').get(changeSet.id)
    if (!current) throw new Error(`找不到 ChangeSet ${changeSet.id}。`)
    if (current.status === 'applied') return current
    if (current.status !== 'pending') throw new Error('The reviewed Discovery batch is no longer pending.')
    let snapshot = await readLocalSnapshot(tx)
    const now = new Date(), appliedOperations: ChangeSetRecord['operations'] = []
    for (const operation of current.operations) {
      if (operation.kind !== 'add_discovered_opportunity') throw new Error('岗位发现 ChangeSet 必须作为独立批次应用。')
      assertNoNewOpportunityRating(operation.opportunity)
      const evaluated = applyUserDomainCommand(snapshot, {
        kind: 'save_verified_discovery_opportunity', commandId: `local-discovery:${current.id}:${operation.id}`,
        opportunityId: operation.opportunity.id, observation: observationFromVerifiedOpportunity(operation.opportunity),
      }, now)
      if (evaluated.status !== 'APPLIED') throw new Error('This exact source posting is already saved. Refresh the reviewed batch.')
      snapshot = evaluated.snapshot
      appliedOperations.push({ ...operation, opportunity: evaluated.opportunity })
    }
    const timestamp = now.toISOString()
    const applied: ChangeSetRecord = { ...current, operations: appliedOperations, status: 'applied', appliedAt: timestamp,
      updatedAt: timestamp, error: undefined, failedAt: undefined }
    // Facts, complete batch status and its audit commit in this one transaction.
    // Any invalid selected candidate aborts every preceding candidate as well.
    for (const operation of appliedOperations) {
      if (operation.kind !== 'add_discovered_opportunity') continue
      const opportunity = operation.opportunity
      await tx.objectStore('opportunities').put(opportunity)
      await tx.objectStore('timeline').put({ id: `timeline:discovery:${opportunity.id}`, kind: 'opportunity_added', category: 'opportunity',
        source: 'changeset', occurredAt: opportunity.importedAt, recordedAt: timestamp, title: '接受 AI 发现岗位',
        opportunityId: opportunity.id, changeSetId: current.id, company: opportunity.company, role: opportunity.role,
        sourceRef: opportunity.detail?.discovery?.sourceUrl })
    }
    await tx.objectStore('changeSets').put(applied)
    await tx.objectStore('timeline').put(timelineFromChangeSetApplied(applied))
    return applied
  })
}

export async function applyLocalDiscoveryPromotion(inboxItemId: string) {
  const db = await dbPromise
  return withTimelineMutation(db, async tx => {
    const snapshot = await readLocalSnapshot(tx)
    const evaluated = applyDiscoveryPromotionCommand(snapshot, { inboxItemId })
    if (evaluated.status !== 'ALREADY_APPLIED') {
      // The pure command owns identity, fact validation and the exact audit.
      // Keep promotion status and job creation indivisible in the local adapter.
      const originalJobs = new Set(snapshot.data.opportunities.map(item => item.id))
      const originalChanges = new Set(snapshot.data.changeSets?.map(item => item.id))
      const originalAudit = new Set(snapshot.data.timeline?.map(item => item.id))
      for (const opportunity of evaluated.snapshot.data.opportunities) if (!originalJobs.has(opportunity.id)) await tx.objectStore('opportunities').put(opportunity)
      for (const changeSet of evaluated.snapshot.data.changeSets ?? []) if (!originalChanges.has(changeSet.id)) await tx.objectStore('changeSets').put(changeSet)
      for (const record of evaluated.snapshot.data.timeline ?? []) if (!originalAudit.has(record.id)) await tx.objectStore('timeline').put(record)
      const promoted = evaluated.snapshot.data.discoveryInbox!.find(item => item.id === inboxItemId)!
      await tx.objectStore('discoveryInbox').put(promoted)
    }
    return evaluated.snapshot.data.discoveryInbox!.find(item => item.id === inboxItemId)!
  })
}

export async function applyLocalDiscoveryExtension(changeSet: ChangeSetRecord) {
  const db = await dbPromise
  return withTimelineMutation(db, async tx => {
    const current = await tx.objectStore('changeSets').get(changeSet.id)
    if (current?.status === 'applied') return current
    if (current && current.status !== 'pending') throw new Error('The reviewed source change is no longer pending.')
    const snapshot = await readLocalSnapshot(tx)
    snapshot.data.changeSets = (snapshot.data.changeSets ?? []).filter(item => item.id !== changeSet.id)
    const now = new Date()
    const evaluated = applyMcpSourceRefreshCommand(snapshot, createMcpProposalEnvelope(changeSet, changeSet.expectedWorkspaceVersion, now), now)
    for (const operation of changeSet.operations) if (operation.kind === 'refresh_job_posting') {
      if (operation.ownerKind === 'opportunity') {
        const updated = evaluated.snapshot.data.opportunities.find(item => item.id === operation.ownerId)!
        await tx.objectStore('opportunities').put(updated)
      } else {
        const updated = evaluated.snapshot.data.discoveryInbox!.find(item => item.id === operation.ownerId)!
        await tx.objectStore('discoveryInbox').put(updated)
      }
    }
    const oldAudit = new Set(snapshot.data.timeline?.map(item => item.id))
    for (const record of evaluated.snapshot.data.timeline ?? []) if (!oldAudit.has(record.id)) await tx.objectStore('timeline').put(record)
    const applied = evaluated.snapshot.data.changeSets!.find(item => item.id === changeSet.id)!
    await tx.objectStore('changeSets').put(applied)
    return applied
  })
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

export async function applyChangeSet(id: string): Promise<ChangeSetRecord & { actionCompensations?: ActionStatusUndo[] }> {
  const db = await dbPromise
  const changeSet = await db.get('changeSets', id)
  if (!changeSet) throw new Error(`找不到 ChangeSet ${id}。`)
  assertChangeSetValid(changeSet)
  if (changeSet.status === 'applied') return changeSet
  if (changeSet.status !== 'pending') throw new Error(`ChangeSet ${id} 当前状态为 ${changeSet.status}，不能应用。`)

  for (const operation of changeSet.operations) {
    if (operation.kind === 'replace_decision_rules') throw new ScoringRetiredError()
    if (operation.kind === 'add_discovered_opportunity') assertNoNewOpportunityRating(operation.opportunity)
  }

  const actionCompensations: ActionStatusUndo[] = []
  try {
    const discoveredOperations = changeSet.operations.filter((operation): operation is DiscoveredChangeOperation => operation.kind === 'add_discovered_opportunity')
    if (discoveredOperations.length > 0) {
      return { ...await applyDiscoveredOpportunityOperations(changeSet), actionCompensations }
    } else {
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

      if (operation.kind === 'replace_decision_rules') throw new ScoringRetiredError()

      if (operation.kind === 'add_process_event') {
        await addProcessEvent(operation.event)
        continue
      }

      if (operation.kind === 'delete_process_event') {
        await deleteProcessEvent(operation.eventId)
        continue
      }

      if (operation.kind === 'add_discovered_opportunity') {
        throw new Error('岗位发现 ChangeSet 必须作为独立批次应用。')
      }

      if (operation.kind === 'refresh_job_posting' || operation.kind === 'record_discovery_run') {
        throw new Error('岗位来源刷新 / Discovery Run 记录必须通过已签名的 MCP 审阅应用路径执行。')
      }

      const action = await db.get('actions', operation.actionId) ?? (await getAllActions()).find((item) => item.id === operation.actionId)
      if (!action) throw new Error(`Action ${operation.actionId} 已不存在。`)
      if (action.status === operation.status) continue
      if (action.status !== operation.expectedStatus) {
        throw new Error(`Action ${operation.actionId} 状态已经变化，请重新操作。`)
      }
      const compensation = await updateActionStatus(operation.actionId, operation.status, operation.expectedStatus)
      if (compensation) actionCompensations.push(compensation)
    }
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
    return { ...applied, actionCompensations }
  } catch (caught) {
    await markChangeSetFailed(changeSet, caught)
    throw caught
  }
}

type LocalSnapshotTransaction = IDBPTransaction<PJSDASDatabase, (typeof DATA_STORES)[number][], 'readonly' | 'readwrite'>

async function readLocalSnapshotData(tx: LocalSnapshotTransaction) {
  const [opportunities, opportunityAliases, processes, processEvents, scheduleNodes, decisionRequests, semanticReceipts, reminderIntents, reminderOutbox, actions, prep, applicationGroups, decisionRules, discoveryProfile, discoveryInbox, timeline, changeSets, meta, timePlanning] =
    await Promise.all([
      tx.objectStore('opportunities').getAll(),
      tx.objectStore('opportunityAliases').getAll(),
      tx.objectStore('processes').getAll(),
      tx.objectStore('processEvents').getAll(),
      tx.objectStore('scheduleNodes').getAll(),
      tx.objectStore('decisionRequests').getAll(),
      tx.objectStore('semanticReceipts').getAll(),
      tx.objectStore('reminderIntents').getAll(),
      tx.objectStore('reminderOutbox').getAll(),
      tx.objectStore('actions').getAll(),
      tx.objectStore('prep').getAll(),
      tx.objectStore('applicationGroups').getAll(),
      tx.objectStore('decisionRules').get('current'),
      tx.objectStore('discoveryProfiles').get('current'),
      tx.objectStore('discoveryInbox').getAll(),
      tx.objectStore('timeline').getAll(),
      tx.objectStore('changeSets').getAll(),
      tx.objectStore('meta').get('lastImport').then(row => row?.key === 'lastImport' ? row : undefined),
      tx.objectStore('meta').get('timePlanning').then(row => {
        if (row?.key !== 'timePlanning') return undefined
        const { key: _key, ...preferences } = row
        return preferences
      }),
    ])
  if (!timeline.some((record) => record.id === TIMELINE_BACKFILL_MARKER_ID)) {
    const existingIds = new Set(timeline.map((record) => record.id))
    // A read projection must be deterministic; a new wall-clock marker would
    // otherwise look like a local edit on every account-cache fingerprint.
    const storedTimes = [...actions.map((item) => item.updatedAt), ...processEvents.map((item) => item.updatedAt),
      ...timeline.map((item) => item.recordedAt), decisionRules?.updatedAt]
      .map((value) => value ? new Date(value).getTime() : NaN).filter(Number.isFinite)
    const projectionTime = new Date(storedTimes.reduce((latest, time) => Math.max(latest, time), 0)).toISOString()
    timeline.push(...buildTimelineBackfill({ processEvents, actions, lastImport: meta, decisionRules, now: projectionTime })
      .filter((record) => !existingIds.has(record.id) && !timeline.some((existing) =>
        existing.kind === record.kind && existing.actionId === record.actionId && Boolean(record.actionId)
        && existing.occurredAt === record.occurredAt && existing.changes?.status?.after === record.changes?.status?.after)))
  }

  return {
    opportunities,
    ...(opportunityAliases.length ? { opportunityAliases } : {}),
    processes,
    processEvents,
    scheduleNodes,
    decisionRequests,
    semanticReceipts,
    reminderIntents,
    reminderOutbox,
    actions,
    prep,
    applicationGroups,
    ...(decisionRules ? { decisionRules: structuredClone(decisionRules) } : {}),
    timePlanning,
    discoveryProfile,
    discoveryInbox,
    timeline,
    changeSets,
    meta,
  }
}

async function readLocalSnapshot(tx: LocalSnapshotTransaction, assertCurrent?: () => void) {
  assertCurrent?.()
  const data = await readLocalSnapshotData(tx)
  // A hot intent may arrive while IndexedDB is reading. Stop before cloning
  // and validating the historical workspace on the UI thread.
  assertCurrent?.()
  return createSnapshot(data)
}

export async function exportLocalSnapshot(assertCurrent?: () => void) {
  const db = await dbPromise
  // Startup/export must remain read-only, even when validation fails.
  const tx = db.transaction([...DATA_STORES], 'readonly')
  try {
    const snapshot = await readLocalSnapshot(tx, assertCurrent)
    await tx.done
    return snapshot
  } catch (error) {
    try { tx.abort() } catch { /* completed readonly transaction */ }
    await tx.done.catch(() => undefined)
    throw error
  }
}

export async function saveLocalTimePlanning(preferences: TimePlanningPreferences) {
  const errors = validateTimePlanningPreferences(preferences)
  if (errors.length) throw new Error(errors[0])
  const db = await dbPromise
  await db.put('meta', { ...structuredClone(preferences), key: 'timePlanning' })
}

async function withTimelineMutation<T>(
  db: Awaited<typeof dbPromise>,
  mutate: (tx: IDBPTransaction<PJSDASDatabase, (typeof DATA_STORES)[number][], 'readwrite'>) => Promise<T>,
  baselineAfterMutation = false,
) {
  // Lock the source stores while validating and materializing the baseline.
  // Baseline and source edit commit together; no queued cache replacement can
  // enter between their reads and writes. Every source read uses this same tx.
  // Startup/history reads never call this; malformed data aborts without writes.
  const tx = db.transaction([...DATA_STORES], 'readwrite')
  const materializeBaseline = async () => {
    if (!await tx.objectStore('timeline').get(TIMELINE_BACKFILL_MARKER_ID)) {
      const snapshot = await readLocalSnapshot(tx)
      for (const record of snapshot.data.timeline ?? []) {
        if (!await tx.objectStore('timeline').get(record.id)) await tx.objectStore('timeline').put(record)
      }
    }
  }
  try {
    if (!baselineAfterMutation) await materializeBaseline()
    const result = await mutate(tx)
    // Once aliases exist, every local write must retain the canonical identity invariant.
    // This runs in the same transaction and aborts, rather than committing latent corruption.
    if (await tx.objectStore('opportunityAliases').count()) {
      const after = await readLocalSnapshot(tx)
      const aliases = new Set(after.data.opportunityAliases!.map(alias => alias.id))
      if ([...after.data.processes, ...after.data.processEvents, ...after.data.actions, ...(after.data.scheduleNodes ?? [])]
        .some(item => item.opportunityId && aliases.has(item.opportunityId))) throw new Error('Local write references a merged opportunity; refresh the canonical target.')
    }
    if (baselineAfterMutation) await materializeBaseline()
    await tx.done
    return result
  } catch (caught) {
    try { tx.abort() } catch { /* The transaction may already have aborted. */ }
    await tx.done.catch(() => {})
    throw caught
  }
}

/** Read every store without validation or migration, including rows that cannot render. */
export async function exportLocalRecoveryArchive() {
  const db = await dbPromise
  const stores = [...db.objectStoreNames]
  const tx = db.transaction(stores, 'readonly')
  const accountKey = currentAccountCacheSession()
  const lease = accountKey ? captureAccountCacheLease(accountKey) : undefined
  const rows = await Promise.all(stores.map(async (store) => {
    const values = await tx.objectStore(store).getAll()
    // Journals are durable per-account recovery provenance, outside the active
    // workspace. An anonymous or different account must not export them.
    return [store, store === 'commandInteractions' || store === 'projectionDeltas'
      ? values.filter(value => accountKey && 'accountKey' in value && value.accountKey === accountKey) : values] as const
  }))
  await tx.done
  lease?.assertCurrent()
  if (currentAccountCacheSession() !== accountKey) throw new AccountCacheChangedError()
  return { schema: 'todayaction-recovery-archive', exportedAt: new Date().toISOString(), stores: Object.fromEntries(rows) }
}

export async function clearLocalWorkspaceCache(assertCurrent?: () => void) {
  const db = await dbPromise
  assertCurrent?.()
  const tx = db.transaction([...DATA_STORES, 'projectionDeltas'], 'readwrite')
  let cleared: PJSDASSnapshot
  try {
    assertCurrent?.()
    await Promise.all(DATA_STORES.map((storeName) => tx.objectStore(storeName).clear()))
    // Proofs describe the cleared cache; original account-scoped commands
    // remain quarantined for that account's receipt-first recovery.
    await tx.objectStore('projectionDeltas').clear()
    cleared = await readLocalSnapshot(tx as LocalSnapshotTransaction)
    assertCurrent?.()
    await tx.done
  } catch (caught) {
    // A synchronous store failure must also abort clears already enqueued.
    // Keep the complete cache available for recovery instead of committing a
    // partially cleared account boundary. Consume the transaction rejection.
    try { tx.abort() } catch { /* The transaction may already have aborted. */ }
    await tx.done.catch(() => {})
    throw caught
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
  return cleared
}

export async function replaceLocalSnapshotFromCloud(snapshot: PJSDASSnapshot, guard?: { expectedLocal: PJSDASSnapshot; assertCurrent: () => void; accountKey?: string; version?: string; interactionSteps?: Array<{ record: CommandInteractionRecord; delta: WorkspaceDelta }> }) {
  validateSnapshot(snapshot)
  const latest = upgradeSnapshotToLatest(snapshot)
  if (guard?.accountKey) {
    // Locally materialized migration evidence is immutable read-only history.
    // Older authoritative snapshots need not contain it; never regenerate it
    // at a new wall-clock time during command recovery or passive refresh.
    const incomingIds = new Set((latest.data.timeline ?? []).map(row => row.id))
    latest.data.timeline = [...latest.data.timeline ?? [], ...guard.expectedLocal.data.timeline?.filter(row => row.source === 'system'
      && (row.id.startsWith('timeline:backfill-') || row.id === 'timeline:system:backfill-v1') && !incomingIds.has(row.id)) ?? []]
  }

  const db = await dbPromise
  const tx = db.transaction([...DATA_STORES, 'projectionDeltas', 'commandInteractions'], 'readwrite')
  try {
    guard?.assertCurrent()
    if (guard && canonicalWorkspaceJson(await readLocalSnapshot(tx as LocalSnapshotTransaction)) !== canonicalWorkspaceJson(guard.expectedLocal)) throw new AccountCacheChangedError()
    guard?.assertCurrent()
    const priorProjection = await tx.objectStore('meta').get('authoritativeProjection')
    if (guard?.accountKey && guard.version && priorProjection?.key === 'authoritativeProjection' && priorProjection.accountKey === guard.accountKey
      && Number(priorProjection.version.replace('txn:', '')) > Number(guard.version.replace('txn:', ''))) throw new AccountCacheChangedError()
    await Promise.all(DATA_STORES.map((storeName) => tx.objectStore(storeName).clear()))
    await tx.objectStore('projectionDeltas').clear()

    for (const item of latest.data.opportunities) await tx.objectStore('opportunities').put(item)
    for (const item of latest.data.opportunityAliases ?? []) await tx.objectStore('opportunityAliases').put(item)
    for (const item of latest.data.processes) await tx.objectStore('processes').put(item)
    for (const item of latest.data.processEvents) await tx.objectStore('processEvents').put(item)
    for (const item of latest.data.scheduleNodes ?? []) await tx.objectStore('scheduleNodes').put(item)
    for (const item of latest.data.decisionRequests ?? []) await tx.objectStore('decisionRequests').put(item)
    for (const item of latest.data.semanticReceipts ?? []) await tx.objectStore('semanticReceipts').put(item)
    for (const item of latest.data.reminderIntents ?? []) await tx.objectStore('reminderIntents').put(item)
    for (const item of latest.data.reminderOutbox ?? []) await tx.objectStore('reminderOutbox').put(item)
    for (const item of latest.data.actions) await tx.objectStore('actions').put(item)
    for (const item of latest.data.prep) await tx.objectStore('prep').put(item)
    for (const item of latest.data.applicationGroups) await tx.objectStore('applicationGroups').put(item)
    if (latest.data.decisionRules) await tx.objectStore('decisionRules').put(latest.data.decisionRules)
    if (latest.data.discoveryProfile) await tx.objectStore('discoveryProfiles').put(latest.data.discoveryProfile)
    for (const item of latest.data.discoveryInbox ?? []) await tx.objectStore('discoveryInbox').put(item)
    for (const item of latest.data.timeline ?? []) await tx.objectStore('timeline').put(item)
    for (const item of latest.data.changeSets ?? []) await tx.objectStore('changeSets').put(item)
    if (latest.data.meta) await tx.objectStore('meta').put(latest.data.meta)
    if (latest.data.timePlanning) await tx.objectStore('meta').put({ ...latest.data.timePlanning, key: 'timePlanning' })
    let committed = await readLocalSnapshot(tx as LocalSnapshotTransaction)
    // Materialize the deterministic read-only backfill once. Otherwise a later
    // ordinary entity patch would regenerate different historical rows at export.
    const importedTimelineIds = new Set((latest.data.timeline ?? []).map(item => item.id))
    for (const row of committed.data.timeline ?? []) if (!importedTimelineIds.has(row.id)) await tx.objectStore('timeline').put(row)
    committed = await readLocalSnapshot(tx as LocalSnapshotTransaction)
    if (guard?.accountKey && guard.version) {
      // Canonical bytes are recorded in the same transaction; async crypto would
      // let IndexedDB auto-commit before this crash-recovery proof is durable.
      await tx.objectStore('meta').put({ key: 'authoritativeProjection', accountKey: guard.accountKey,
        version: guard.version, canonical: canonicalWorkspaceJson(committed) })
    }
    for (const { record, delta } of guard?.interactionSteps ?? []) {
      for (const change of delta.changes) {
        const store = tx.objectStore(deltaStore(change.collection) as any)
        const id = deltaId(change.collection, change.id)
        let row = await store.get(id) as DeltaRow | undefined
        if (change.collection === 'timePlanning' && row) { const { key: _key, ...value } = row; row = value }
        const next = patchDeltaRow(row ?? null, change)
        if (next) await store.put(change.collection === 'timePlanning' ? { ...next, key: 'timePlanning' } : next)
        else await store.delete(id)
      }
      await tx.objectStore('commandInteractions').put(record)
      if (delta.changes.length) await tx.objectStore('projectionDeltas').add({ accountKey: record.accountKey, delta })
    }
    if (guard?.interactionSteps?.length) committed = await readLocalSnapshot(tx as LocalSnapshotTransaction)
    guard?.assertCurrent()
    await tx.done
    return committed
  } catch (caught) {
    try { tx.abort() } catch { /* already settled */ }
    await tx.done.catch(() => {})
    throw caught
  }
}

export async function restoreLocalSnapshot(snapshot: PJSDASSnapshot) {
  validateSnapshot(snapshot)
  const latest = upgradeSnapshotToLatest(snapshot)

  const db = await dbPromise
  const tx = db.transaction([...DATA_STORES], 'readwrite')

  await Promise.all(DATA_STORES.map((storeName) => tx.objectStore(storeName).clear()))

  for (const item of latest.data.opportunities) await tx.objectStore('opportunities').put(item)
    for (const item of latest.data.opportunityAliases ?? []) await tx.objectStore('opportunityAliases').put(item)
  for (const item of latest.data.processes) await tx.objectStore('processes').put(item)
  for (const item of latest.data.processEvents) await tx.objectStore('processEvents').put(item)
  for (const item of latest.data.scheduleNodes ?? []) await tx.objectStore('scheduleNodes').put(item)
  for (const item of latest.data.decisionRequests ?? []) await tx.objectStore('decisionRequests').put(item)
  for (const item of latest.data.semanticReceipts ?? []) await tx.objectStore('semanticReceipts').put(item)
  for (const item of latest.data.reminderIntents ?? []) await tx.objectStore('reminderIntents').put(item)
  for (const item of latest.data.reminderOutbox ?? []) await tx.objectStore('reminderOutbox').put(item)
  for (const item of latest.data.actions) await tx.objectStore('actions').put(item)
  for (const item of latest.data.prep) await tx.objectStore('prep').put(item)
  for (const item of latest.data.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  if (latest.data.decisionRules) await tx.objectStore('decisionRules').put(latest.data.decisionRules)
  if (latest.data.discoveryProfile) await tx.objectStore('discoveryProfiles').put(latest.data.discoveryProfile)
  for (const item of latest.data.discoveryInbox ?? []) await tx.objectStore('discoveryInbox').put(item)
  for (const item of latest.data.timeline ?? []) await tx.objectStore('timeline').put(item)
  for (const item of latest.data.changeSets ?? []) await tx.objectStore('changeSets').put(item)
  await tx.objectStore('timeline').put(timelineFromRestore(latest.exportedAt))
  if (latest.data.meta) await tx.objectStore('meta').put(latest.data.meta)
  if (latest.data.timePlanning) await tx.objectStore('meta').put({ ...latest.data.timePlanning, key: 'timePlanning' })
  await tx.done
}

function mergeLocallyManagedOpportunities(imported: Opportunity[], previous: Opportunity[]) {
  const local = previous.filter((item) => item.locallyManaged)
  const localById = new Map(local.map((item) => [item.id, item]))
  const previousById = new Map(previous.map(item => [item.id, item]))
  const merged = imported.map((item) => {
    const local = localById.get(item.id)
    if (local) return local
    const before = previousById.get(item.id)
    const owned = before?.applicationSubmissionProofs ? { ...item, applicationSubmissionProofs: structuredClone(before.applicationSubmissionProofs) } : item
    if (!before?.detail?.deadlineCorrections?.length && !before?.detail?.userFacts) return owned
    return { ...owned, detail: { ...item.detail,
      deadlineCorrections: before.detail.deadlineCorrections, userFacts: before.detail.userFacts } }
  })
  const importedIds = new Set(imported.map((item) => item.id))
  // Import omission cannot erase retained task/process/history references.
  for (const item of previous) if (!importedIds.has(item.id)) merged.push(item)
  return merged
}

function mergeLocallyManagedProcesses(
  imported: ProcessRecord[],
  previous: ProcessRecord[],
  locallyManagedOpportunityIds: Set<string>,
) {
  const importedSafe = imported.filter(
    (item) => !item.opportunityId || !locallyManagedOpportunityIds.has(item.opportunityId),
  )
  const ids = new Set(importedSafe.map(item => item.id))
  return [...importedSafe, ...previous.filter(item => !ids.has(item.id))]
}

export async function replaceImportedData(bundle: ImportBundle) {
  assertImportBundleSafe(bundle)

  const db = await dbPromise
  return withTimelineMutation(db, async (tx) => {
    if (await tx.objectStore('opportunityAliases').count()) throw new Error('Imported data must be reconciled with existing canonical opportunity aliases before replacement.')
    const [previousActions, previousOpportunities, previousProcesses, processEvents, previousScheduleNodes] = await Promise.all([
      tx.objectStore('actions').getAll(),
      tx.objectStore('opportunities').getAll(),
      tx.objectStore('processes').getAll(),
      tx.objectStore('processEvents').getAll(),
      tx.objectStore('scheduleNodes').getAll(),
    ])
    const previousData = await readLocalSnapshotData(tx)
    const keepOmitted = <T extends { id: string }>(incoming: T[], prior: T[]) => {
      const ids = new Set(incoming.map(item => item.id))
      return [...incoming, ...prior.filter(item => !ids.has(item.id))]
    }
    const prep = keepOmitted(bundle.prep, previousData.prep)
    const applicationGroups = keepOmitted(bundle.applicationGroups, previousData.applicationGroups)
    const localOpportunityIds = new Set(
      previousOpportunities.filter((item) => item.locallyManaged).map((item) => item.id),
    )
    const mergedActions = mergeActionsForReimport(bundle.actions, previousActions, localOpportunityIds)
    const opportunities = mergeLocallyManagedOpportunities(bundle.opportunities, previousOpportunities)
    const processes = mergeLocallyManagedProcesses(bundle.processes, previousProcesses, localOpportunityIds)
    // Import absence does not revoke an occurrence or its latest version.
    // Keep the complete chain; explicit retained-source timing edits below
    // create owned versions, and candidate validation protects references.
    const scheduleNodes = [...previousScheduleNodes]
    const contract = {
      opportunities,
      processes,
      processEvents,
      actions: mergedActions,
      prep,
      scheduleNodes,
    }
    // Keep the occurrence's durable version chain when an imported deadline
    // changes; projecting an elapsed v1 back onto the new action loses the edit.
    const latestPrevious = new Map<string, ScheduleNode>()
    for (const node of previousScheduleNodes) {
      const prior = latestPrevious.get(node.occurrenceId)
      if (!prior || node.version > prior.version) latestPrevious.set(node.occurrenceId, node)
    }
    const incomingNodes = migrateLegacyScheduleNodes(contract)
    // Existing legacy timing versions remain provenance owners. An explicit
    // workbook correction may version that retained chain, but new rows never
    // acquire a deadline occurrence and all such versions stay Calendar-ineligible.
    for (const prior of latestPrevious.values()) {
      if (prior.temporal.resolutionBasis !== 'legacy_projection' || prior.processEventId) continue
      const target = prior.opportunityId ? opportunities.find(item => item.id === prior.opportunityId) : undefined
      if (target?.locallyManaged || target?.detail?.deadlineCorrections?.length || target?.detail?.userFacts?.deadline) continue
      const owner = prior.kind === 'application_deadline' ? bundle.opportunities.find(item => item.id === prior.opportunityId)
        : bundle.actions.find(item => prior.relatedActionIds.includes(item.id))
      const value = owner && ('deadline' in owner ? owner.deadline : 'dueAt' in owner ? owner.dueAt : undefined)
      if (!value || incomingNodes.some(node => node.occurrenceId === prior.occurrenceId)) continue
      const precision = 'deadlinePrecision' in owner! ? owner!.deadlinePrecision : 'duePrecision' in owner! ? owner!.duePrecision : undefined
      const dateOnly = precision === 'date' || /^\d{4}-\d{2}-\d{2}$/.test(value)
      incomingNodes.push({ ...prior, state: 'scheduled', completedAt: undefined, cancelledAt: undefined,
        temporal: dateOnly ? { shape: 'date_only', precision: 'date', timezone: 'floating-date', date: value.slice(0, 10), resolutionBasis: 'legacy_projection', legacyProjectionAt: value }
          : { shape: 'deadline', precision: 'datetime', timezone: 'source-offset', deadlineAt: value, resolutionBasis: 'legacy_projection', legacyProjectionAt: value },
        updatedAt: bundle.summary.importedAt })
    }
    const importWithdrawal = (node: ScheduleNode) => node.state === 'cancelled'
      && node.sourceVersionRefs.includes(`import:deadline-cleared:${node.occurrenceId}:v${node.version}:${node.cancelledAt}`)
    for (const prior of latestPrevious.values()) {
      if (prior.temporal.resolutionBasis !== 'legacy_projection' || prior.processEventId
        || ['completed', 'cancelled', 'superseded'].includes(prior.state)
        || (prior.opportunityId && localOpportunityIds.has(prior.opportunityId))
        || incomingNodes.some(node => node.occurrenceId === prior.occurrenceId)) continue
      // An omitted source row is not an instruction to cancel its history.
      // Only a retained imported source with an explicitly empty timing field
      // withdraws the projection; retain the previous temporal in a new version.
      const owner = prior.opportunityId ? opportunities.find(item => item.id === prior.opportunityId) : undefined
      if (owner?.detail?.deadlineCorrections?.length || owner?.detail?.userFacts?.deadline) continue
      const sourceRetained = prior.kind === 'application_deadline' && prior.opportunityId
        ? bundle.opportunities.some(item => item.id === prior.opportunityId && !item.deadline)
        : bundle.actions.some(item => prior.relatedActionIds.includes(item.id) && !item.dueAt)
      if (!sourceRetained) continue
      if (!scheduleNodes.some(node => node.id === prior.id)) scheduleNodes.push(prior)
      supersedeScheduleOccurrence(scheduleNodes, {
        ...prior, state: 'cancelled', cancelledAt: bundle.summary.importedAt,
        updatedAt: bundle.summary.importedAt,
        sourceVersionRefs: [...prior.sourceVersionRefs, `import:deadline-cleared:${prior.occurrenceId}:v${prior.version + 1}:${bundle.summary.importedAt}`],
      })
    }
    for (const incoming of incomingNodes) {
      const prior = latestPrevious.get(incoming.occurrenceId)
      if (!prior || prior.temporal.resolutionBasis !== 'legacy_projection'
        || (['completed', 'cancelled', 'superseded'].includes(prior.state) && !importWithdrawal(prior))) continue
      if (!scheduleNodes.some(node => node.id === prior.id)) scheduleNodes.push(prior)
      const value = (node: ScheduleNode) => JSON.stringify([
        node.temporal.shape, node.temporal.precision, node.temporal.timezone,
        node.temporal.date, node.temporal.startAt, node.temporal.endAt, node.temporal.deadlineAt,
      ])
      if (importWithdrawal(prior) || value(prior) !== value(incoming)) {
        supersedeScheduleOccurrence(scheduleNodes, {
          ...incoming, updatedAt: bundle.summary.importedAt,
          evidenceRefs: [...new Set([...prior.evidenceRefs, ...incoming.evidenceRefs])],
          sourceVersionRefs: [...new Set([...prior.sourceVersionRefs, ...incoming.sourceVersionRefs])],
        })
      }
    }
    ensureScheduleContractInPlace(contract)
    // Validate the complete proposed workspace under the same locks before any
    // replacement. Retained history must not acquire missing process/event refs.
    createSnapshot({ ...previousData, ...contract, applicationGroups })
    // Raw pre-import facts survive even when a removed terminal action had no
    // dated node. Do this only after candidate validation, under the same locks.
    for (const record of previousData.timeline ?? []) {
      if (!await tx.objectStore('timeline').get(record.id)) await tx.objectStore('timeline').put(record)
    }

    await Promise.all([
      tx.objectStore('opportunities').clear(),
      tx.objectStore('processes').clear(),
      tx.objectStore('scheduleNodes').clear(),
      tx.objectStore('actions').clear(),
      tx.objectStore('prep').clear(),
      tx.objectStore('applicationGroups').clear(),
      tx.objectStore('meta').clear(),
    ])

    for (const item of opportunities) await tx.objectStore('opportunities').put(item)
    for (const item of contract.processes) await tx.objectStore('processes').put(item)
    for (const item of contract.scheduleNodes ?? []) await tx.objectStore('scheduleNodes').put(item)
    for (const item of mergedActions) await tx.objectStore('actions').put(item)
    for (const item of prep) await tx.objectStore('prep').put(item)
    for (const item of applicationGroups) await tx.objectStore('applicationGroups').put(item)
    for (const item of bundle.timeline ?? []) {
      if (!await tx.objectStore('timeline').get(item.id)) await tx.objectStore('timeline').put(item)
    }
    const importMeta: ImportMeta = { key: 'lastImport', ...bundle.summary }
    await tx.objectStore('timeline').put(timelineFromImport(importMeta, bundle.timeline?.length ?? 0))
    await tx.objectStore('meta').put(importMeta)
    if (previousData.timePlanning) await tx.objectStore('meta').put({ ...previousData.timePlanning, key: 'timePlanning' })
  }, true)
}

/** Lock all data stores while checking a captured read; never adopt a later local edit. */
export async function assertLocalSnapshotCurrent(expected: PJSDASSnapshot, assertCurrent: () => void) {
  const db = await dbPromise
  const tx = db.transaction([...DATA_STORES], 'readwrite')
  try {
    assertCurrent()
    if (canonicalWorkspaceJson(await readLocalSnapshot(tx, assertCurrent)) !== canonicalWorkspaceJson(expected)) throw new AccountCacheChangedError()
    assertCurrent()
    await tx.done
  } catch (caught) {
    try { tx.abort() } catch { /* already settled */ }
    await tx.done.catch(() => {})
    throw caught
  }
}

export async function isRecordedAccountProjection(accountKey: string, snapshot: PJSDASSnapshot, options?: { compact?: boolean; assertCurrent?: () => void }) {
  options?.assertCurrent?.()
  if ((await import('./cloud/authoritativeCommandClient.js')).listAccountPendingOperations(accountKey).some(item => item.status === 'rollback_pending')) return false
  const db = await dbPromise
  if ((await db.getAllFromIndex('commandInteractions', 'by-account-state', [accountKey, 'rollback_pending'])).length) return false
  const recorded = await db.get('meta', 'authoritativeProjection')
  options?.assertCurrent?.()
  if (recorded?.key !== 'authoritativeProjection' || recorded.accountKey !== accountKey) return false
  const deltas = (await db.getAll('projectionDeltas')).filter(item => item.accountKey === accountKey)
  options?.assertCurrent?.()
  const normalizeOrder = (value: PJSDASSnapshot) => {
    const data = { ...value.data }
    for (const key of DELTA_COLLECTIONS) {
      const rows = data[key]
      if (rows && new Set(rows.map(item => item.id)).size === rows.length) (data as any)[key] = [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    }
    return { ...value, data }
  }
  let expected: PJSDASSnapshot = { ...snapshot, data: JSON.parse(recorded.canonical) }
  if (!deltas.length) return canonicalWorkspaceJson(normalizeOrder(expected)) === canonicalWorkspaceJson(normalizeOrder(snapshot))
  try { for (const item of deltas) expected = applyWorkspaceDelta(expected, item.delta) } catch { return false }
  // This is a recorded local transaction proof, so require exact facts and
  // audit rows. Only IndexedDB primary-key ordering is normalized.
  const canonical = canonicalWorkspaceJson(normalizeOrder(snapshot))
  const verified = canonical === canonicalWorkspaceJson(normalizeOrder(createSnapshot(expected.data, expected.exportedAt)))
  if (verified && options?.compact && deltas.length >= 64) {
    // Operational proof compaction only: original command journals and all
    // business/audit stores remain intact. A concurrent proof writer causes
    // compaction to defer rather than losing its new delta.
    const tx = db.transaction(['meta', 'projectionDeltas'], 'readwrite')
    try {
      options.assertCurrent?.()
      const baseline = await tx.objectStore('meta').get('authoritativeProjection')
      const current = (await tx.objectStore('projectionDeltas').getAll()).filter(item => item.accountKey === accountKey)
      if (baseline?.key === 'authoritativeProjection' && baseline.accountKey === accountKey && baseline.canonical === recorded.canonical
        && current.length === deltas.length && current.every((item, index) => item.sequence === deltas[index].sequence)) {
        await tx.objectStore('meta').put({ ...recorded, canonical })
        for (const item of deltas) await tx.objectStore('projectionDeltas').delete(item.sequence!)
      }
      options.assertCurrent?.()
      await tx.done
    } catch (error) { try { tx.abort() } catch { /* settled */ }; await tx.done.catch(() => undefined); throw error }
  }
  return verified
}


const deltaStore = (collection: string) => collection === 'timePlanning' || collection === 'meta' ? 'meta'
  : collection === 'discoveryProfile' ? 'discoveryProfiles' : collection
const deltaId = (collection: string, id: string) => collection === 'timePlanning' ? 'timePlanning'
  : collection === 'meta' ? 'lastImport' : id

/** Durable outbox, exact inverse, entity writes and projection proof commit atomically. */
export async function persistInteractionProjection(record: CommandInteractionRecord, assertCurrent: () => void, delta = record.delta) {
  return persistInteractionProjections([{ record, delta }], assertCurrent)
}
export async function persistInteractionProjections(steps: Array<{ record: CommandInteractionRecord; delta: WorkspaceDelta }>, assertCurrent: () => void) {
  const started = performance.now()
  const db = await dbPromise
  const stores = new Set(steps.flatMap(step => step.delta.changes.map(item => deltaStore(item.collection))))
  const tx = db.transaction(['commandInteractions', 'projectionDeltas', ...stores] as any, 'readwrite')
  try {
    assertCurrent()
    for (const { record, delta } of steps) {
      for (const change of delta.changes) {
        const store = tx.objectStore(deltaStore(change.collection) as any)
        const id = deltaId(change.collection, change.id)
        let row = await store.get(id) as DeltaRow | undefined
        if (change.collection === 'timePlanning' && row) { const { key: _key, ...value } = row; row = value }
        const next = patchDeltaRow(row ?? null, change)
        if (next) await store.put(change.collection === 'timePlanning' ? { ...next, key: 'timePlanning' } : next)
        else await store.delete(id)
      }
      await tx.objectStore('commandInteractions').put(record)
      await tx.objectStore('projectionDeltas').add({ accountKey: record.accountKey, delta })
    }
    assertCurrent()
    await tx.done
    interactionMetric('indexeddb-write', started)
  } catch (error) {
    try { tx.abort() } catch { /* settled */ }
    await tx.done.catch(() => undefined)
    throw error
  }
}
export async function readCommandInteractions(accountKey: string) {
  const lease = captureAccountCacheLease(accountKey)
  const rows = await (await dbPromise).getAllFromIndex('commandInteractions', 'by-account', accountKey)
  lease.assertCurrent()
  return rows
}
/** Ordinary interactions never load the retained archive. */
export async function readPendingCommandInteractions(accountKey: string) {
  const lease = captureAccountCacheLease(accountKey)
  const db = await dbPromise
  // All three status ranges must share one stable journal view. Separate
  // helper calls each open a transaction and can straddle another writer.
  const tx = db.transaction('commandInteractions', 'readonly')
  try {
    const index = tx.store.index('by-account-state')
    const [active, projectionPending, rollbackPending] = await Promise.all([
      index.getAll([accountKey, 'active']),
      index.getAll([accountKey, 'projection_pending']),
      index.getAll([accountKey, 'rollback_pending']),
    ])
    await tx.done
    lease.assertCurrent()
    return [...active, ...projectionPending, ...rollbackPending]
  } catch (error) {
    try { tx.abort() } catch { /* already settled */ }
    await tx.done.catch(() => undefined)
    throw error
  }
}
export async function readCommandInteraction(accountKey: string, commandId: string) {
  const lease = captureAccountCacheLease(accountKey)
  const row = await (await dbPromise).get('commandInteractions', `${accountKey}:${commandId}`)
  lease.assertCurrent()
  return row
}
export async function saveCommandInteraction(record: CommandInteractionRecord) {
  await (await dbPromise).put('commandInteractions', record)
}

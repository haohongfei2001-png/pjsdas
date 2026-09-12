import type { ChangeSetRecord } from './changeSet.js'
import { dbPromise } from './db.js'
import {
  applyPostingRefreshToInbox,
  applyPostingRefreshToOpportunity,
  postingRefreshTimeline,
  resolvePostingRefreshTarget,
  type PostingRefreshOperation,
} from './postingRefresh.js'
import { timelineFromChangeSetApplied } from './timeline.js'

function appliedChangeSet(changeSet: ChangeSetRecord, appliedAt: string): ChangeSetRecord {
  return {
    ...changeSet,
    status: 'applied',
    appliedAt,
    updatedAt: appliedAt,
    error: undefined,
    failedAt: undefined,
  }
}

export async function applyMcpDiscoveryExtensionChangeSet(changeSet: ChangeSetRecord) {
  const refreshOperations = changeSet.operations.filter(
    (operation): operation is PostingRefreshOperation => operation.kind === 'refresh_job_posting',
  )
  const runRecordOperations = changeSet.operations.filter((operation) => operation.kind === 'record_discovery_run')
  const supportedCount = refreshOperations.length + runRecordOperations.length
  if (supportedCount === 0) return undefined
  if (supportedCount !== changeSet.operations.length) {
    throw new Error('岗位来源刷新 / Discovery Run 记录必须作为独立 ChangeSet 应用。')
  }
  if (changeSet.status === 'applied') return changeSet
  if (changeSet.status !== 'pending') throw new Error(`ChangeSet ${changeSet.id} 当前状态为 ${changeSet.status}，不能应用。`)

  const db = await dbPromise
  const appliedAt = new Date().toISOString()

  if (runRecordOperations.length > 0) {
    if (!changeSet.discoveryRun || !runRecordOperations.every((operation) => operation.runId === changeSet.discoveryRun?.id)) {
      throw new Error('Discovery Run 记录与 ChangeSet metadata 不一致。')
    }
    const applied = appliedChangeSet(changeSet, appliedAt)
    const tx = db.transaction(['changeSets', 'timeline'], 'readwrite')
    await tx.objectStore('changeSets').put(applied)
    await tx.objectStore('timeline').put(timelineFromChangeSetApplied(applied))
    await tx.done
    return applied
  }

  let opportunities = await db.getAll('opportunities')
  let inbox = await db.getAll('discoveryInbox')
  const changedOpportunityIds = new Set<string>()
  const changedInboxIds = new Set<string>()
  const timeline = []

  for (const operation of refreshOperations) {
    const target = resolvePostingRefreshTarget(operation, opportunities, inbox)
    if (!target) {
      throw new Error(`Posting ${operation.expectedPostingId} 已变化，请重新读取 Refresh Queue 后再审阅。`)
    }
    if (target.ownerKind === 'opportunity') {
      const owner = opportunities.find((item) => item.id === target.ownerId)
      if (!owner) throw new Error(`岗位 ${target.ownerId} 已不存在。`)
      const refreshed = applyPostingRefreshToOpportunity(owner, operation)
      opportunities = opportunities.map((item) => item.id === refreshed.id ? refreshed : item)
      changedOpportunityIds.add(refreshed.id)
    } else {
      const owner = inbox.find((item) => item.id === target.ownerId)
      if (!owner) throw new Error(`发现箱条目 ${target.ownerId} 已不存在。`)
      const refreshed = applyPostingRefreshToInbox(owner, operation)
      inbox = inbox.map((item) => item.id === refreshed.id ? refreshed : item)
      changedInboxIds.add(refreshed.id)
    }
    timeline.push(postingRefreshTimeline(operation, target, changeSet.id))
  }

  const applied = appliedChangeSet(changeSet, appliedAt)
  const tx = db.transaction(['opportunities', 'discoveryInbox', 'timeline', 'changeSets'], 'readwrite')
  for (const id of changedOpportunityIds) {
    const opportunity = opportunities.find((item) => item.id === id)
    if (opportunity) await tx.objectStore('opportunities').put(opportunity)
  }
  for (const id of changedInboxIds) {
    const item = inbox.find((candidate) => candidate.id === id)
    if (item) await tx.objectStore('discoveryInbox').put(item)
  }
  for (const record of timeline) await tx.objectStore('timeline').put(record)
  await tx.objectStore('changeSets').put(applied)
  await tx.objectStore('timeline').put(timelineFromChangeSetApplied(applied))
  await tx.done
  return applied
}

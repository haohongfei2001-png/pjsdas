import type { ChangeSetRecord } from './changeSet.js'
import { applyLocalDiscoveryExtension } from './db.js'

export async function applyMcpDiscoveryExtensionChangeSet(changeSet: ChangeSetRecord) {
  const supported = changeSet.operations.filter(operation => ['refresh_job_posting', 'record_discovery_run'].includes(operation.kind))
  if (!supported.length) return undefined
  if (supported.length !== changeSet.operations.length) throw new Error('岗位来源刷新 / Discovery Run 记录必须作为独立 ChangeSet 应用。')
  if (changeSet.status === 'applied') return changeSet
  if (changeSet.status !== 'pending') throw new Error(`ChangeSet ${changeSet.id} 当前状态为 ${changeSet.status}，不能应用。`)
  return applyLocalDiscoveryExtension(changeSet)
}

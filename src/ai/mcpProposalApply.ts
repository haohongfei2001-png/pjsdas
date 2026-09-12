import { applyChangeSet, exportLocalSnapshot } from '../db.js'
import type { ChangeSetRecord } from '../changeSet.js'
import { fingerprintWorkspace } from '../cloud/workspaceFingerprint.js'
import { applyMcpDiscoveryExtensionChangeSet } from '../postingRefreshStore.js'

function snapshotWithoutProposal(changeSet: ChangeSetRecord, snapshot: Awaited<ReturnType<typeof exportLocalSnapshot>>) {
  return {
    ...snapshot,
    data: {
      ...snapshot.data,
      changeSets: (snapshot.data.changeSets ?? []).filter((item) => item.id !== changeSet.id),
    },
  }
}

export async function assertMcpChangeSetBaseline(changeSet: ChangeSetRecord) {
  if (changeSet.source !== 'mcp' || !changeSet.expectedWorkspaceFingerprint) return
  const local = await exportLocalSnapshot()
  const fingerprint = await fingerprintWorkspace(snapshotWithoutProposal(changeSet, local))
  if (fingerprint !== changeSet.expectedWorkspaceFingerprint) {
    throw new Error('PJSDAS 本机工作区在这条 ChatGPT 提议生成后已经发生变化。请先同步，再让 ChatGPT 基于最新状态重新生成提议。')
  }
}

export async function applyMcpChangeSetWithBaseline(changeSet: ChangeSetRecord) {
  await assertMcpChangeSetBaseline(changeSet)
  const specialized = await applyMcpDiscoveryExtensionChangeSet(changeSet)
  if (specialized) return specialized
  return applyChangeSet(changeSet.id)
}
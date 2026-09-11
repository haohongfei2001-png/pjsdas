import { readFile, writeFile } from 'node:fs/promises'

const path = 'src/db.ts'
let text = await readFile(path, 'utf8')

function replaceOnce(before, after, label) {
  if (!text.includes(before)) throw new Error(`Missing anchor: ${label}`)
  text = text.replace(before, after)
}

replaceOnce(
  "export async function applyActionStatusChangeSet(actionId: string, status: Action['status']) {\n  const db = await dbPromise\n  const action = await db.get('actions', actionId) ?? (await getAllActions()).find((item) => item.id === actionId)\n  if (!action) return undefined\n  const changeSet = createActionStatusChangeSet(action, status)\n  if (!changeSet) return undefined\n  await savePendingChangeSet(changeSet)\n  return applyChangeSet(changeSet.id)\n}\n\nasync function markChangeSetFailed",
  `export async function applyActionStatusChangeSet(actionId: string, status: Action['status']) {\n  const db = await dbPromise\n  const action = await db.get('actions', actionId) ?? (await getAllActions()).find((item) => item.id === actionId)\n  if (!action) return undefined\n  const changeSet = createActionStatusChangeSet(action, status)\n  if (!changeSet) return undefined\n  await savePendingChangeSet(changeSet)\n  return applyChangeSet(changeSet.id)\n}\n\nfunction compactOpportunityIdentity(value: string) {\n  return value.toLocaleLowerCase().replace(/[\\s\\u3000·•｜|（）()【】\\[\\]，,。.!！?？:：;；/\\\\_-]+/g, '')\n}\n\nfunction opportunityIdentity(company: string, role: string) {\n  return \\`\\${compactOpportunityIdentity(company)}|\\${compactOpportunityIdentity(role)}\\`\n}\n\ntype DiscoveredChangeOperation = Extract<ChangeSetRecord['operations'][number], { kind: 'add_discovered_opportunity' }>\n\nasync function applyDiscoveredOpportunityOperations(operations: DiscoveredChangeOperation[], changeSetId: string) {\n  const db = await dbPromise\n  const existing = await db.getAll('opportunities')\n  const existingIds = new Set(existing.map((item) => item.id))\n  const identities = new Set(existing.map((item) => opportunityIdentity(item.company, item.role)))\n  const batchIds = new Set<string>()\n  const batchIdentities = new Set<string>()\n\n  for (const operation of operations) {\n    const opportunity = operation.opportunity\n    const identity = opportunityIdentity(opportunity.company, opportunity.role)\n    if (existingIds.has(opportunity.id) || identities.has(identity)) {\n      throw new Error(\\`岗位 \\${opportunity.company}｜\\${opportunity.role} 已存在，请重新让 ChatGPT 基于最新工作区生成提议。\\`)\n    }\n    if (batchIds.has(opportunity.id) || batchIdentities.has(identity)) {\n      throw new Error(\\`岗位发现 ChangeSet 内含重复岗位：\\${opportunity.company}｜\\${opportunity.role}。\\`)\n    }\n    batchIds.add(opportunity.id)\n    batchIdentities.add(identity)\n  }\n\n  const tx = db.transaction(['opportunities', 'actions', 'timeline'], 'readwrite')\n  const opportunityStore = tx.objectStore('opportunities')\n  const actionStore = tx.objectStore('actions')\n  const timelineStore = tx.objectStore('timeline')\n  const recordedAt = new Date().toISOString()\n\n  for (const operation of operations) {\n    const opportunity = operation.opportunity\n    await opportunityStore.put(opportunity)\n    const actionId = \\`apply:\\${opportunity.id}\\`\n    await actionStore.put({\n      id: actionId,\n      kind: 'apply',\n      title: \\`投递 \\${opportunity.company}｜\\${opportunity.role}\\`,\n      opportunityId: opportunity.id,\n      processStage: 'not_applied',\n      dueAt: opportunity.deadline,\n      timingMode: opportunity.deadline ? 'deadline' : undefined,\n      estimatedMinutes: opportunity.prepEstimateMinutes ?? 45,\n      leverage: 70,\n      delayCost: opportunity.deadline ? 65 : 40,\n      status: 'todo',\n      sourceLabel: 'ChatGPT 岗位发现',\n      createdAt: opportunity.importedAt,\n      updatedAt: opportunity.importedAt,\n    })\n    await timelineStore.put({\n      id: \\`timeline:discovery:\\${opportunity.id}\\`,\n      kind: 'opportunity_added',\n      category: 'opportunity',\n      source: 'changeset',\n      occurredAt: opportunity.importedAt,\n      recordedAt,\n      title: '接受 AI 发现岗位',\n      detail: opportunity.detail?.discovery?.rationale,\n      opportunityId: opportunity.id,\n      actionId,\n      changeSetId,\n      company: opportunity.company,\n      role: opportunity.role,\n      sourceRef: opportunity.detail?.discovery?.sourceUrl,\n    })\n  }\n\n  await tx.done\n}\n\nasync function markChangeSetFailed`,
  'discovered apply helper',
)

replaceOnce(
  "  try {\n    const progressOperations = changeSet.operations.filter((operation) => operation.kind === 'progress_update')",
  "  try {\n    const discoveredOperations = changeSet.operations.filter((operation): operation is DiscoveredChangeOperation => operation.kind === 'add_discovered_opportunity')\n    if (discoveredOperations.length > 0) {\n      await applyDiscoveredOpportunityOperations(discoveredOperations, changeSet.id)\n    } else {\n    const progressOperations = changeSet.operations.filter((operation) => operation.kind === 'progress_update')",
  'apply branch start',
)

replaceOnce(
  "      await updateActionStatus(operation.actionId, operation.status)\n    }\n\n    const appliedAt",
  "      await updateActionStatus(operation.actionId, operation.status)\n    }\n    }\n\n    const appliedAt",
  'apply branch end',
)

await writeFile(path, text)

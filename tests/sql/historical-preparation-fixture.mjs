import assert from 'node:assert/strict'
import { hashMutationPayload } from '../../gateway/mutationKernel.ts'
import { commandConflictScopes, diffCommandFields, diffCommandObjects, readModelInvalidation } from '../../gateway/commandObjects.ts'
import { diffWorkspaceDelta } from '../../src/workspaceDelta.ts'

// Synthetic database history only. Never call the current reducer to manufacture
// a fresh Prep success: new commands must fail before reaching the SQL RPC.
// The snapshot/receipt shape preserves the pre-retirement reducer and executor
// contract from e53bb5ad7bcfa6c4ecd23f930a630d24209e81ff.
export async function seedHistoricalPreparationCommand(db, { owner, client, grant, consentVersion, initial, command, time }) {
  const [operation] = command.change.operations
  assert.ok(['create_prep', 'update_prep', 'archive_prep'].includes(operation.kind))
  const snapshot = structuredClone(initial)
  const id = operation.id ?? `managed:prep:${command.commandId}:0`
  const beforeIndex = initial.data.prep.findIndex(item => item.id === id)
  const before = structuredClone(initial.data.prep[beforeIndex] ?? null)
  assert.equal(beforeIndex === -1, operation.kind === 'create_prep')
  const timestamp = new Date(time).toISOString()
  const after = operation.kind === 'archive_prep' ? null : operation.kind === 'create_prep'
    ? { id, ...operation.value, createdAt: timestamp, updatedAt: timestamp }
    : { ...before, ...operation.patch, updatedAt: timestamp }
  if (after === null) snapshot.data.prep.splice(beforeIndex, 1)
  else if (beforeIndex < 0) snapshot.data.prep.push(after)
  else snapshot.data.prep[beforeIndex] = after
  snapshot.data.timeline = [...(initial.data.timeline ?? []), { id: `management:${command.commandId}`, kind: 'change_set_applied', category: 'data', source: 'user_action', occurredAt: timestamp, recordedAt: timestamp, title: 'Updated 1 business object(s)', commandId: command.commandId, commandOperation: 'business_management' }]
  snapshot.exportedAt = timestamp
  const compensation = { operation: 'business_management_restore', payload: { changes: [{ type: 'prep', id, beforeIndex, before, after }] } }
  const affectedObjects = diffCommandObjects(initial, snapshot)
  const receipt = { contractVersion: 5, projectionDelta: diffWorkspaceDelta(initial, snapshot, 0), schemaVersion: snapshot.version, commandType: 'business_management',
    affectedObjects, affectedFields: diffCommandFields(initial, snapshot, affectedObjects), conflictScopes: commandConflictScopes(affectedObjects, [{ type: 'prep', id, field: '*' }]),
    undoDependencyObjects: affectedObjects, readModelInvalidation: readModelInvalidation(affectedObjects),
    lifecycle: { receivedAt: timestamp, validatedAt: timestamp, baseRevision: 0, authoritativeRevisionBeforeCommit: 0, rebased: false },
    result: { type: 'business_management', status: 'APPLIED', summary: 'Updated 1 business object(s).', objects: [{ type: 'prep', id }] },
    commandId: command.commandId, receiptId: `command-receipt:${command.commandId}`, status: 'COMMITTED', operation: 'business_management', revision: 1, committedAt: timestamp, undoAvailable: true,
    managementAuthorization: { grantId: grant, grantRevision: 1, consentVersion } }
  const payloadHash = await hashMutationPayload(consentVersion === 7 ? 'consumer_business_management_v7' : 'business_management', { type: 'business_management', value: command.change })
  await db.query('begin')
  try {
    const row = (await db.query('update public.pjsdas_workspaces set snapshot=$1,revision=1 where user_id=$2 and revision=0 returning id', [JSON.stringify(snapshot), owner])).rows[0]
    assert.ok(row, 'Historical fixture requires a fresh revision-zero workspace')
    await db.query(`insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,expected_revision,principal_kind,client_id,compensation,status,resulting_revision,receipt,provenance)
      values($1,$2,$3,'business_management',$4,0,'delegated_mcp',$5,$6,'COMMITTED',1,$7,$8)`,
    [row.id, owner, command.commandId, payloadHash, client, JSON.stringify(compensation), JSON.stringify(receipt), JSON.stringify({ channel: 'authoritative-command-v2', baseRevision: 0 })])
    await db.query('commit')
  } catch (error) { await db.query('rollback'); throw error }
  return { snapshot, compensation }
}

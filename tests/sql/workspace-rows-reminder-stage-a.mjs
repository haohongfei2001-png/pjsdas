import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createSnapshot } from '../../src/snapshot.ts'
import { applyPrivateReminderManagement, privateReminderManagementFingerprint, restorePrivateReminderManagement } from '../../src/privateReminderManagement.ts'
import { encodeWorkspaceRows, diffWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
const wire = x => JSON.parse(JSON.stringify(x)), equal = (a, b) => assert(isDeepStrictEqual(a, wire(b)), 'reminder full wire equality')
export async function testReminderRows({ db, source, origin, token }) {
  const userId = randomUUID(), clientId = randomUUID(), grantId = randomUUID(), at = '2030-01-01T00:00:00.000Z'
  const node = { id: 'synthetic-private-target', occurrenceId: 'synthetic-private-occurrence', version: 1, kind: 'interview', state: 'scheduled', temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: '2030-01-02T02:00:00Z', endAt: '2030-01-02T03:00:00Z', resolutionBasis: 'user_explicit' }, constraintKind: 'user_plan', evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [], createdAt: at, updatedAt: at }
  const initial = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], scheduleNodes: [node], timeline: [] }, at)
  await db.query('insert into auth.users(id) values($1)', [userId])
  const workspaceId = (await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id', [userId, initial])).rows[0].id
  const seedRows = async snapshot => {
    const encoded = encodeWorkspaceRows(snapshot)
    await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) on conflict(id) do update set envelope=excluded.envelope,manifest=excluded.manifest', [workspaceId, userId, encoded.envelope, JSON.stringify(encoded.manifest), snapshot])
    await db.query('delete from pjsdas_rows_candidate.item where workspace_id=$1', [workspaceId])
    await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)', [workspaceId, userId, JSON.stringify(encoded.rows)])
  }
  await seedRows(initial)
  await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.reminders.manage',6,$4)", [grantId, userId, clientId, 'f'.repeat(64)])
  const before = await source.read(userId)
  const core = await applyPrivateReminderManagement(before.snapshot, { operations: [{ kind: 'create_private_reminder', scheduleNodeId: node.id, expectedNodeFingerprint: await privateReminderManagementFingerprint(node), purpose: 'upcoming', triggerAt: '2030-01-02T01:00:00Z' }] }, 'synthetic-reminder-command', new Date(at))
  assert.equal(core.status, 'APPLIED')
  const command = { commandId: 'synthetic-reminder-command', payloadHash: 'f'.repeat(64), compensation: core.compensation, grantId, grantRevision: 1, clientId }
  const legacy = async (snapshot, options = {}) => {
    const v = { commandId: command.commandId, operation: 'private_reminder_management', revision: 0, clientId, grantId, grantRevision: 1, provenance: {}, ...options }
    return (await db.query('select * from public.pjsdas_commit_private_reminder_workspace_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [userId, v.commandId, v.operation, command.payloadHash, v.revision, JSON.stringify(snapshot), 4, 'delegated_mcp', v.clientId, JSON.stringify(v.provenance), JSON.stringify(core.compensation), null, '{}', v.grantId, v.grantRevision])).rows[0]
  }
  const raw = async (state, after, options = {}) => {
    const req = { ...diffWorkspaceRows(state.snapshot, after), workspaceId, userId, expectedEpoch: state.epoch, expectedRevision: state.revision, operation: 'private_reminder_management', principal: 'delegated_mcp', commandId: 'synthetic-raw-reminder', payloadHash: 'e'.repeat(64), compensation: {}, ...options }
    const response = await fetch(origin + '/rpc/commit_private_reminder', { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ req, target_grant_id: grantId, target_grant_revision: 1, target_client_id: clientId }) })
    return { status: response.status, value: await response.json() }
  }
  const wrongGrant = randomUUID(); await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.manage',2,$4)", [wrongGrant, userId, clientId, 'a'.repeat(64)])
  for (const patch of [{ clientId: randomUUID() }, { grantRevision: 99 }, { grantId: wrongGrant }]) {
    await assert.rejects(legacy(core.snapshot, patch), e => e.code === '42501'); await assert.rejects(source.commitPrivateReminder(before, core.snapshot, { ...command, ...patch }))
  }
  for (const variant of ['capability-null', 'external-link-null', 'target-version', 'dedupe-key', 'protected-data', 'missing-array', 'outbox-write']) {
    const after = structuredClone(core.snapshot), reminder = after.data.reminderIntents[0]
    if (variant === 'capability-null') reminder.capability = null
    if (variant === 'external-link-null') reminder.externalLink = null
    if (variant === 'target-version') reminder.scheduleNodeVersion = 99
    if (variant === 'dedupe-key') reminder.dedupeKey = 'wrong'
    if (variant === 'protected-data') after.data.timePlanning = { syntheticDenied: true }
    if (variant === 'missing-array') delete after.data.reminderIntents
    if (variant === 'outbox-write') after.data.reminderOutbox.push({ id: 'synthetic-forbidden-outbox' })
    await assert.rejects(legacy(after), e => e.code === '42501'); assert.equal((await raw(before, after)).status, 403)
  }
  const old = await legacy(core.snapshot), result = await source.commitPrivateReminder(before, core.snapshot, command)
  assert.equal(result.outcome, 'COMMITTED'); equal((await source.read(userId)).snapshot, old.snapshot); equal(result.receipt.managementAuthorization, old.receipt.managementAuthorization)
  equal((await source.commitPrivateReminder(before, core.snapshot, command)).receipt, result.receipt)
  const undoBefore = await source.read(userId), restored = await restorePrivateReminderManagement(undoBefore.snapshot, core.compensation, new Date(at))
  const undo = { ...command, commandId: 'synthetic-reminder-undo', operation: 'undo_command', undoOf: command.commandId, compensation: {} }
  await assert.rejects(source.commitPrivateReminder(undoBefore, restored, { ...undo, undoOf: 'absent-or-foreign' }))
  const legacyUndo = await legacy(restored, { commandId: undo.commandId, operation: 'undo_command', provenance: { undoOf: command.commandId }, revision: 1 })
  await source.commitPrivateReminder(undoBefore, restored, undo); equal((await source.read(userId)).snapshot, legacyUndo.snapshot)
  // Synthetic protected-owner fixture: relative order matters, private positions do not.
  const fixture = wire(core.snapshot), privateRow = fixture.data.reminderIntents[0]
  fixture.data.scheduleNodes.push(...['a', 'b'].map(suffix => ({ ...node, id: 'synthetic-external-node-' + suffix, occurrenceId: 'synthetic-external-occurrence-' + suffix })))
  const external = id => ({ ...privateRow, id, scheduleNodeId: id.replace('external-', 'external-node-'), dedupeKey: id.replace('external-', 'external-node-') + '@1|upcoming', deliveryOwner: 'external_task', channel: 'task', capability: 'chatgpt_tasks', externalLink: { capability: 'chatgpt_tasks', state: 'unmapped' } })
  const a = external('synthetic-external-a'), b = external('synthetic-external-b'), linked = { ...privateRow, id: 'synthetic-outbox-linked', purpose: 'overdue', dedupeKey: node.id + '@1|overdue', state: 'paused' }
  fixture.data.reminderIntents = [a, privateRow, b, linked]
  fixture.data.reminderOutbox = [{ id: 'synthetic-outbox', reminderIntentId: linked.id, operation: 'upsert', capability: 'chatgpt_tasks', state: 'pending', attemptCount: 0, payloadFingerprint: 'synthetic', createdAt: at, updatedAt: at }]
  await db.query('update public.pjsdas_workspaces set snapshot=$2 where id=$1', [workspaceId, fixture]); await seedRows(fixture)
  const state = await source.read(userId)
  for (const variant of ['external-order', 'external-value', 'linked-value', 'linked-delete']) {
    const after = structuredClone(fixture)
    if (variant === 'external-order') [after.data.reminderIntents[0], after.data.reminderIntents[2]] = [after.data.reminderIntents[2], after.data.reminderIntents[0]]
    if (variant === 'external-value') after.data.reminderIntents[0].state = 'cancelled'
    if (variant === 'linked-value') after.data.reminderIntents[3].state = 'cancelled'
    if (variant === 'linked-delete') after.data.reminderIntents.pop()
    await assert.rejects(legacy(after, { commandId: 'denied-' + variant, revision: 2 }), e => e.code === '42501'); assert.equal((await raw(state, after)).status, 403)
  }
  const moved = structuredClone(fixture); moved.data.reminderIntents = [privateRow, a, b, linked]
  const legacyMoved = await legacy(moved, { commandId: 'synthetic-private-reorder', revision: 2 }), rowMoved = await raw(state, moved, { commandId: 'synthetic-private-reorder' })
  assert.equal(rowMoved.status, 200); assert.equal(rowMoved.value.outcome, 'COMMITTED'); equal((await source.read(userId)).snapshot, legacyMoved.snapshot)
  await db.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1', [grantId]); await assert.rejects(source.commitPrivateReminder(before, core.snapshot, command))
  console.log('PASS private reminder actual-core create/restore and legacy differential: null capabilities, target/version/dedupe, external/outbox immutable values and relative order; no external delivery')
}

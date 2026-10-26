import assert from 'node:assert/strict'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createSnapshot } from '../../src/snapshot.ts'
import { applyDiscoveryProfileManagement, getDiscoveryProfileManagementRead, restoreDiscoveryProfileManagement } from '../../src/discoveryProfileManagement.ts'
import { encodeWorkspaceRows, diffWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
const wire = x => JSON.parse(JSON.stringify(x)), equal = (a, b) => assert(isDeepStrictEqual(a, wire(b)), 'planning complete wire equality')
export async function testProfileRows({ db, source, origin, token, connectionString }) {
  const userId = randomUUID(), clientId = randomUUID(), grantId = randomUUID(), at = '2030-01-01T00:00:00.000Z'
  const initial = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [{ id: 'synthetic-retained-audit', kind: 'change_set_applied', category: 'data', source: 'system', occurredAt: at, recordedAt: at, title: 'Synthetic retained audit' }] }, at)
  await db.query('insert into auth.users(id) values($1)', [userId])
  const workspaceId = (await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id', [userId, initial])).rows[0].id
  const encoded = encodeWorkspaceRows(initial)
  await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5)', [workspaceId, userId, encoded.envelope, JSON.stringify(encoded.manifest), initial])
  await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)', [workspaceId, userId, JSON.stringify(encoded.rows)])
  await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.discovery-profile.manage',5,$4)", [grantId, userId, clientId, 'c'.repeat(64)])
  const wrongGrant = randomUUID(); await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.manage',2,$4)", [wrongGrant, userId, clientId, 'f'.repeat(64)])
  const before = await source.read(userId), reviewed = await getDiscoveryProfileManagementRead(before.snapshot)
  const core = await applyDiscoveryProfileManagement(before.snapshot, { kind: 'patch_discovery_profile', expectedFingerprint: reviewed.fingerprint, patch: { targetRoleQueries: ['Synthetic engineer'] } }, 'synthetic-profile-command', new Date(at))
  assert.equal(core.status, 'APPLIED')
  const command = { commandId: 'synthetic-profile-command', payloadHash: 'c'.repeat(64), compensation: core.compensation, grantId, grantRevision: 1, clientId }
  const legacy = async (snapshot = core.snapshot, overrides = {}) => {
    const values = { userId, commandId: command.commandId, operation: 'discovery_profile_management', payloadHash: command.payloadHash, revision: 0, snapshot, principal: 'delegated_mcp', clientId, grantId, grantRevision: 1, provenance: {}, ...overrides }
    return (await db.query('select * from public.pjsdas_commit_discovery_profile_workspace_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [values.userId, values.commandId, values.operation, values.payloadHash, values.revision, JSON.stringify(values.snapshot), 4, values.principal, values.clientId, JSON.stringify(values.provenance), JSON.stringify(core.compensation), null, '{}', values.grantId, values.grantRevision])).rows[0]
  }
  // Actual existing public function is the authorization/protected-data oracle.
  for (const patch of [{ clientId: randomUUID() }, { grantRevision: 99 }, { grantId: wrongGrant }]) {
    await assert.rejects(legacy(core.snapshot, patch), e => e.code === '42501')
    await assert.rejects(source.commitDiscoveryProfile(before, core.snapshot, { ...command, ...patch }))
  }
  for (const variant of ['protected-envelope', 'audit-rewrite', 'audit-delete']) {
    const after = structuredClone(core.snapshot)
    if (variant === 'protected-envelope') after.data.timePlanning = { syntheticUnauthorized: true }
    if (variant === 'audit-rewrite') after.data.timeline[0].title = 'not allowed'
    if (variant === 'audit-delete') after.data.timeline.shift()
    await assert.rejects(legacy(after), e => e.code === '42501')
    const req = { ...diffWorkspaceRows(before.snapshot, after), workspaceId, userId, expectedEpoch: before.epoch, expectedRevision: 0, commandId: 'synthetic-denied-' + variant, payloadHash: 'd'.repeat(64), operation: 'discovery_profile_management', principal: 'delegated_mcp', compensation: {} }
    const response = await fetch(origin + '/rpc/commit_discovery_profile', { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ req, target_grant_id: grantId, target_grant_revision: 1, target_client_id: clientId }) })
    assert.equal(response.status, 403)
  }
  equal((await source.read(userId)).snapshot, initial)
  const old = await legacy(), row = await source.commitDiscoveryProfile(before, core.snapshot, command)
  assert.equal(old.outcome, 'COMMITTED'); assert.equal(row.outcome, 'COMMITTED')
  equal((await source.read(userId)).snapshot, old.snapshot); equal(row.receipt.managementAuthorization, old.receipt.managementAuthorization)
  equal((await source.commitDiscoveryProfile(before, core.snapshot, command)).receipt, row.receipt)
  await db.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1', [grantId])
  await assert.rejects(legacy(), e => e.code === '42501'); await assert.rejects(source.commitDiscoveryProfile(before, core.snapshot, command))
  assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.ledger where workspace_id=$1', [workspaceId])).rows[0].n, 1)
  const revoker = new pg.Client({ connectionString, application_name: 'candidate-profile-revoker' }); await revoker.connect()
  const waitLocks = async minimum => { const deadline = Date.now() + 5000; for (;;) { await db.query('select pg_stat_clear_snapshot()'); const n = (await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and pid<>pg_backend_pid()")).rows[0].n; if (n >= minimum) return; if (Date.now() >= deadline) throw new Error('expected real grant/workspace blocking boundary absent'); await new Promise(resolve => setTimeout(resolve, 20)) } }
  const tracked = promise => { const value = { settled: false }; value.result = promise.then(result => { value.settled = true; return { result } }, error => { value.settled = true; return { error } }); return value }
  try {
    await db.query('update public.pjsdas_business_management_grants set revoked_at=null where id=$1', [grantId])
    let revision = Number((await db.query('select revision from public.pjsdas_business_management_grants where id=$1', [grantId])).rows[0].revision)
    equal((await source.commitDiscoveryProfile(before, core.snapshot, { ...command, grantRevision: revision })).receipt, row.receipt)
    console.log('PASS regranted current authority preserves original immutable discovery-profile receipt')
    const state = await source.read(userId), planningRead = await getDiscoveryProfileManagementRead(state.snapshot)
    const next = await applyDiscoveryProfileManagement(state.snapshot, { kind: 'patch_discovery_profile', expectedFingerprint: planningRead.fingerprint, patch: { targetRoleQueries: ['Synthetic researcher'] } }, 'synthetic-concurrent-profile', new Date(at))
    const nextCommand = { ...command, commandId: 'synthetic-concurrent-profile', payloadHash: 'e'.repeat(64), compensation: next.compensation, grantRevision: revision }
    // Revoke wins: real SHARE acquisition waits, then re-evaluates revoked row.
    await db.query('begin'); await db.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1', [grantId])
    const rejected = tracked(source.commitDiscoveryProfile(state, next.snapshot, nextCommand)); await waitLocks(1); assert(!rejected.settled); await db.query('commit'); assert((await rejected.result).error)
    assert.equal((await source.read(userId)).revision, state.revision)
    // Commit wins: grant SHARE is held while waiting on workspace. Revocation must wait too.
    await db.query('update public.pjsdas_business_management_grants set revoked_at=null where id=$1', [grantId]); revision = Number((await db.query('select revision from public.pjsdas_business_management_grants where id=$1', [grantId])).rows[0].revision)
    await db.query('begin'); await db.query('select id from pjsdas_rows_candidate.head where id=$1 for update', [workspaceId])
    const admitted = tracked(source.commitDiscoveryProfile(state, next.snapshot, { ...nextCommand, grantRevision: revision })); await waitLocks(1)
    const revoked = tracked(revoker.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1', [grantId])); await waitLocks(2); assert(!admitted.settled && !revoked.settled)
    await db.query('commit'); const committed = await admitted.result; if (committed.error) throw committed.error; assert.equal(committed.result.outcome, 'COMMITTED'); assert(!(await revoked.result).error)
    equal((await source.read(userId)).snapshot, next.snapshot)
    assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.ledger where workspace_id=$1', [workspaceId])).rows[0].n, 2)
    await assert.rejects(source.commitDiscoveryProfile(state, next.snapshot, { ...nextCommand, grantRevision: revision }))
    await db.query('update public.pjsdas_business_management_grants set revoked_at=null where id=$1', [grantId]); const undoGrant = Number((await db.query('select revision from public.pjsdas_business_management_grants where id=$1', [grantId])).rows[0].revision)
    // Bring the original legacy oracle through the same second domain state.
    await legacy(next.snapshot, { commandId: nextCommand.commandId, revision: 1, grantRevision: undoGrant })
    const undoBefore = await source.read(userId), restored = restoreDiscoveryProfileManagement(undoBefore.snapshot, next.compensation, new Date(at))
    const undoCommand = { ...command, commandId: 'synthetic-profile-undo', operation: 'undo_command', undoOf: nextCommand.commandId, grantRevision: undoGrant, compensation: {} }
    await assert.rejects(source.commitDiscoveryProfile(undoBefore, restored, { ...undoCommand, undoOf: 'foreign-or-absent-target' }))
    await assert.rejects(legacy(restored, { commandId: undoCommand.commandId, operation: 'undo_command', provenance: { undoOf: 'foreign-or-absent-target' }, revision: 2, grantRevision: undoGrant }), e => e.code === '42501')
    const legacyUndo = await legacy(restored, { commandId: undoCommand.commandId, operation: 'undo_command', provenance: { undoOf: nextCommand.commandId }, revision: 2, grantRevision: undoGrant })
    const rowUndo = await source.commitDiscoveryProfile(undoBefore, restored, undoCommand); assert.equal(rowUndo.outcome, 'COMMITTED'); equal((await source.read(userId)).snapshot, legacyUndo.snapshot); equal(rowUndo.receipt.managementAuthorization, legacyUndo.receipt.managementAuthorization)
    console.log('PASS discovery profile original-family Undo binding and actual restore core are equivalent to legacy guard')
    console.log('PASS discovery profile real two-session grant revocation ordering: revoke-first rejects; grant-held commit finishes before revoke; no partial ledger')
  } finally { await db.query('rollback'); await revoker.end() }
  console.log('PASS discovery profile: real current grant and legacy-RPC differential, protected fields/audit, actual-core HTTP commit, replay and revoked-grant rejection; product layout/cutover integration remains open')
}

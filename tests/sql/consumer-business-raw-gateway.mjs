// Actual version 7 consumer runtime/store/RPC with synthetic raw facts only. The dedicated RPC checks grant hash and exact raw projection evidence.
import pg from 'pg'
import assert from 'node:assert/strict'
import { createOwnerScopedManagementRuntime } from '../../gateway/scopedManagementRuntime.ts'
import { unknownDeadlineWorkspace } from '../fixtures/unknownDeadlineWorkspace.ts'
const url = new URL(process.env.TA_MANAGEMENT_SQL_TEST_URL ?? 'http://missing.invalid')
if (url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/ta_management_fixture' || url.username !== 'postgres' || url.password !== 'fixture-only' || url.search) throw new Error('Only isolated loopback synthetic fixture is accepted.')
pg.types.setTypeParser(20, value => { const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('Fixture integer overflow'); return n })
const db = new pg.Client({ connectionString: url.toString(), statement_timeout: 15000 })
const client = '00000000-0000-4000-8000-000000000300', origin = 'https://synthetic.invalid', network = globalThis.fetch
const time = '2026-10-03T00:00:00Z'
const operations = [
  { kind: 'create_prep', value: { title: 'New prep', estimatedMinutes: 30 } },
  { kind: 'update_prep', id: 'prep-b', patch: { title: 'Changed prep' } },
  { kind: 'archive_prep', id: 'prep-b' },
  { kind: 'create_manual_action', value: { title: 'New action', estimatedMinutes: 30 } },
  { kind: 'update_manual_action', id: 'manual-b', patch: { title: 'Changed action' } },
  { kind: 'archive_manual_action', id: 'manual-b' },
  { kind: 'create_application_group', value: { company: 'New group' } },
  { kind: 'update_application_group', id: 'group-b', patch: { company: 'Changed group' } },
  { kind: 'archive_application_group', id: 'group-b' },
]
function raw() {
  const s = JSON.parse(JSON.stringify(unknownDeadlineWorkspace(2)))
  s.data.actions[0].dueAt = '2026-08-27T15:59:59Z'; s.data.actions[0].timingMode = 'deadline'
  s.data.actions.push(...['b', 'a'].map(id => ({ id: `manual-${id}`, kind: 'manual', status: 'todo', title: id, estimatedMinutes: 30, leverage: 50, delayCost: 50, createdAt: time, updatedAt: time, future: { raw: ['retain', null] } })))
  s.data.prep = ['b', 'a'].map(id => ({ id: `prep-${id}`, title: id, estimatedMinutes: 30, createdAt: time, updatedAt: time, future: { raw: ['retain', null] } }))
  s.data.applicationGroups = ['b', 'a'].map(id => ({ id: `group-${id}`, company: id, total: 3, used: 1, remaining: 2, future: { raw: ['retain', null] } }))
  s.data.futureSurface = { nested: [1, 'retain', null] }
  return s
}
try {
  await db.connect(); await db.query('set role service_role')
  globalThis.fetch = async () => { throw new Error('External network is forbidden in this fixture') }
  for (const [index, scenario] of [...operations.map(op => op.kind), 'legacy', 'newer-unrelated', 'newer-target', 'revoke-before-rpc', 'cas-before-rpc', 'tamper-unselected', 'tamper-order', 'tamper-unrelated', 'tamper-grant-hash', 'tamper-legacy-proof'].entries()) {
    const owner = `00000000-0000-4000-8000-${String(4001 + index).padStart(12, '0')}`, grant = `10000000-0000-4000-8000-${String(4001 + index).padStart(12, '0')}`
    const initial = raw(), op = operations[index] ?? operations[1]
    if (scenario === 'legacy') { initial.version = 1; for (const k of ['scheduleNodes', 'decisionRequests', 'semanticReceipts', 'reminderIntents', 'reminderOutbox']) delete initial.data[k] }
    await db.query('reset role'); await db.query('insert into auth.users(id) values($1)', [owner])
    await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,$3)', [owner, JSON.stringify(initial), initial.version])
    await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.business.manage',7,$4)", [grant, owner, client, '22626aea373e4e8eb51a90ee4b548c5f3aeeee4bbe58e77b418a0645138edb34'])
    await db.query('set role service_role')
    let posts = 0
    const fetchImpl = async (input, init) => {
      const u = new URL(String(input)); assert.equal(u.origin, origin)
      if (init?.method === 'POST') {
        assert.equal(u.pathname, '/rest/v1/rpc/pjsdas_commit_consumer_business_workspace_v1')
        const b = JSON.parse(String(init.body)); assert.equal(b.target_user_id, owner); posts++
        if (scenario === 'revoke-before-rpc') await db.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1', [grant])
        if (scenario === 'cas-before-rpc') await db.query('update public.pjsdas_workspaces set revision=revision+1 where user_id=$1', [owner])
        if (scenario === 'tamper-unselected') delete b.target_snapshot.data.actions[0].dueAt;
        if (scenario === 'tamper-order') b.target_snapshot.data.prep.reverse();
        if (scenario === 'tamper-unrelated') b.target_snapshot.data.futureSurface.nested[0] = 2;
        if (scenario === 'tamper-grant-hash') { const row=(await db.query('update public.pjsdas_business_management_grants set consent_text_hash=$1 where id=$2 returning revision',['f'.repeat(64),grant])).rows[0];b.target_grant_revision=row.revision }
        if (scenario === 'tamper-legacy-proof') { const row=(await db.query("insert into public.pjsdas_business_management_grants(user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,'workspace.manage',2,$3) returning id,revision",[owner,client,'b'.repeat(64)])).rows[0];b.target_grant_id=row.id;b.target_grant_revision=row.revision }
        const keys = Object.keys(b); assert.ok(keys.every(k => /^[a-z_]+$/.test(k)))
        try { return Response.json((await db.query(`select * from public.pjsdas_commit_consumer_business_workspace_v1(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')})`, keys.map(k => typeof b[k] === 'object' && b[k] !== null ? JSON.stringify(b[k]) : b[k]))).rows) }
        catch (e) { return Response.json({ code: e.code, message: e.message }, { status: e.code === '42501' ? 403 : 500 }) }
      }
      assert.equal(u.searchParams.get('user_id'), `eq.${owner}`)
      const table = u.pathname.split('/').at(-1); assert.ok(['pjsdas_workspaces', 'pjsdas_business_management_grants', 'pjsdas_command_ledger'].includes(table))
      let rows = (await db.query(`select * from public.${table} where user_id=$1`, [owner])).rows
      for (const key of ['client_id', 'capability', 'consent_version', 'command_id']) { const filter = u.searchParams.get(key); if (filter?.startsWith('eq.')) rows = rows.filter(row => String(row[key]) === filter.slice(3)) }
      if (u.searchParams.get('revoked_at') === 'is.null') rows = rows.filter(row => row.revoked_at === null)
      const after = u.searchParams.get('resulting_revision'); if (after) rows = rows.filter(row => row.resulting_revision > Number(after.slice(3)))
      return Response.json(rows)
    }
    const runtime = createOwnerScopedManagementRuntime({ consumerEnabled: 'enabled', consumerCohort: { accountIds: `${owner},00000000-0000-4000-8000-000000005959`, clientId: client }, enabled: 'enabled', transactional: true, identity: { userId: owner, oauthClientId: client }, audience: { mode: 'allowlist', allowed: true, role: 'beta' }, supabaseUrl: origin, serviceRoleKey: 'fixture-only', fetchImpl }).business
    const stored = async () => (await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1', [owner])).rows[0].snapshot
    const ledgerCount = async () => (await db.query('select count(*) n from public.pjsdas_command_ledger where user_id=$1', [owner])).rows[0].n
    const read = await runtime.invoke('get_consumer_business_management', { query: { type: 'action', ids: [initial.data.actions[0].id] } })
    const { leverage, delayCost, ...facts } = initial.data.actions[0]
    assert.equal(typeof leverage, 'number'); assert.equal(typeof delayCost, 'number')
    assert.deepEqual(read.structuredContent.data.items[0], facts)
    assert.equal(Object.hasOwn(read.structuredContent.data.items[0], 'leverage'), false)
    assert.equal(Object.hasOwn(read.structuredContent.data.items[0], 'delayCost'), false)
    // The public projection must not redact or normalize the authoritative row.
    assert.deepEqual(await stored(), initial); assert.equal(await ledgerCount(), 0)
    if (index === 0) {
      for (const retired of [
        { kind: 'create_manual_action', value: { title: 'Retired score input', estimatedMinutes: 30, leverage: 70 } },
        { kind: 'update_manual_action', id: 'manual-b', patch: { delayCost: 70 } },
      ]) {
        const rejected = await runtime.invoke('execute_consumer_business_management', { commandId: `retired-${retired.kind}`, baseRevision: 0, change: { operations: [retired] } })
        assert.equal(rejected.structuredContent.code, 'SCORING_RETIRED')
      }
      assert.equal(posts, 0); assert.equal(await ledgerCount(), 0); assert.deepEqual(await stored(), initial)
    }
    const command = { commandId: `consumer-v7-raw-${scenario}`, baseRevision: 0, change: { operations: [op] } }
    const applied = await runtime.invoke('execute_consumer_business_management', command)
    if (scenario === 'revoke-before-rpc' || scenario === 'cas-before-rpc' || scenario.startsWith('tamper-')) {
      assert.ok(applied.isError || applied.structuredContent.outcome === 'CONFLICT'); assert.deepEqual(await stored(), initial); assert.equal(await ledgerCount(), 0)
      console.log(`PASS ${scenario}: SQL retained raw snapshot and appended no ledger receipt`); continue
    }
    assert.equal(applied.structuredContent.outcome, 'COMMITTED', JSON.stringify(applied))
    assert.equal((await runtime.invoke('execute_consumer_business_management', command)).structuredContent.outcome, 'ALREADY_APPLIED')
    const changed = await stored(), expected = structuredClone(initial)
    for (const [key, value] of Object.entries(initial.data)) if (!['timeline', 'prep', 'actions', 'applicationGroups'].includes(key)) assert.deepEqual(changed.data[key], value)
    assert.deepEqual(changed.data.actions.slice(0, 2), initial.data.actions.slice(0, 2))
    if (scenario === 'update_manual_action' || scenario === 'archive_manual_action') {
      const compensation = (await db.query('select compensation from public.pjsdas_command_ledger where user_id=$1 and command_id=$2', [owner, command.commandId])).rows[0].compensation
      const actionChange = compensation.payload.changes.find(change => change.type === 'action' && change.id === 'manual-b')
      // Undo evidence retains the complete historical scores, metadata and order.
      assert.deepEqual(actionChange.before, initial.data.actions.find(action => action.id === 'manual-b'))
      assert.deepEqual(actionChange.after, changed.data.actions.find(action => action.id === 'manual-b') ?? null)
      assert.equal(actionChange.beforeIndex, initial.data.actions.findIndex(action => action.id === 'manual-b'))
    }
    if (scenario.startsWith('newer-')) {
      if (scenario === 'newer-target') changed.data.prep[0].title = 'Later owner title'
      else { changed.data.actions[0].dueAt = '2026-12-31T01:00:00Z'; expected.data.actions[0].dueAt = changed.data.actions[0].dueAt }
      await db.query('update public.pjsdas_workspaces set snapshot=$1,revision=revision+1 where user_id=$2', [JSON.stringify(changed), owner])
    }
    const undo = { commandId: `consumer-v7-undo-${scenario}`, targetCommandId: command.commandId }
    const undone = await runtime.invoke('undo_consumer_business_management', undo)
    if (scenario === 'newer-target') { assert.equal(undone.isError, true); assert.deepEqual(await stored(), changed); assert.equal(posts, 1); console.log('PASS newer-target: undo refuses to overwrite later owner data'); continue }
    assert.equal(undone.structuredContent.outcome, 'COMMITTED', JSON.stringify(undone))
    assert.equal((await runtime.invoke('undo_consumer_business_management', undo)).structuredContent.outcome, 'ALREADY_APPLIED')
    const restored = await stored(); assert.equal(restored.version, initial.version)
    for (const [key, value] of Object.entries(expected.data)) if (key !== 'timeline') assert.deepEqual(restored.data[key], value, `${scenario}: exact ${key}`)
    assert.equal(await ledgerCount(), 2); assert.equal(posts, 2)
    console.log(`PASS ${scenario}: actual consumer v7 score-free read and raw commit/replay/undo preserve historical fields and order`)
  }
} finally { globalThis.fetch = network; await db.end() }

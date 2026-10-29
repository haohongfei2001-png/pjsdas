import { testTwoRowCompatibleCheckouts } from './workspace-rows-rollback-builds-stage-a.mjs'
import { installLegacyReadBridgeOnlyFixture } from './workspace-rows-legacy-read-fence-fixture.mjs'
import { testAcceptedReadability,testHistoryReadability } from './workspace-rows-readability-stage-a.mjs'
import { testAtomicMigrationAndCapacity } from './workspace-rows-migration-stage-a.mjs'
import { testActivatedCentralDiscovery } from './workspace-rows-central-discovery-stage-a.mjs'
import { testActivatedCentralGuards } from './workspace-rows-central-guards-stage-a.mjs'
/** Explicit local-only candidate harness. Never a production migration. */
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
const wire = value => JSON.parse(JSON.stringify(value))
const equal = (actual, expected) => assert(isDeepStrictEqual(actual, wire(expected)), 'complete JSON-wire value mismatch')
import { readFileSync } from 'node:fs'
import { randomUUID, randomBytes, createHmac, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import pg from 'pg'
import { install, checkpointMigration } from './gmail-empty-checkpoint-fixture.mjs'
import { migration } from './discovery-authority-fixture.mjs'
import { testPlanningRows } from './workspace-rows-planning-stage-a.mjs'
import { testProfileRows } from './workspace-rows-profile-stage-a.mjs'
import { testActualStoreRows } from './workspace-rows-store-stage-a.mjs'
import { testLayoutFenceRows } from './workspace-rows-layout-fence-stage-a.mjs'
import { testDiscoveryRows } from './workspace-rows-discovery-stage-a.mjs'
import { testCaptureRows } from './workspace-rows-ai-capture-stage-a.mjs'
import { testBusinessRows } from './workspace-rows-business-stage-a.mjs'
import { testOpportunityRows } from './workspace-rows-opportunity-stage-a.mjs'
import { testReminderRows } from './workspace-rows-reminder-stage-a.mjs'
import { createSnapshot } from '../../src/snapshot.ts'
import { gmailSemanticRecordFromMessage } from '../../gateway/gmailAutomation.ts'
import { applyGmailSemanticBatch } from '../../src/gmailSemanticIntake.ts'
import { createNotificationParsingScope } from '../../src/notificationParser.ts'
import { encodeWorkspaceRows, diffWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
import { createWorkspaceRowsCandidate } from '../../gateway/workspaceRowsCandidate.ts'

const connection = process.env.TA_ROW_DATABASE_URL
assert(connection, 'TA_ROW_DATABASE_URL must explicitly name a local isolated PostgreSQL admin connection')
const parsed = new URL(connection); assert(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'remote databases are forbidden')
const binary = process.env.TA_POSTGREST_BIN; assert(binary, 'TA_POSTGREST_BIN must name the verified official local binary')
const port = Number(process.env.TA_ROW_HTTP_PORT ?? 55442); assert(Number.isSafeInteger(port) && port > 1024 && port < 65536)
const database = `ta_row_candidate_${randomUUID().replaceAll('-', '')}`, admin = new pg.Client({ connectionString: connection })
const local = new URL(connection); local.pathname = '/' + database
const db = new pg.Client({ connectionString: local.href }); let created = false, server, publicServer
const runtimeFlags=['PJSDAS_WORKSPACE_ROWS_READS','PJSDAS_WORKSPACE_ROWS_WRITES','PJSDAS_WORKSPACE_ROWS_READ_CONCURRENCY'],priorRuntime=Object.fromEntries(runtimeFlags.map(key=>[key,process.env[key]]))
const secret = randomBytes(48).toString('hex'), encode = x => Buffer.from(JSON.stringify(x)).toString('base64url')
const jwt = role => { const body = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ role, exp: Math.floor(Date.now() / 1000) + 600 }); return body + '.' + createHmac('sha256', secret).update(body).digest('base64url') }
const origin = `http://127.0.0.1:${port}`, token = jwt('service_role'), assertions = []
const ok = name => { assertions.push(name); console.log('PASS', name) }
const userId = randomUUID(), workspaceId = randomUUID(), at = '2030-01-01T00:00:00.000Z'
const opportunities = Array.from({ length: 1000 }, (_, i) => ({ id: `synthetic-opp:${i}`, company: `合成企业${String(i).padStart(5, '0')}科技有限公司`, role: `数据分析师${String(i).padStart(5, '0')}`, currentStageLabel: '筛选中', processStage: 'screening', roleType: 'core', early: false, opportunityValue: 85, fitScore: 80, locallyManaged: true, importedAt: at }))
const before = createSnapshot({ opportunities, processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: Array.from({ length: 4500 }, (_, i) => ({ id: `synthetic-history:${i}`, kind: 'baseline_backfill', category: 'data', source: 'system', occurredAt: at, recordedAt: at, title: 'Synthetic history', detail: 'Retained synthetic history. '.repeat(80) })) }, at)
const scope = createNotificationParsingScope(), records = opportunities.slice(0, 8).map((o, i) => {
  const text = `${o.company} ${o.role} 投递成功；我们已收到您的申请。`
  return gmailSemanticRecordFromMessage({ id: `synthetic-message:${i}`, threadId: `synthetic-thread:${i}`, internalDate: String(Date.parse(at)), snippet: text, payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: text.split('；')[0] }, { name: 'From', value: 'synthetic@example.invalid' }], body: { data: Buffer.from(text).toString('base64url') } } }, opportunities, new Date(at), 'Asia/Shanghai', scope)
}).filter(Boolean)
const core = applyGmailSemanticBatch(before, { runId: 'synthetic-row-run', sourceId: 'gmail:primary', checkedAt: at, records, authorized: true, workspaceRevision: 'txn:0' })
assert.equal(records.length, 8); assert.notEqual(core.alreadyApplied, true)
const command = { commandId: 'synthetic-row-command', payloadHash: createHash('sha256').update(JSON.stringify(records)).digest('hex'), operation: 'gmail_semantic_intake', principal: 'automation', sourceId: 'gmail:primary', compensation: core.compensation, provenance: { sourceId: 'gmail:primary', runId: 'synthetic-row-run' }, effectiveTime: at, receiptContext: { contractVersion: 2, affectedObjects: [{ type: 'timeline', id: 'synthetic-row-run' }], lifecycle: { baseRevision: 0 }, commandId: 'must-not-override', status: 'FAILED', undoAvailable: false } }
try {
  await admin.connect(); await admin.query('create database ' + database); created = true; await db.connect()
  await install(db); await db.query(await migration(checkpointMigration))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-stage-a.sql', import.meta.url), 'utf8'))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-authoritative-stage-a.sql', import.meta.url), 'utf8'))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-planning-stage-a.sql', import.meta.url), 'utf8'))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-profile-stage-a.sql', import.meta.url), 'utf8'))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-reminder-stage-a.sql', import.meta.url), 'utf8'))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-opportunity-stage-a.sql', import.meta.url), 'utf8'))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-business-stage-a.sql', import.meta.url), 'utf8'))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-management-v2-stage-a.sql', import.meta.url), 'utf8'))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-ai-capture-stage-a.sql', import.meta.url), 'utf8'))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-discovery-stage-a.sql', import.meta.url), 'utf8'))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-history-stage-a.sql', import.meta.url), 'utf8'))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-bootstrap-stage-a.sql', import.meta.url), 'utf8'))
  await db.query(readFileSync(new URL('./candidates/workspace-rows-public-transport-stage-a.sql', import.meta.url), 'utf8'))
  await installLegacyReadBridgeOnlyFixture(db)
  const encoded = encodeWorkspaceRows(before)
  await db.query('begin')
  await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5)', [workspaceId, userId, encoded.envelope, JSON.stringify(encoded.manifest), before])
  await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)', [workspaceId, userId, JSON.stringify(encoded.rows)])
  await db.query('commit')
  server = spawn(binary, [], { env: { ...process.env, PGRST_DB_URI: local.href, PGRST_DB_SCHEMAS: 'pjsdas_rows_candidate,public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: secret, PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(port), PGRST_DB_POOL: '1', PGRST_DB_MAX_ROWS: '1000' }, stdio: ['ignore', 'ignore', 'pipe'] })
  let logs = ''; server.stderr.on('data', chunk => { logs += chunk })
  let ready = false
  for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw new Error('PostgREST startup failed: ' + logs); try { if ((await fetch(origin + '/')).status < 500) { ready = true; break } } catch {} await new Promise(resolve => setTimeout(resolve, 50)) }
  assert(ready)
  const hidden = await fetch(origin + '/rpc/apply_rows', { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ req: {} }) }); assert.equal(hidden.status, 404); ok('private low-level primitive is not exposed as an HTTP bypass')
  const source = createWorkspaceRowsCandidate({ supabaseUrl: origin, serviceRoleKey: token, readsEnabled: true, writesEnabled: true, readConcurrency: 4 })
  const initial = await source.read(userId); equal(initial.snapshot, before); ok('real candidate HTTP adapter reads exact large domain snapshot')
  const actualCore = applyGmailSemanticBatch(initial.snapshot, { runId: 'synthetic-row-run', sourceId: 'gmail:primary', checkedAt: at, records, authorized: true, workspaceRevision: 'txn:0' }); equal(wire(actualCore.snapshot), core.snapshot)
  const result = await source.commit(initial, actualCore.snapshot, command); assert.equal(result.outcome, 'COMMITTED')
  equal((await source.read(userId)).snapshot, core.snapshot); ok('actual core nonempty transition persists full cross-entity output and compensation')
  assert.equal(result.receipt.undoAvailable, true); assert.equal(result.receipt.commandId, command.commandId); assert.equal(result.receipt.status, 'COMMITTED'); assert.equal(result.receipt.contractVersion, 2); equal(result.receipt.affectedObjects, command.receiptContext.affectedObjects)
  const audit=(await db.query('select principal_kind,client_id,provenance,expected_revision,effective_time from pjsdas_rows_candidate.ledger where command_id=$1',[command.commandId])).rows[0]
  assert.equal(audit.principal_kind,'automation');assert.equal(audit.client_id,null);equal(audit.provenance,command.provenance);assert.equal(Number(audit.expected_revision),0);assert.equal(audit.effective_time.toISOString(),at)
  ok('original provenance/lifecycle/affected objects and SQL-owned receipt fields survive row commit')
  equal((await db.query('select compensation from pjsdas_rows_candidate.ledger')).rows[0].compensation, core.compensation)
  const replay = await source.commit(initial, core.snapshot, command); assert.equal(replay.outcome, 'ALREADY_APPLIED'); equal(replay.receipt, result.receipt); ok('same request after lost return replays exact receipt')
  for (const operation of ['opportunity_update', 'planning_update', 'discovery_profile_update', 'private_reminder_update', 'consumer_business_update', 'ai_capture', 'discovery_batch']) {
    await assert.rejects(source.commit(initial, core.snapshot, { ...command, operation }), /UNSUPPORTED/)
  }
  for (const key of ['managementAuthorization', 'aiCaptureAuthorization', 'discoveryAuthorization']) await assert.rejects(source.commit(initial, core.snapshot, { ...command, [key]: {} }), /UNSUPPORTED/)
  ok('all not-yet-adapted guarded families fail closed; none silently use generic rows')
  const raw = { ...diffWorkspaceRows(initial.snapshot, core.snapshot), ...command, workspaceId, userId, expectedEpoch: initial.epoch, expectedRevision: 0 }
  for (const change of [{ operation: 'planning_update' }, { managementAuthorization: {} }, { aiCaptureAuthorization: {} }, { discoveryAuthorization: {} }]) {
    const response = await fetch(origin + '/rpc/commit_rows', { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ req: { ...raw, ...change } }) }); assert(response.status >= 400)
  }
  for (const bad of [{ ...raw, commandId: 1 }, { ...raw, expectedEpoch: randomUUID() }, { ...raw, receiptContext: [] }, { ...raw, provenance: 'not-an-object' }]) {
    const response = await fetch(origin + '/rpc/commit_rows', { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ req: bad }) }); assert(response.status >= 400)
  }
  const downgrade={...raw,...diffWorkspaceRows(core.snapshot,{...core.snapshot,version:3}),commandId:'synthetic-schema-downgrade',expectedRevision:1,schemaVersion:3}
  assert.equal((await fetch(origin+'/rpc/commit_rows',{method:'POST',signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({req:downgrade})})).status,400)
  equal((await source.read(userId)).snapshot, core.snapshot)
  ok('direct HTTP bypass of adapter still rejects unsupported guard families and schema downgrade without mutation')

  for (const role of ['anon', 'authenticated']) {
    const response = await fetch(origin + '/rpc/read_head', { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { authorization: 'Bearer ' + jwt(role), 'content-type': 'application/json' }, body: JSON.stringify({ target_user_id: userId }) })
    assert([401, 403, 404].includes(response.status)); ok(role + ' denied at actual candidate HTTP schema')
  }
  const current = await source.read(userId), next = structuredClone(current.snapshot); next.data.opportunities.reverse()
  let calls = 0, injected = false
  const concurrent = createWorkspaceRowsCandidate({ supabaseUrl: origin, serviceRoleKey: token, readsEnabled: true, fetchImpl: async (url, init) => {
    const response = await fetch(url, init)
    if (String(url).endsWith('/read_page') && ++calls === 1) { await source.commit(current, next, { ...command, commandId: 'synthetic-concurrent', payloadHash: 'b'.repeat(64) }); injected = true }
    return response
  } })
  await assert.rejects(concurrent.read(userId), /CONFLICT/); assert(injected); equal((await source.read(userId)).snapshot, next); ok('actual HTTP page/commit interleaving fails closed then fresh read is exact')
  const noNetwork = createWorkspaceRowsCandidate({ supabaseUrl: origin, serviceRoleKey: token, fetchImpl: () => { throw new Error('disabled adapter must not fetch') } })
  await assert.rejects(noNetwork.read(userId), /DISABLED/); ok('default-off adapter performs no request')
  await testPlanningRows({ db, source, origin, token, connectionString: local.href })
  await testProfileRows({ db, source, origin, token, connectionString: local.href })
  await testReminderRows({ db, source, origin, token })
  await testOpportunityRows({ db, source, origin, token })
  await testBusinessRows({ db, source, origin, token })
  await testCaptureRows({ db, source, origin, token })
  await testDiscoveryRows({ db, source, connectionString: local.href })
  await testLayoutFenceRows({ db, source, connectionString: local.href, origin, token })
  const publicPort=port+1;assert(publicPort<65536)
  const publicOrigin=`http://127.0.0.1:${publicPort}`
  publicServer=spawn(binary,[],{env:{...process.env,PGRST_DB_URI:local.href,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:secret,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:String(publicPort),PGRST_DB_POOL:'1',PGRST_DB_MAX_ROWS:'1000'},stdio:['ignore','ignore','pipe']})
  let publicLogs='',publicReady=false;publicServer.stderr.on('data',chunk=>{publicLogs+=chunk})
  for(let i=0;i<100;i++){if(publicServer.exitCode!==null)throw new Error('Public PostgREST startup failed: '+publicLogs);try{if((await fetch(publicOrigin+'/')).status<500){publicReady=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,50))}
  assert(publicReady)
  const wrappers=(await db.query("select p.oid::regprocedure::text signature,p.prosecdef,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') authenticated,has_function_privilege('service_role',p.oid,'execute') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pjsdas_rows_v1_%' order by p.proname")).rows
  assert.equal(wrappers.length,15);assert(wrappers.every(p=>!p.prosecdef&&!p.anon&&!p.authenticated&&p.service),'exact service-only invoker transport ACL')
  assert.equal((await fetch(publicOrigin+'/rpc/pjsdas_rows_v1_read_head',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({target_user_id:userId})})).status,409,'public transport cannot expose an unactivated shadow generation')
  const shadow=await source.read(userId)
  assert.equal((await fetch(publicOrigin+'/rpc/pjsdas_rows_v1_commit_rows',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({req:{...diffWorkspaceRows(shadow.snapshot,shadow.snapshot),workspaceId,userId,expectedEpoch:shadow.epoch,expectedRevision:shadow.revision,commandId:'synthetic-unactivated-public-write',payloadHash:'c'.repeat(64),operation:'gmail_semantic_intake',principal:'automation',sourceId:'gmail:primary',compensation:null}})})).status,409,'public writer cannot mutate an unactivated shadow generation')
  for(const role of ['anon','authenticated']) {
   const response=await fetch(publicOrigin+'/rpc/pjsdas_rows_v1_read_head',{method:'POST',headers:{authorization:'Bearer '+jwt(role),'content-type':'application/json'},body:JSON.stringify({target_user_id:userId})})
   assert([401,403].includes(response.status),'ordinary role cannot read via public wrapper')
  }
  assert.equal((await fetch(publicOrigin+'/rpc/read_head',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','content-profile':'pjsdas_rows_candidate'},body:JSON.stringify({target_user_id:userId})})).status,406,'candidate schema is not exposed')
  process.env.PJSDAS_WORKSPACE_ROWS_READS='1';process.env.PJSDAS_WORKSPACE_ROWS_WRITES='1';process.env.PJSDAS_WORKSPACE_ROWS_READ_CONCURRENCY='4'
  await testActualStoreRows({ db, origin:publicOrigin, token, initial: before, records, rpcTransport:'public-v1',runtime:true })
  await testActivatedCentralGuards({ db, origin:publicOrigin, token, rpcTransport:'public-v1' })
  await testActivatedCentralDiscovery({ db, origin:publicOrigin, token, connectionString:local.href })
  ok('all actual central paths run through public-only versioned service-invoker RPCs; candidate schema remains unexposed')
  await testAtomicMigrationAndCapacity({db,connectionString:local.href,initial:before})
  await testAcceptedReadability({db,origin:publicOrigin,token})
  await testHistoryReadability({db,origin:publicOrigin,token})
  await testTwoRowCompatibleCheckouts({db,origin:publicOrigin,token,initial:before,records})
  console.log(JSON.stringify({ status: 'PASS_STAGE_A_VERTICAL_ONLY', assertions: assertions.length, open: ['actual platform limits and caller enablement', 'migration and rollback release', 'resource capacity'], production: false }))
} finally {
  for(const key of runtimeFlags)if(priorRuntime[key]===undefined)delete process.env[key];else process.env[key]=priorRuntime[key]
  if (publicServer && publicServer.exitCode === null) { publicServer.kill('SIGTERM'); await new Promise(resolve => publicServer.once('exit', resolve)) }
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)) }
  await db.end(); if (created) await admin.query('drop database ' + database + ' with (force)'); await admin.end()
}

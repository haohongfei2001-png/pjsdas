// Synthetic-only actual executor/store -> SQL; no production URL or external calls.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
const repo=resolve(process.argv[2]??process.cwd()),load=p=>import(pathToFileURL(resolve(repo,p)).href)
const require=createRequire(resolve(repo,'tests/sql/package.json'))
const {createAuthoritativeCommandExecutor}=await load('gateway/authoritativeCommands.ts')
const {readOpportunityManagement}=await load('src/opportunityManagement.ts')
const {unknownDeadlineWorkspace}=await load('tests/fixtures/unknownDeadlineWorkspace.ts')
let db
if(process.env.TA_OPPORTUNITY_RAW_SQL_TEST_URL){
 const url=new URL(process.env.TA_OPPORTUNITY_RAW_SQL_TEST_URL)
 if(url.protocol!=='postgresql:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/ta_opportunity_raw_fixture'||url.username!=='postgres'||url.password!=='fixture-only'||url.search)throw new Error('Only the isolated synthetic loopback database is accepted.')
 const {default:pg}=await import(pathToFileURL(require.resolve('pg')).href),client=new pg.Client({connectionString:url.toString(),statement_timeout:15000})
 pg.types.setTypeParser(20, value => { const n=Number(value); if(!Number.isSafeInteger(n))throw new Error('Fixture integer overflow');return n });await client.connect();db={query:(...args)=>client.query(...args),exec:sql=>client.query(sql),close:()=>client.end()}
}else{const {PGlite}=await import(pathToFileURL(require.resolve('@electric-sql/pglite')).href);db=new PGlite()}
const network=globalThis.fetch
globalThis.fetch=async()=>{throw new Error('Unexpected external network call')}
const protectedData=s=>Object.fromEntries(Object.entries(s.data).filter(([k])=>!['opportunities','timeline','processes','processEvents','actions','scheduleNodes','reminderIntents'].includes(k)))
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;')
 for(const f of ['2026091901_ai_operated_mutation_foundation.sql','20260923030000_cgr01_authoritative_commands.sql','20261002123812_consumer_management_atomic_grants.sql','20261002175431_opportunity_management_v3.sql','20261002195807_planning_management_v4.sql','20261002211312_discovery_profile_management_v5.sql','20261002220516_private_reminder_management_v6.sql','20261002234255_opportunity_management_raw_boundary.sql'])await db.exec(await readFile(resolve(repo,'supabase/migrations',f),'utf8'))
 const compactBytes=async value=>Number((await db.query('select public.pjsdas_opportunity_evidence_bytes_v1($1::jsonb) n',[JSON.stringify(value)])).rows[0].n)
 const numbers=[0,-0,1e-7,1e-6,1e20,1e21,Number.MAX_VALUE,Number.MIN_VALUE,-Number.MAX_VALUE,-Number.MIN_VALUE,100.001,1.2345678901234568e-5]
 let seed=0x123456789abcdef0n;const bits=new DataView(new ArrayBuffer(8))
 for(let i=0;i<1000;i++){seed=BigInt.asUintN(64,seed*6364136223846793005n+1442695040888963407n);bits.setBigUint64(0,seed);const n=bits.getFloat64(0);if(Number.isFinite(n))numbers.push(n)}
 const samples=[numbers,{quote:'a"b',unicode:'中文😀',control:'\n\t\r',empty:{},array:[],nested:[true,false,null,{x:1.5}]}]
 for(const value of samples)assert.equal(await compactBytes(value),Buffer.byteLength(JSON.stringify(value)))
 for(const [literal,canonical]of [['1.000000000000000001','1.000000000000000001'],['9007199254740993123456789','9.007199254740993123456789e+24'],['0.000000100000000000000001','1.00000000000000001e-7']]){
  assert.equal(Number((await db.query('select public.pjsdas_opportunity_evidence_bytes_v1($1::jsonb) n',[literal])).rows[0].n),Buffer.byteLength(canonical))
 }
 await db.exec('set role authenticated');await assert.rejects(db.query("select public.pjsdas_opportunity_evidence_bytes_v1('{}'::jsonb)"),e=>e.code==='42501');await db.exec('reset role')
 console.log('PASS compact byte verifier: JavaScript finite-double corpus, UTF8/escaping/structure and exact high-precision JSONB numerics; helper not publicly executable')
 for(const [index,scenario]of ['profile-raw','max-admitted-evidence','archive-raw','archive-node-raw','archive-undo-new-node','archive-undo-new-outbox','newer-unrelated','newer-target','tamper-action','tamper-source','tamper-history','tamper-outbox','tamper-unselected','tamper-order','tamper-oversized-evidence','tamper-deep-evidence'].entries()){
  const owner=`00000000-0000-4000-8000-${String(100+index).padStart(12,'0')}`,client='10000000-0000-4000-8000-000000000001',id=`20000000-0000-4000-8000-${String(100+index).padStart(12,'0')}`
  const initial=JSON.parse(JSON.stringify(unknownDeadlineWorkspace(3)))
  initial.data.actions[1].dueAt='2026-08-27T15:59:59Z';initial.data.actions[1].timingMode='deadline'
  if(scenario==='archive-node-raw'||scenario.startsWith('archive-undo-')){
   const node={id:'archive-owned-node',occurrenceId:'archive-owned-occurrence',version:1,kind:'interview',state:'scheduled',opportunityId:'unknown-0',temporal:{shape:'fixed_range',precision:'datetime',timezone:'UTC',startAt:'2026-10-03T02:00:00Z',endAt:'2026-10-03T03:00:00Z',resolutionBasis:'user_explicit'},constraintKind:'user_plan',evidenceRefs:[],sourceVersionRefs:[],relatedActionIds:[initial.data.actions[0].id],relatedPrepIds:[],createdAt:'2026-10-02T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z',metadata:{original:true}}
   initial.data.scheduleNodes.push(node)
   initial.data.reminderIntents.push({id:'archive-owned-reminder',scheduleNodeId:node.id,scheduleNodeVersion:1,purpose:'custom',triggerAt:'2026-10-03T01:00:00Z',deliveryOwner:'pjsdas',channel:'in_product',state:'active',dedupeKey:`${node.id}@1|custom`,createdAt:'2026-10-02T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z',metadata:{retain:true}})
  }
  if(scenario==='max-admitted-evidence')initial.data.opportunities[0].rawMetadata=Object.fromEntries(Array.from({length:40000},(_,i)=>['k'+i,'v']))
  initial.data.opportunities[1].privateMetadata={exact:['retain',null]}
  initial.data.timeline=[{id:'original-history',kind:'application_submitted',category:'process',source:'user_action',occurredAt:'2026-10-02T00:00:00Z',recordedAt:'2026-10-02T00:00:00Z',title:'Retain original receipt'}]
  await db.query('insert into auth.users(id)values($1)',[owner]);await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version)values($1,$2,4)',[owner,JSON.stringify(initial)])
  await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash)values($1,$2,$3,'workspace.opportunity.manage',3,$4)",[id,owner,client,'a'.repeat(64)])
  let posts=0
  const fetchImpl=async(input,init)=>{
   const u=new URL(String(input));assert.equal(u.origin,'https://fixture.invalid')
   if(init?.method==='POST'){
    posts++;assert.equal(u.pathname,'/rest/v1/rpc/pjsdas_commit_opportunity_workspace_v1')
    const b=JSON.parse(String(init.body))
    if(scenario==='tamper-oversized-evidence')b.target_compensation.padding='x'.repeat(1048576)
    if(scenario==='tamper-deep-evidence'){let nested={};for(let i=0;i<130;i++)nested={next:nested};b.target_compensation.padding=nested}
    if(scenario==='tamper-action')delete b.target_snapshot.data.actions[1].dueAt
    if(scenario==='tamper-source'){b.target_snapshot.data.opportunities[0].company='Unrequested';b.target_compensation.payload.changes[0].after.company='Unrequested'}
    if(scenario==='tamper-history')b.target_snapshot.data.timeline[0].title='Rewritten'
    if(scenario==='tamper-outbox')b.target_snapshot.data.reminderOutbox.push({id:'forbidden-delivery'})
    if(scenario==='tamper-unselected')b.target_snapshot.data.opportunities[1].early=true
    if(scenario==='tamper-order')b.target_snapshot.data.opportunities.reverse()
    if(scenario==='max-admitted-evidence'&&b.target_operation==='opportunity_management'){
     const compactBytes=Buffer.byteLength(JSON.stringify(b.target_compensation))
     const textBytes=(await db.query('select octet_length($1::jsonb::text)::int n',[JSON.stringify(b.target_compensation)])).rows[0].n
     assert.ok(compactBytes<=1048576);assert.ok(textBytes>1048576)
     console.log(`EVIDENCE_BYTES compact=${compactBytes} postgres_text=${textBytes}; compact verifier preserves the unchanged 1MiB contract`)
    }
    try{
     const out=await db.query('select * from public.pjsdas_commit_opportunity_workspace_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',[owner,b.target_command_id,b.target_operation,b.target_payload_hash,b.target_expected_revision,JSON.stringify(b.target_snapshot),b.target_schema_version,b.target_principal_kind,client,JSON.stringify(b.target_provenance),JSON.stringify(b.target_compensation),b.target_effective_time,JSON.stringify(b.target_receipt_context),b.target_grant_id,b.target_grant_revision])
     return Response.json(out.rows.map(({snapshot,...row})=>row))
    }catch(e){return Response.json({code:e.code,message:e.message},{status:e.code==='42501'?403:500})}
   }
   assert.equal(u.searchParams.get('user_id'),`eq.${owner}`)
   if(u.pathname.endsWith('pjsdas_workspaces'))return Response.json((await db.query('select * from public.pjsdas_workspaces where user_id=$1',[owner])).rows)
   assert.ok(u.pathname.endsWith('pjsdas_command_ledger'))
   const rows=(await db.query("select * from public.pjsdas_command_ledger where user_id=$1 and status='COMMITTED' order by resulting_revision",[owner])).rows
   const command=u.searchParams.get('command_id'),after=u.searchParams.get('resulting_revision')
   return Response.json(rows.filter(r=>(!command||command===`eq.${r.command_id}`)&&(!after||r.resulting_revision>Number(after.slice(3)))))
  }
  const grant={id,revision:1,userId:owner,clientId:client,consentVersion:3,capability:'workspace.opportunity.manage',grantedAt:'2026-10-01T00:00:00Z'}
  const executor=createAuthoritativeCommandExecutor({supabaseUrl:'https://fixture.invalid',serviceRoleKey:'fixture-only',fetchImpl,resolveOpportunityManagementGrant:async()=>grant}),principal={kind:'delegated_mcp',userId:owner,clientId:client}
  const read=await readOpportunityManagement(initial,'unknown-0')
  const op=scenario.startsWith('archive-')?{kind:'archive_opportunity',id:'unknown-0',expectedFingerprint:read.archive.fingerprint,dependencies:read.archive.dependencies,reason:'Synthetic reviewed archive'}:{kind:'update_opportunity_profile',id:'unknown-0',expectedFingerprint:read.profileFingerprint,patch:{early:true}}
  const command={commandId:`raw-${scenario}-apply`,baseRevision:0,command:{type:'opportunity_management',value:{operations:[op]}}}
  if(scenario.startsWith('tamper-')){
   await assert.rejects(executor.execute(principal,command),e=>e.code==='AUTH_FORBIDDEN')
   assert.deepEqual((await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1',[owner])).rows[0].snapshot,initial)
   assert.equal((await db.query('select count(*)::int n from public.pjsdas_command_ledger where user_id=$1',[owner])).rows[0].n,0)
   console.log(`PASS ${scenario}: SQL refused collateral data/history/source mutation and retained raw workspace`);continue
  }
  const applied=await executor.execute(principal,command);assert.equal(applied.outcome,'COMMITTED');assert.equal((await executor.execute(principal,command)).outcome,'ALREADY_APPLIED')
  if(scenario.startsWith('archive-undo-')){
   const current=(await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1',[owner])).rows[0].snapshot
   const proposed=structuredClone(initial);proposed.data.timeline=current.data.timeline
   if(scenario==='archive-undo-new-node'){
    const later={...initial.data.scheduleNodes.find(n=>n.id==='archive-owned-node'),id:'new-owner-node',version:2}
    current.data.scheduleNodes.push(later);proposed.data.scheduleNodes.push(later)
   }else{
    const later={id:'new-delivery',reminderIntentId:'archive-owned-reminder',operation:'upsert',capability:'chatgpt_tasks',state:'pending',attemptCount:0,payloadFingerprint:'fixture',createdAt:'2026-10-03T00:00:00Z',updatedAt:'2026-10-03T00:00:00Z'}
    current.data.reminderOutbox.push(later);proposed.data.reminderOutbox.push(later)
   }
   await db.query('update public.pjsdas_workspaces set snapshot=$1,revision=2 where user_id=$2',[JSON.stringify(current),owner])
   await assert.rejects(db.query('select * from public.pjsdas_commit_opportunity_workspace_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',[owner,`raw-${scenario}-forged-undo`,'undo_command','synthetic-undo-hash',2,JSON.stringify(proposed),4,'delegated_mcp',client,JSON.stringify({undoOf:command.commandId}),'{}',null,'{}',id,1]),e=>e.code==='42501')
   assert.deepEqual((await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1',[owner])).rows[0].snapshot,current)
   assert.equal((await db.query('select count(*)::int n from public.pjsdas_command_ledger where user_id=$1',[owner])).rows[0].n,1)
   console.log(`PASS ${scenario}: direct RPC preserves new dependency and refuses archive undo`);continue
  }
  let expected=structuredClone(initial)
  if(scenario.startsWith('newer-')){
   const current=(await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1',[owner])).rows[0].snapshot
   if(scenario==='newer-target')current.data.opportunities[0].detail={gap:'Later owner edit'}
   else {current.data.actions[1].dueAt='2026-12-31T01:00:00Z';expected.data.actions[1].dueAt='2026-12-31T01:00:00Z'}
   await db.query('update public.pjsdas_workspaces set snapshot=$1,revision=2 where user_id=$2',[JSON.stringify(current),owner])
   if(scenario==='newer-target'){
    await assert.rejects(executor.undo(principal,{commandId:`raw-${scenario}-undo`,targetCommandId:command.commandId,expectedCompensationFingerprint:applied.result.compensationFingerprint}),/newer|changed/)
    assert.deepEqual((await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1',[owner])).rows[0].snapshot,current);assert.equal(posts,1);console.log('PASS newer-target: restore refuses newer input');continue
   }
  }
  const undo={commandId:`raw-${scenario}-undo`,targetCommandId:command.commandId,expectedCompensationFingerprint:applied.result.compensationFingerprint}
  assert.equal((await executor.undo(principal,undo)).outcome,'COMMITTED');assert.equal((await executor.undo(principal,undo)).outcome,'ALREADY_APPLIED');assert.equal(posts,2)
  const stored=(await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1',[owner])).rows[0].snapshot
  for(const [key,value]of Object.entries(expected.data))if(key!=='timeline')assert.deepEqual(stored.data[key],value,`${scenario} ${key}`)
  assert.deepEqual(protectedData(stored),protectedData(expected));assert.deepEqual(stored.data.timeline.slice(0,1),initial.data.timeline)
  console.log(`PASS ${scenario}: actual raw gateway commit/replay/undo and exact unrelated data retention`)
 }
}finally{globalThis.fetch=network;await db.close()}

// Fresh-account source integration: actual first-party handlers, scoped runtime,
// authoritative executor and PostgreSQL RPCs. Provider and transport are synthetic.
import pg from 'pg'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createConnectedWorkspaceHandler } from '../../gateway/connectedWorkspaceHandler.ts'
import { createScopedManagementConsentHandler } from '../../gateway/scopedManagementConsentHandler.ts'
import { createOwnerScopedManagementRuntime } from '../../gateway/scopedManagementRuntime.ts'
const url=new URL(process.env.TA_MANAGEMENT_SQL_TEST_URL??'http://missing.invalid')
if(url.protocol!=='postgresql:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/ta_management_fixture'||url.username!=='postgres'||url.password!=='fixture-only'||url.search)throw new Error('Only isolated loopback synthetic fixture is accepted.')
pg.types.setTypeParser(20,Number)
const db=new pg.Client({connectionString:url.toString(),statement_timeout:15000})
const owner='00000000-0000-4000-8000-000000005151',client='00000000-0000-4000-8000-000000005152',origin='https://synthetic.invalid'
const token=`a.${Buffer.from(JSON.stringify({sub:owner})).toString('base64url')}.synthetic`,network=globalThis.fetch
const post=(body)=>new Request(origin+'/api/workspace',{method:'POST',headers:{origin,authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)})
const read=()=>new Request(origin+'/api/workspace',{headers:{origin,authorization:`Bearer ${token}`}})
const jsonResponse=(r)=>Response.json(r.rows)
const rpcNames=new Set(['pjsdas_bootstrap_consumer_workspace_v1','pjsdas_decide_scoped_management_consent_v1','pjsdas_commit_planning_workspace_v1','pjsdas_commit_consumer_business_workspace_v1'])
try{
 await db.connect();await db.query(await readFile(new URL('../../supabase/migrations/20261003104723_consumer_business_scoped_access.sql',import.meta.url),'utf8'));await db.query('insert into auth.users(id) values($1)',[owner]);await db.query("insert into public.pjsdas_access_grants(user_id,role) values($1,'beta')",[owner]);await db.query("insert into public.pjsdas_business_management_grants(user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,'workspace.manage',2,$3)",[owner,client,'b'.repeat(64)]);const legacyV2=(await db.query("select to_jsonb(g) v from public.pjsdas_business_management_grants g where user_id=$1 and capability='workspace.manage'",[owner])).rows[0].v;await db.query('set role service_role')
 globalThis.fetch=async()=>{throw new Error('External network is forbidden in this fixture')}
 const fetchImpl=async(input,init)=>{
  const u=new URL(String(input));assert.equal(u.origin,origin)
  if(u.pathname==='/auth/v1/user')return Response.json({id:owner})
  if(u.pathname==='/auth/v1/user/oauth/grants')return Response.json([{client:{id:client,name:'Synthetic fresh client'},scopes:[],granted_at:'2026-10-03T00:00:00Z'}])
  if(init?.method==='POST'){
   const fn=u.pathname.split('/').at(-1);assert.ok(rpcNames.has(fn));const b=JSON.parse(String(init.body));assert.equal(b.target_user_id,owner)
   const keys=Object.keys(b);assert.ok(keys.every(key=>/^[a-z_]+$/.test(key)))
   try{return jsonResponse(await db.query(`select * from public.${fn}(${keys.map((key,i)=>`${key}=>$${i+1}`).join(',')})`,keys.map(key=>typeof b[key]==='object'&&b[key]!==null?JSON.stringify(b[key]):b[key])))}catch(e){console.error('SYNTHETIC_SQL_FAILURE',fn,e.code,e.message);return Response.json({code:e.code,message:e.message},{status:e.code==='42501'?403:500})}
  }
  assert.equal(u.searchParams.get('user_id'),`eq.${owner}`)
  const table=u.pathname.split('/').at(-1);assert.ok(['pjsdas_workspaces','pjsdas_business_management_grants','pjsdas_command_ledger'].includes(table))
  let rows=(await db.query(`select * from public.${table} where user_id=$1`,[owner])).rows
  for(const key of ['client_id','capability','consent_version','command_id']){
   const filter=u.searchParams.get(key);if(filter?.startsWith('eq.'))rows=rows.filter(row=>String(row[key])===filter.slice(3))
   else if(key==='capability'&&filter?.startsWith('in.(')){const values=filter.slice(4,-1).split(',');rows=rows.filter(row=>values.includes(row.capability))}
  }
  if(u.searchParams.get('revoked_at')==='is.null')rows=rows.filter(row=>row.revoked_at===null)
  const after=u.searchParams.get('resulting_revision');if(after)rows=rows.filter(row=>row.resulting_revision>Number(after.slice(3)))
  return Response.json(rows)
 }
 const config={enabled:'enabled',consumerEnabled:'enabled',audienceMode:'allowlist',supabaseUrl:origin,supabasePublishableKey:'synthetic-public',serviceRoleKey:'synthetic-service',allowedOrigins:[origin],authorizeIdentity:async()=>({allowed:true,mode:'allowlist',role:'beta'}),fetchImpl}
 const workspace=createConnectedWorkspaceHandler({...config,consumerOnboardingEnabled:true}),consent=createScopedManagementConsentHandler(config)
 const runtime=createOwnerScopedManagementRuntime({...config,transactional:true,identity:{userId:owner,oauthClientId:client},audience:{allowed:true,mode:'allowlist',role:'beta'}})
 assert.equal((await runtime.planning.invoke('get_planning_management',{})).isError,true);assert.equal((await runtime.business.invoke('get_consumer_business_management',{query:{type:'prep'}})).structuredContent.authorized,false);assert.equal((await runtime.business.invoke('execute_consumer_business_management',{commandId:'legacy-cannot-consumer',baseRevision:0,change:{operations:[{kind:'create_prep',value:{title:'Forbidden',estimatedMinutes:30}}]}})).structuredContent.code,'AUTH_FORBIDDEN')
 const initialize={action:'initialize_empty',expectedAccountId:owner,commandId:'synthetic-empty-start',timezone:'America/New_York',confirmStartEmpty:true}
 const started=await workspace(post(initialize));assert.equal(started.status,200,await started.clone().text());const start=await started.json();assert.equal(start.snapshot.data.opportunities.length,0);assert.equal(start.snapshot.data.timePlanning.timezone,'America/New_York')
 const view=await (await consent(read())).json();const descriptor=view.descriptors.find(d=>d.domain==='planning'),businessDescriptor=view.descriptors.find(d=>d.domain==='business');assert.equal(businessDescriptor.canApprove,true)
 const decision={requestId:'00000000-0000-4000-8000-000000005153',expectedAccountId:owner,clientId:client,confirmed:true,choices:[{domain:'planning',decision:'approve',consentVersion:4,consentTextHash:descriptor.consentTextHash,expectedGrant:null},{domain:'business',decision:'approve',consentVersion:7,consentTextHash:businessDescriptor.consentTextHash,expectedGrant:null}]}
 const approved=await consent(post(decision));assert.equal(approved.status,200,await approved.clone().text())
 const current=(await runtime.planning.invoke('get_planning_management',{})).structuredContent;assert.equal(current.authorized,true)
 const command={commandId:'consumer-planning-update',baseRevision:0,change:{operations:[{kind:'patch_time_preferences',expectedFingerprint:current.data.timePreferences.fingerprint,patch:{defaultDailyMinutes:75}}]}}
 const changed=(await runtime.planning.invoke('execute_planning_management',command)).structuredContent;assert.equal(changed.outcome,'COMMITTED',JSON.stringify(changed))
 assert.equal((await runtime.planning.invoke('get_planning_management',{})).structuredContent.data.timePreferences.raw.defaultDailyMinutes,75)
 const undo={commandId:'consumer-planning-undo',targetCommandId:command.commandId,expectedCompensationFingerprint:changed.result.compensationFingerprint}
 const undone=await runtime.planning.invoke('restore_planning_management',undo);assert.equal(undone.structuredContent.outcome,'COMMITTED',JSON.stringify(undone))
 assert.deepEqual((await runtime.planning.invoke('get_planning_management',{})).structuredContent.data.timePreferences.raw,start.snapshot.data.timePlanning)
 const existing=await (await workspace(post({...initialize,timezone:'Europe/London'}))).json();assert.equal(existing.outcome,'EXISTING_WORKSPACE');assert.equal(existing.snapshot.data.timePlanning.timezone,'America/New_York')
 const businessRead=(await runtime.business.invoke('get_consumer_business_management',{query:{type:'prep'}})).structuredContent
 assert.equal(businessRead.authorized,true);assert.deepEqual(businessRead.data.items,[])
 const businessCommand={commandId:'consumer-business-create',baseRevision:Number(businessRead.workspaceVersion.slice(4)),change:{operations:[{kind:'create_prep',value:{title:'Synthetic reviewed prep',estimatedMinutes:30}}]}}
 const businessApplied=await runtime.business.invoke('execute_consumer_business_management',businessCommand);assert.equal(businessApplied.structuredContent.outcome,'COMMITTED',JSON.stringify(businessApplied))
 assert.equal((await runtime.business.invoke('get_consumer_business_management',{query:{type:'prep'}})).structuredContent.data.items[0].title,'Synthetic reviewed prep')
 const businessUndo={commandId:'consumer-business-undo',targetCommandId:businessCommand.commandId}
 const businessUndone=await runtime.business.invoke('undo_consumer_business_management',businessUndo);assert.equal(businessUndone.structuredContent.outcome,'COMMITTED',JSON.stringify(businessUndone))
 assert.deepEqual((await runtime.business.invoke('get_consumer_business_management',{query:{type:'prep'}})).structuredContent.data.items,[])
 const proofs=(await (await consent(read())).json()).clients[0].grants,proof=proofs.find(g=>g.domain==='planning'),businessProof=proofs.find(g=>g.domain==='business')
 const revoke={...decision,requestId:'00000000-0000-4000-8000-000000005154',choices:[{...decision.choices[0],decision:'revoke',expectedGrant:{id:proof.id,revision:proof.revision}},{...decision.choices[1],decision:'revoke',expectedGrant:{id:businessProof.id,revision:businessProof.revision}}]}
 assert.equal((await consent(post(revoke))).status,200)
 for(const [method,input]of [['get_planning_management',{}],['execute_planning_management',command],['restore_planning_management',undo]])assert.equal((await runtime.planning.invoke(method,input)).structuredContent.code,'AUTH_FORBIDDEN')
 assert.equal((await runtime.discoveryProfile.invoke('get_discovery_profile_management',{})).structuredContent.code,'AUTH_FORBIDDEN')
 assert.equal((await runtime.business.invoke('get_consumer_business_management',{query:{type:'prep'}})).structuredContent.authorized,false);for(const [name,args]of [['execute_consumer_business_management',businessCommand],['undo_consumer_business_management',businessUndo]])assert.equal((await runtime.business.invoke(name,args)).structuredContent.code,'AUTH_FORBIDDEN');assert.deepEqual((await db.query("select to_jsonb(g) v from public.pjsdas_business_management_grants g where user_id=$1 and capability='workspace.manage'",[owner])).rows[0].v,legacyV2);assert.equal((await db.query('select count(*) n from public.pjsdas_command_ledger where user_id=$1',[owner])).rows[0].n,4)
 const beforeMixed=(await db.query('select to_jsonb(g) v from public.pjsdas_business_management_grants g where user_id=$1 order by capability',[owner])).rows
 const nextView=await (await consent(read())).json(),currentProofs=nextView.clients[0].grants
 const allChoices=nextView.descriptors.map(d=>{const g=currentProofs.find(g=>g.domain===d.domain);return{domain:d.domain,decision:'approve',consentVersion:d.consent.version,consentTextHash:d.consentTextHash,expectedGrant:g?{id:g.id,revision:g.revision}:null}})
 const staleMixed=structuredClone(allChoices);staleMixed.find(c=>c.domain==='planning').expectedGrant.revision--
 assert.equal((await consent(post({...decision,requestId:'00000000-0000-4000-8000-000000005155',choices:staleMixed}))).status,409)
 assert.deepEqual((await db.query('select to_jsonb(g) v from public.pjsdas_business_management_grants g where user_id=$1 order by capability',[owner])).rows,beforeMixed)
 assert.equal((await consent(post({...decision,requestId:'00000000-0000-4000-8000-000000005156',choices:allChoices}))).status,200)
 const allProofs=(await (await consent(read())).json()).clients[0].grants;assert.equal(allProofs.length,5)
 const allRevoke=allChoices.map(c=>({...c,decision:'revoke',expectedGrant:{id:allProofs.find(g=>g.domain===c.domain).id,revision:allProofs.find(g=>g.domain===c.domain).revision}}))
 assert.equal((await consent(post({...decision,requestId:'00000000-0000-4000-8000-000000005157',choices:allRevoke}))).status,200)
 assert.deepEqual((await db.query("select to_jsonb(g) v from public.pjsdas_business_management_grants g where user_id=$1 and capability='workspace.manage'",[owner])).rows[0].v,legacyV2)
 console.log('PASS five explicit scopes atomically approve/revoke; stale mixed batch rolls back earlier business change; legacy v2 untouched.')
 console.log('PASS fresh-account empty start -> atomic planning and consumer business consent -> real SQL read/write/undo for both -> atomic revoke -> denial. Legacy v2 grant cannot authorize consumer tools and remains byte-semantically unchanged.')
}finally{globalThis.fetch=network;await db.end()}

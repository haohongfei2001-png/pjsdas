// Exact existing guards with pending empty-run preimages; synthetic only.
import assert from 'node:assert/strict'
import {seed,checkpoint,raw,logical,uid,fullArgs} from './gmail-empty-checkpoint-fixture.mjs'
export async function proveGuards(db){
 const seedAdmin=async(n)=>{await db.query('reset role');const w=await seed(db,n);await db.query('set role service_role');return w}
 for(const [version,suffix,capability,operation]of [[2,'management','workspace.manage','business_management'],[3,'opportunity','workspace.opportunity.manage','opportunity_management'],[4,'planning','workspace.planning.manage','planning_management'],[5,'discovery_profile','workspace.discovery-profile.manage','discovery_profile_management'],[6,'private_reminder','workspace.reminders.manage','private_reminder_management'],[7,'consumer_business','workspace.business.manage','business_management']])for(const aware of [false,true]){
  const n=20000+version*10+Number(aware),w=await seedAdmin(n),base=await raw(db,w.user),client=uid(n+100000),grant=uid(n+200000)
  await db.query("insert into pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,$4,$5,$6)",[grant,w.user,client,capability,version,version===7?'22626aea373e4e8eb51a90ee4b548c5f3aeeee4bbe58e77b418a0645138edb34':'a'.repeat(64)])
  await checkpoint(db,w,0);const preimage=await logical(db,w.user),target=structuredClone(aware?preimage.snapshot:base.snapshot)
  let compensation=null
  if(version===7){const action={id:'managed:action:synthetic:0',kind:'manual',status:'todo',title:'Synthetic action',estimatedMinutes:30,leverage:0,delayCost:0,createdAt:target.exportedAt,updatedAt:target.exportedAt};target.data.actions.push(action);compensation={operation:'business_management_restore',payload:{changes:[{type:'action',id:action.id,before:null,after:action,beforeIndex:-1}]}}}
  const args=fullArgs(w,`guard-${version}-${aware}`,1,target);args[2]=operation;args[7]='delegated_mcp';args[8]=client;args[10]=compensation?JSON.stringify(compensation):null;args.push(grant,1)
  const query=`select * from pjsdas_commit_${suffix}_workspace_v1(${args.map((_,i)=>'$'+(i+1)).join(',')})`
  const forged=structuredClone(target);forged.data.timeline[0].title='tampered historical evidence'
  await assert.rejects(db.query(query,args.map((x,i)=>i===5?JSON.stringify(forged):x)),e=>['40001','42501'].includes(e.code))
  const result=(await db.query(query,args)).rows[0];assert.equal(result.outcome,'COMMITTED');assert.deepEqual(result.snapshot.data.timeline,preimage.snapshot.data.timeline);assert.deepEqual((await raw(db,w.user)).snapshot,result.snapshot)
  await db.query('update pjsdas_business_management_grants set revoked_at=now() where id=$1',[grant]);await assert.rejects(db.query(query,args),e=>e.code==='42501')
 }
 // Discovery checkpoint compares the entire logical snapshot, not only history.
 for(const aware of [false,true]){
  const w=await seedAdmin(21000+Number(aware)),base=await raw(db,w.user);await checkpoint(db,w,0)
  await db.query('update google_drive_connections set discovery_automation_enabled=true where user_id=$1',[w.user]);const binding=(await db.query('select google_subject,discovery_consent_generation from google_drive_connections where user_id=$1',[w.user])).rows[0]
  const proof={kind:'automation',userId:w.user,googleSubject:binding.google_subject,consentGeneration:binding.discovery_consent_generation}
  const batch={version:1,planFingerprint:'a'.repeat(64),cycleId:'b'.repeat(64),claimAttemptId:uid(700000+Number(aware)),index:0,count:1,queryStart:0,queryCount:1,totalQueryCount:1,phase:'claimed'}
  const provenance={sourceId:'fixture-discovery',scopeFingerprint:'c'.repeat(64),producer:'server_scheduler',runId:'fixture-run',searchPlanFingerprint:batch.planFingerprint,searchCycleId:batch.cycleId,searchBatchIndex:0,searchPhase:'claimed',searchBatch:batch}
  const view=await logical(db,w.user),args=fullArgs(w,'discovery-claim',1,aware?view.snapshot:base.snapshot);args[2]='checkpoint_discovery_search';args[7]='automation';args[9]=JSON.stringify(provenance);args.push(JSON.stringify(proof))
  const q=`select * from pjsdas_commit_discovery_workspace_v1(${args.map((_,i)=>'$'+(i+1)).join(',')})`;const result=(await db.query(q,args)).rows[0];assert.equal(result.outcome,'COMMITTED');assert.deepEqual(result.snapshot,view.snapshot)
 }
 console.log('PASS native guarded writers: management v2/v3/v4/v5/v6/v7, old raw and overlay-aware input, audit tamper/revocation denial, exact whole-snapshot Discovery checkpoint.')
}

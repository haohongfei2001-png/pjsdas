import { createLegacyManagementOracle } from './workspace-rows-legacy-oracle.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createSnapshot } from '../../src/snapshot.ts'
import { applyBusinessManagement, restoreBusinessManagement } from '../../src/businessManagement.ts'
import { encodeWorkspaceRows, diffWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
const at='2030-01-01T00:00:00.000Z',now=new Date(at),wire=x=>JSON.parse(JSON.stringify(x))
const equal=(a,b)=>assert(isDeepStrictEqual(a,wire(b)),'business complete wire equality')
export async function testBusinessRows({db,source,origin,token}) {
 const userId=randomUUID(),clientId=randomUUID(),grantId=randomUUID()
 const empty=createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[]},at)
 const initial=applyBusinessManagement(empty,{operations:[{kind:'create_application_group',value:{company:'Retained synthetic group'}},{kind:'create_manual_action',value:{title:'Retained synthetic action',estimatedMinutes:20}}]},'synthetic-business-seed',now).snapshot
 await db.query('insert into auth.users(id) values($1)',[userId])
 const workspaceId=(await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,initial])).rows[0].id
 const oracle=await createLegacyManagementOracle(db,userId,initial)
 const encoded=encodeWorkspaceRows(initial)
 await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5)',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),initial])
 await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(encoded.rows)])
 await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.business.manage',7,'22626aea373e4e8eb51a90ee4b548c5f3aeeee4bbe58e77b418a0645138edb34')",[grantId,userId,clientId])
 const legacy=async(before,after,command)=> (await oracle.query('select * from public.pjsdas_commit_consumer_business_workspace_v1($1,$2,$3,$4,$5,$6,4,$7,$8,$9,$10,null,$11,$12,$13)',[userId,command.commandId,command.operation??'business_management',command.payloadHash,before.revision,JSON.stringify(after),'delegated_mcp',command.clientId,JSON.stringify(command.undoOf?{undoOf:command.undoOf}:{}),JSON.stringify(command.compensation),'{}',command.grantId,command.grantRevision])).rows[0]
 const raw=async(before,after,command)=>fetch(origin+'/rpc/commit_business',{method:'POST',signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({req:{...diffWorkspaceRows(before.snapshot,after),workspaceId,userId,expectedEpoch:before.epoch,expectedRevision:before.revision,commandId:command.commandId,payloadHash:command.payloadHash,operation:command.operation??'business_management',principal:'delegated_mcp',provenance:command.undoOf?{undoOf:command.undoOf}:{},compensation:command.compensation},target_grant_id:command.grantId,target_grant_revision:command.grantRevision,target_client_id:command.clientId})})
 const before=await source.read(userId), core=applyBusinessManagement(before.snapshot,{operations:[{kind:'create_application_group',value:{company:'New synthetic group',notes:'Synthetic note'}},{kind:'create_manual_action',value:{title:'New synthetic action',estimatedMinutes:30}}]},'synthetic-business-create',now)
 const command={commandId:'synthetic-business-create',payloadHash:'c'.repeat(64),compensation:core.compensation,grantId,grantRevision:1,clientId}
 for(const patch of [{clientId:randomUUID()},{grantRevision:99}]) {
  await assert.rejects(legacy(before,core.snapshot,{...command,...patch}),e=>e.code==='42501')
  await assert.rejects(source.commitBusiness(before,core.snapshot,{...command,...patch}))
 }
 for(const variant of ['protected-header','audit-rewrite','unselected','reorder','empty-evidence','index','source-version']) {
  const after=structuredClone(core.snapshot),bad=structuredClone(command)
  if(variant==='protected-header') after.data.decisionRules={unauthorized:true}
  if(variant==='audit-rewrite') after.data.timeline[0].title='Spoofed'
  if(variant==='unselected') after.data.actions[0].title='Spoofed'
  if(variant==='reorder') after.data.applicationGroups.reverse()
  if(variant==='empty-evidence') bad.compensation.payload.changes=[]
  if(variant==='index') bad.compensation.payload.changes[0].beforeIndex=0
  if(variant==='source-version') after.version=3
  await assert.rejects(legacy(before,after,bad),e=>e.code==='42501')
  assert.equal((await raw(before,after,bad)).status,403)
 }
 // A version-7 label is insufficient without its exact frozen consent hash.
 await db.query("update public.pjsdas_business_management_grants set consent_text_hash=$2 where id=$1",[grantId,'f'.repeat(64)])
 let revision=Number((await db.query('select revision from public.pjsdas_business_management_grants where id=$1',[grantId])).rows[0].revision)
 await assert.rejects(legacy(before,core.snapshot,{...command,grantRevision:revision}),e=>e.code==='42501')
 assert.equal((await raw(before,core.snapshot,{...command,grantRevision:revision})).status,403)
 await db.query("update public.pjsdas_business_management_grants set consent_text_hash='22626aea373e4e8eb51a90ee4b548c5f3aeeee4bbe58e77b418a0645138edb34' where id=$1",[grantId])
 command.grantRevision=Number((await db.query('select revision from public.pjsdas_business_management_grants where id=$1',[grantId])).rows[0].revision)
 const old=await legacy(before,core.snapshot,command),saved=await source.commitBusiness(before,core.snapshot,command)
 assert.equal(saved.outcome,'COMMITTED');equal((await source.read(userId)).snapshot,old.snapshot);equal(saved.receipt.managementAuthorization,old.receipt.managementAuthorization)
 equal((await source.commitBusiness(before,core.snapshot,command)).receipt,saved.receipt)

 const v2Grant=randomUUID()
 await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.manage',2,$4)",[v2Grant,userId,clientId,'b'.repeat(64)])
 const legacyV2=async(before,after,command)=>(await oracle.query('select * from public.pjsdas_commit_management_workspace_v1($1,$2,$3,$4,$5,$6,4,$7,$8,$9,$10,null,$11,$12,$13)',[userId,command.commandId,command.operation??'business_management',command.payloadHash,before.revision,JSON.stringify(after),'delegated_mcp',command.clientId,JSON.stringify(command.undoOf?{undoOf:command.undoOf}:{}),JSON.stringify(command.compensation),'{}',command.grantId,command.grantRevision])).rows[0]
 const v2Authority={...command,grantId:v2Grant,grantRevision:1}
 await assert.rejects(legacyV2(before,core.snapshot,v2Authority),e=>e.code==='23505')
 await assert.rejects(source.commitLegacyManagement(before,core.snapshot,v2Authority))
 const v2Before=await source.read(userId), v2Core=applyBusinessManagement(v2Before.snapshot,{operations:[{kind:'create_manual_action',value:{title:'Synthetic v2 task',estimatedMinutes:10}}]},'synthetic-v2-command',now)
 const v2Command={...v2Authority,commandId:'synthetic-v2-command',payloadHash:'a'.repeat(64),compensation:v2Core.compensation}
 const oldV2=await legacyV2(v2Before,v2Core.snapshot,v2Command), newV2=await source.commitLegacyManagement(v2Before,v2Core.snapshot,v2Command)
 equal((await source.read(userId)).snapshot,oldV2.snapshot);equal(newV2.receipt.managementAuthorization,oldV2.receipt.managementAuthorization)
 equal((await source.commitLegacyManagement(v2Before,v2Core.snapshot,v2Command)).receipt,newV2.receipt)
 const v2UndoBefore=await source.read(userId),v2Restored=restoreBusinessManagement(v2UndoBefore.snapshot,v2Core.compensation,now)
 const v2Undo={...v2Command,commandId:'synthetic-v2-undo',operation:'undo_command',undoOf:v2Command.commandId,compensation:{}}
 await assert.rejects(source.commitBusiness(v2UndoBefore,v2Restored,{...v2Undo,grantId,grantRevision:command.grantRevision}))
 await assert.rejects(legacy(v2UndoBefore,v2Restored,{...v2Undo,grantId,grantRevision:command.grantRevision}),e=>e.code==='42501')
 await assert.rejects(source.commitLegacyManagement(v2UndoBefore,v2Restored,{...v2Undo,undoOf:command.commandId}))
 await assert.rejects(legacyV2(v2UndoBefore,v2Restored,{...v2Undo,undoOf:command.commandId}),e=>e.code==='42501')
 const oldV2Undo=await legacyV2(v2UndoBefore,v2Restored,v2Undo);await source.commitLegacyManagement(v2UndoBefore,v2Restored,v2Undo);equal((await source.read(userId)).snapshot,oldV2Undo.snapshot)
 await db.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1',[v2Grant])
 await assert.rejects(source.commitLegacyManagement(v2Before,v2Core.snapshot,v2Command));await assert.rejects(legacyV2(v2Before,v2Core.snapshot,v2Command),e=>e.code==='42501')
 console.log('PASS retained management v2 actual commit/Undo/replay authority and strict separation from v7 receipts; no grant promotion')
 const editBefore=await source.read(userId), edited=applyBusinessManagement(editBefore.snapshot,{operations:[{kind:'update_application_group',id:core.snapshot.data.applicationGroups[1].id,patch:{notes:null,company:'Updated synthetic group'}},{kind:'archive_manual_action',id:core.snapshot.data.actions[1].id}]},'synthetic-business-edit',now)
 const editCommand={...command,commandId:'synthetic-business-edit',payloadHash:'d'.repeat(64),compensation:edited.compensation}
 const oldEdit=await legacy(editBefore,edited.snapshot,editCommand);await source.commitBusiness(editBefore,edited.snapshot,editCommand);equal((await source.read(userId)).snapshot,oldEdit.snapshot)
 const undoBefore=await source.read(userId),restored=restoreBusinessManagement(undoBefore.snapshot,edited.compensation,now)
 const undo={...command,commandId:'synthetic-business-undo',payloadHash:'e'.repeat(64),operation:'undo_command',undoOf:editCommand.commandId,compensation:{}}
 await assert.rejects(source.commitBusiness(undoBefore,restored,{...undo,undoOf:'foreign-or-absent'}))
 const oldUndo=await legacy(undoBefore,restored,undo);await source.commitBusiness(undoBefore,restored,undo);equal((await source.read(userId)).snapshot,oldUndo.snapshot)
 // Retired preparation/scoring creation stays rejected by the real domain core;
 // retained historic compensation is not erased or reinterpreted as new work.
 assert.throws(()=>applyBusinessManagement(initial,{operations:[{kind:'create_prep',value:{title:'Retired',estimatedMinutes:30}}]},'synthetic-retired-prep',now))
 await db.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1',[grantId])
 await assert.rejects(legacy(before,core.snapshot,command),e=>e.code==='42501');await assert.rejects(source.commitBusiness(before,core.snapshot,command))
 console.log('PASS v7 business actual create/update/archive/Undo core and legacy differential: exact consent hash, bounded evidence/preimages/order, protected data/audit/version and revoked replay; retired creation remains disabled')
}

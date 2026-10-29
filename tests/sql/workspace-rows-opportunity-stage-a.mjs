import { createLegacyManagementOracle } from './workspace-rows-legacy-oracle.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { upgradeSnapshotToLatest } from '../../src/snapshot.ts'
import { applyOpportunityManagement, readOpportunityManagement, restoreOpportunityManagement } from '../../src/opportunityManagement.ts'
import { encodeWorkspaceRows, diffWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
const at='2030-01-01T00:00:00.000Z', now=new Date(at)
const wire=x=>JSON.parse(JSON.stringify(x)), equal=(a,b)=>assert(isDeepStrictEqual(a,wire(b)),'opportunity full wire equality')
function opportunityFixture() {
  const opportunity = { id: 'opp-a', company: 'Synthetic Company', role: 'Engineer', currentStageLabel: '面试', processStage: 'interview', roleType: 'core', early: false, opportunityValue: 72, fitScore: 81, importedAt: at, detail: { backgroundTag: 'Original', userFacts: { provenance: 'user_asserted', updatedAt: at, deadline: '2026-12-01', deadlinePrecision: 'date', location: 'Remote' } } }
  return upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 4, exportedAt: at, data: {
    opportunities: [opportunity, { ...opportunity, id: 'opp-b', company: 'Unrelated' }],
    processes: [{ id: 'process-a', opportunityId: opportunity.id, company: opportunity.company, role: opportunity.role, stage: 'interview', stageLabel: 'Custom application label', notes: 'User application record', lastProgressAt: at }],
    processEvents: [{ id: 'event-a', opportunityId: opportunity.id, company: opportunity.company, role: opportunity.role, type: 'interview_invite', occurredAt: at, dueAt: '2026-11-01T10:00:00Z', timingMode: 'fixed', source: 'email', createdAt: at, updatedAt: at, notes: 'Immutable original invitation' }],
    actions: [{ id: 'event-action:event-a', opportunityId: opportunity.id, processEventId: 'event-a', kind: 'manual', title: 'Interview', dueAt: '2026-11-01T10:00:00Z', timingMode: 'fixed', estimatedMinutes: 60, leverage: 90, delayCost: 80, status: 'done', createdAt: at, updatedAt: at }],
    prep: [], applicationGroups: [], scheduleNodes: [], timeline: [{ id: 'history-a', kind: 'application_submitted', category: 'process', source: 'user_action', occurredAt: at, recordedAt: at, title: 'Application submitted', opportunityId: opportunity.id }], semanticReceipts: [], decisionRequests: [], reminderIntents: [], reminderOutbox: [],
  } })
}
export async function testOpportunityRows({db,source,origin,token}) {
 const userId=randomUUID(),clientId=randomUUID(),grantId=randomUUID(),initial=opportunityFixture()
 await db.query('insert into auth.users(id) values($1)',[userId])
 const workspaceId=(await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,initial])).rows[0].id
 const oracle=await createLegacyManagementOracle(db,userId,initial)
 const encoded=encodeWorkspaceRows(initial)
 await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5)',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),initial])
 await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(encoded.rows)])
 await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.opportunity.manage',3,$4)",[grantId,userId,clientId,'c'.repeat(64)])
 const legacy=async(before,after,command)=> (await oracle.query('select * from public.pjsdas_commit_opportunity_workspace_v1($1,$2,$3,$4,$5,$6,4,$7,$8,$9,$10,null,$11,$12,$13)',[userId,command.commandId,command.operation??'opportunity_management',command.payloadHash,before.revision,JSON.stringify(after),'delegated_mcp',command.clientId,JSON.stringify(command.undoOf?{undoOf:command.undoOf}:{}),JSON.stringify(command.compensation),'{}',command.grantId,command.grantRevision])).rows[0]
 const raw=async(before,after,command)=>fetch(origin+'/rpc/commit_opportunity',{method:'POST',signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({req:{...diffWorkspaceRows(before.snapshot,after),workspaceId,userId,expectedEpoch:before.epoch,expectedRevision:before.revision,commandId:command.commandId,payloadHash:command.payloadHash,operation:command.operation??'opportunity_management',principal:'delegated_mcp',provenance:command.undoOf?{undoOf:command.undoOf}:{},compensation:command.compensation},target_grant_id:command.grantId,target_grant_revision:command.grantRevision,target_client_id:command.clientId})})
 const before=await source.read(userId), reviewed=await readOpportunityManagement(before.snapshot,'opp-a')
 const updated=await applyOpportunityManagement(before.snapshot,{operations:[{kind:'update_opportunity_profile',id:'opp-a',expectedFingerprint:reviewed.profileFingerprint,patch:{early:true,userFacts:{location:'Synthetic remote'}}}]},'synthetic-opportunity-update',now)
 const command={commandId:'synthetic-opportunity-update',payloadHash:'c'.repeat(64),compensation:updated.compensation,grantId,grantRevision:1,clientId}
 for(const patch of [{clientId:randomUUID()},{grantRevision:99}]) {
  await assert.rejects(legacy(before,updated.snapshot,{...command,...patch}),e=>e.code==='42501')
  await assert.rejects(source.commitOpportunity(before,updated.snapshot,{...command,...patch}))
 }
 for(const variant of ['source-fact','unselected-row','audit-rewrite','order','protected-header','unrelated-row','missing-array']) {
  const after=structuredClone(updated.snapshot)
  if(variant==='source-fact') after.data.opportunities[0].company='Spoofed'
  if(variant==='unselected-row') after.data.opportunities[1].early=true
  if(variant==='audit-rewrite') after.data.timeline[0].title='Spoofed'
  if(variant==='order') after.data.opportunities.reverse()
  if(variant==='protected-header') after.data.decisionRules={unauthorized:true}
  if(variant==='unrelated-row') after.data.semanticReceipts.push({id:'untrusted'})
  if(variant==='missing-array') delete after.data.processes
  await assert.rejects(legacy(before,after,command),e=>e.code==='42501')
  assert.equal((await raw(before,after,{...command,commandId:'denied-'+variant})).status,403)
 }
 const old=await legacy(before,updated.snapshot,command), saved=await source.commitOpportunity(before,updated.snapshot,command)
 assert.equal(saved.outcome,'COMMITTED');equal((await source.read(userId)).snapshot,old.snapshot);equal(saved.receipt.managementAuthorization,old.receipt.managementAuthorization)
 equal((await source.commitOpportunity(before,updated.snapshot,command)).receipt,saved.receipt)
 const archiveBefore=await source.read(userId), archiveRead=await readOpportunityManagement(archiveBefore.snapshot,'opp-a')
 const archived=await applyOpportunityManagement(archiveBefore.snapshot,{operations:[{kind:'archive_opportunity',id:'opp-a',expectedFingerprint:archiveRead.archive.fingerprint,dependencies:archiveRead.archive.dependencies,reason:'Synthetic explicit archive'}]},'synthetic-opportunity-archive',now)
 const archiveCommand={...command,commandId:'synthetic-opportunity-archive',payloadHash:'d'.repeat(64),compensation:archived.compensation}
 assert(archived.compensation.payload.changes.length>=4)
 // Dropping or retaining only part of the reviewed dependency closure must fail.
 for(const variant of ['retain-event','drop-evidence']) {
  const after=structuredClone(archived.snapshot), bad=structuredClone(archiveCommand)
  if(variant==='retain-event') after.data.processEvents=archiveBefore.snapshot.data.processEvents
  else bad.compensation.payload.changes=bad.compensation.payload.changes.filter(c=>c.type!=='action')
  await assert.rejects(legacy(archiveBefore,after,bad),e=>e.code==='42501')
  assert.equal((await raw(archiveBefore,after,bad)).status,403)
 }
 const oldArchive=await legacy(archiveBefore,archived.snapshot,archiveCommand), newArchive=await source.commitOpportunity(archiveBefore,archived.snapshot,archiveCommand)
 assert.equal(newArchive.outcome,'COMMITTED');equal((await source.read(userId)).snapshot,oldArchive.snapshot)
 const undoBefore=await source.read(userId), restored=restoreOpportunityManagement(undoBefore.snapshot,archived.compensation,now)
 const undo={...command,commandId:'synthetic-opportunity-undo',payloadHash:'e'.repeat(64),operation:'undo_command',undoOf:archiveCommand.commandId,compensation:{}}
 await assert.rejects(source.commitOpportunity(undoBefore,restored,{...undo,undoOf:'absent'}))

 // A shadow history entry of another family must not be silently bypassed by
 // finding a same-ID opportunity entry in the retained legacy ledger.
 const shadow='synthetic-shadow-history'
 await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,principal_kind,status,resulting_revision,compensation) values($1,$2,$3,'opportunity_management',$4,'delegated_mcp','COMMITTED',2,$5)",[workspaceId,userId,shadow,'a'.repeat(64),archived.compensation])
 await db.query("insert into pjsdas_rows_candidate.ledger values($1,$2,$3,$4,99,$5,$6,'synthetic-fixture')",[workspaceId,userId,shadow,'a'.repeat(64),{operation:'planning_management',status:'COMMITTED'},archived.compensation])
 assert.equal((await raw(undoBefore,restored,{...undo,commandId:'shadow-denied',undoOf:shadow})).status,403)
 equal((await source.read(userId)).snapshot,undoBefore.snapshot)
 const oldUndo=await legacy(undoBefore,restored,undo), newUndo=await source.commitOpportunity(undoBefore,restored,undo)
 assert.equal(newUndo.outcome,'COMMITTED');equal((await source.read(userId)).snapshot,oldUndo.snapshot)
 equal((await source.commitOpportunity(undoBefore,restored,undo)).receipt,newUndo.receipt)

 // Re-archive through both real paths, then model a separately committed later
 // dependency. Undo must not adopt it merely because its rows are retained.
 const againBefore=await source.read(userId), againRead=await readOpportunityManagement(againBefore.snapshot,'opp-a')
 const again=await applyOpportunityManagement(againBefore.snapshot,{operations:[{kind:'archive_opportunity',id:'opp-a',expectedFingerprint:againRead.archive.fingerprint,dependencies:againRead.archive.dependencies,reason:'Synthetic second archive'}]},'synthetic-second-archive',now)
 const againCommand={...archiveCommand,commandId:'synthetic-second-archive',payloadHash:'f'.repeat(64),compensation:again.compensation}
 await legacy(againBefore,again.snapshot,againCommand);await source.commitOpportunity(againBefore,again.snapshot,againCommand)
 const arrived={...initial.data.processes[0],id:'synthetic-later-process'}
 const withDependency=structuredClone(again.snapshot);withDependency.data.processes.push(arrived)
 await db.query('begin')
 await db.query("insert into pjsdas_rows_candidate.item values($1,$2,'processes',$3,0,$4,$5)",[workspaceId,userId,arrived.id,arrived,againBefore.revision+2])
 const dependencyEncoded=encodeWorkspaceRows(withDependency)
 await db.query('update pjsdas_rows_candidate.head set revision=revision+1,manifest=$2 where id=$1',[workspaceId,JSON.stringify(dependencyEncoded.manifest)])
 await db.query('update public.pjsdas_workspaces set snapshot=$2,revision=revision+1,materialized_revision=revision+1 where id=$1',[workspaceId,withDependency])
 await oracle.setSnapshot(withDependency,true)
 await db.query('commit')
 // This deliberately adversarial orphan is not a valid adapter snapshot. Do not
 // weaken its validator to read it: exercise the DB guard directly, and compare
 // raw model rows/head to prove rejection has no effect.
 const lateBefore={...againBefore,revision:againBefore.revision+2,snapshot:withDependency}, proposed=structuredClone(restored);proposed.data.processes.push(arrived);proposed.data.timeline=lateBefore.snapshot.data.timeline
 const physicalBefore=(await db.query('select row_to_json(h) head,(select jsonb_agg(i order by collection,ordinal) from pjsdas_rows_candidate.item i where i.workspace_id=h.id) items from pjsdas_rows_candidate.head h where id=$1',[workspaceId])).rows[0]
 const lateUndo={...undo,commandId:'synthetic-late-dependency-undo',undoOf:againCommand.commandId}
 await assert.rejects(legacy(lateBefore,proposed,lateUndo),e=>e.code==='42501')
 assert.equal((await raw(lateBefore,proposed,lateUndo)).status,403)
 equal((await db.query('select row_to_json(h) head,(select jsonb_agg(i order by collection,ordinal) from pjsdas_rows_candidate.item i where i.workspace_id=h.id) items from pjsdas_rows_candidate.head h where id=$1',[workspaceId])).rows[0],physicalBefore)
 console.log('PASS opportunity undo rejects ambiguous split-ledger identity and newly arrived dependency without partial mutation')
 await db.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1',[grantId])
 await assert.rejects(legacy(undoBefore,restored,undo),e=>e.code==='42501');await assert.rejects(source.commitOpportunity(undoBefore,restored,undo))
 console.log('PASS opportunity actual core profile/archive/Undo and legacy differential: exact closure, retained order/source facts/audit, grant and revoked replay; layout integration remains open')
}

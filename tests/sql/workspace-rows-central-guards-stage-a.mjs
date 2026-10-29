import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createSnapshot } from '../../src/snapshot.ts'
import { encodeWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
import { createWorkspaceRowsStoreBridge } from '../../gateway/workspaceRowsStoreBridge.ts'
import { createTransactionalWorkspaceStore } from '../../gateway/transactionalWorkspaceStore.ts'
import { createAuthoritativeCommandExecutor } from '../../gateway/authoritativeCommands.ts'
import { createScopedManagementGrantReader } from '../../gateway/scopedManagementGrantStore.ts'
import { createBusinessManagementGrantReader } from '../../gateway/businessManagementGrantStore.ts'
import { SCOPED_MANAGEMENT_CONSENTS,scopedManagementConsentHash } from '../../gateway/scopedManagementConsent.ts'
import { getPlanningManagementRead,planningManagementFingerprint } from '../../src/planningManagement.ts'
import { getDiscoveryProfileManagementRead,discoveryProfileManagementFingerprint } from '../../src/discoveryProfileManagement.ts'
import { privateReminderManagementFingerprint } from '../../src/privateReminderManagement.ts'
import { readOpportunityManagement,opportunityManagementFingerprint } from '../../src/opportunityManagement.ts'

export async function testActivatedCentralGuards({db,origin,token,rpcTransport}) {
 const userId=randomUUID(),clientId=randomUUID(),at='2030-01-01T00:00:00.000Z'
 const node={id:'synthetic-central-node',occurrenceId:'synthetic-central-occurrence',version:1,kind:'interview',state:'scheduled',temporal:{shape:'fixed_range',precision:'datetime',timezone:'UTC',startAt:'2030-01-02T02:00:00Z',endAt:'2030-01-02T03:00:00Z',resolutionBasis:'user_explicit'},constraintKind:'user_plan',evidenceRefs:[],sourceVersionRefs:[],relatedActionIds:[],relatedPrepIds:[],createdAt:at,updatedAt:at}
 const initial=createSnapshot({opportunities:[{id:'synthetic-central-opp',company:'Synthetic company',role:'Synthetic role',currentStageLabel:'筛选中',processStage:'screening',roleType:'core',early:false,opportunityValue:80,fitScore:80,locallyManaged:true,importedAt:at}],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],scheduleNodes:[node],timeline:[]},at)
 await db.query('insert into auth.users(id) values($1)',[userId])
 const workspaceId=(await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,initial])).rows[0].id
 const encoded=encodeWorkspaceRows(initial),epoch=(await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) returning epoch',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),initial])).rows[0].epoch
 await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(encoded.rows)])
 await db.query('update public.pjsdas_workspaces set row_candidate_epoch=$2 where user_id=$1',[userId,epoch])
 const calls=[]
 const publicFetch=(url,init={})=>{const headers=new Headers(init.headers);headers.set('accept-profile','public');headers.set('content-profile','public');return fetch(String(url).replace('/rest/v1/','/'),{...init,headers})}
 const bridge=createWorkspaceRowsStoreBridge({supabaseUrl:origin,serviceRoleKey:token,readsEnabled:true,writesEnabled:true,rpcTransport,fetchImpl:(url,init)=>{calls.push(String(url));return fetch(String(url).replace('/rest/v1/','/'),init)}})
 const config={supabaseUrl:origin,serviceRoleKey:token,fetchImpl:publicFetch,...bridge,emptyGmailCheckpointReads:true,emptyGmailCheckpoints:true}
 const store=createTransactionalWorkspaceStore(config),principal={kind:'delegated_mcp',userId,clientId}
 const cases=[
  {domain:'legacy',version:2,capability:'workspace.manage',resolver:'resolveBusinessManagementGrant',rpc:'commit_management_v2',command:async()=>({type:'business_management',value:{operations:[{kind:'create_manual_action',value:{title:'Synthetic legacy task',estimatedMinutes:20}}]}})},
  {domain:'business',resolver:'resolveConsumerBusinessManagementGrant',rpc:'commit_business',command:async()=>({type:'business_management',value:{operations:[{kind:'create_application_group',value:{company:'Synthetic central group'}}]}})},
  {domain:'opportunity',resolver:'resolveOpportunityManagementGrant',rpc:'commit_opportunity',fingerprint:opportunityManagementFingerprint,command:async snapshot=>({type:'opportunity_management',value:{operations:[{kind:'update_opportunity_profile',id:'synthetic-central-opp',expectedFingerprint:(await readOpportunityManagement(snapshot,'synthetic-central-opp')).profileFingerprint,patch:{early:true}}]}})},
  {domain:'planning',resolver:'resolvePlanningManagementGrant',rpc:'commit_planning',fingerprint:planningManagementFingerprint,command:async snapshot=>({type:'planning_management',value:{operations:[{kind:'patch_time_preferences',expectedFingerprint:(await getPlanningManagementRead(snapshot)).timePreferences.fingerprint,patch:{defaultDailyMinutes:60}}]}})},
  {domain:'discoveryProfile',resolver:'resolveDiscoveryProfileManagementGrant',rpc:'commit_discovery_profile',fingerprint:discoveryProfileManagementFingerprint,command:async snapshot=>({type:'discovery_profile_management',value:{kind:'patch_discovery_profile',expectedFingerprint:(await getDiscoveryProfileManagementRead(snapshot)).fingerprint,patch:{targetRoleQueries:['Synthetic role']}}})},
  {domain:'privateReminder',resolver:'resolvePrivateReminderManagementGrant',rpc:'commit_private_reminder',fingerprint:privateReminderManagementFingerprint,command:async()=>({type:'private_reminder_management',value:{operations:[{kind:'create_private_reminder',scheduleNodeId:node.id,expectedNodeFingerprint:await privateReminderManagementFingerprint(node),purpose:'upcoming',triggerAt:'2030-01-02T01:00:00Z'}]}})},
 ]
 let revision=0
 for(const item of cases) {
  const descriptor=item.domain==='legacy'?item:SCOPED_MANAGEMENT_CONSENTS[item.domain],grantId=randomUUID()
  await db.query('insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,$4,$5,$6)',[grantId,userId,clientId,descriptor.capability,descriptor.version,item.domain==='legacy'?'b'.repeat(64):await scopedManagementConsentHash(item.domain)])
  const executor=createAuthoritativeCommandExecutor({...config,now:()=>new Date(at),[item.resolver]:item.domain==='legacy'?createBusinessManagementGrantReader(config):createScopedManagementGrantReader(item.domain,config)})
  const before=await store.readForUser(userId),command={commandId:'synthetic-central-'+item.domain,baseRevision:revision,command:await item.command(before.snapshot)}
  const saved=await executor.execute(principal,command)
  assert.equal(saved.outcome,'COMMITTED',item.domain);assert.equal(saved.revision,++revision);assert.equal(saved.receipt.managementAuthorization.consentVersion,descriptor.version)
  assert(calls.some(url=>url.endsWith((rpcTransport==='public-v1'?'/pjsdas_rows_v1_':'/')+item.rpc)),item.domain+' real dedicated dispatch')
  assert.equal((await executor.execute(principal,command)).outcome,'ALREADY_APPLIED')
  const compensation=(await store.readCommandForUser(userId,command.commandId)).compensation
  const undo={commandId:command.commandId+'-undo',targetCommandId:command.commandId,...(item.fingerprint?{expectedCompensationFingerprint:await item.fingerprint(compensation)}:{})}
  const restored=await executor.undo(principal,undo);assert.equal(restored.outcome,'COMMITTED',item.domain+' Undo');assert.equal(restored.revision,++revision)
  assert.equal((await executor.undo(principal,undo)).outcome,'ALREADY_APPLIED')
  await db.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1',[grantId])
  await assert.rejects(executor.execute(principal,command),e=>e.code==='AUTH_FORBIDDEN')
  await assert.rejects(executor.undo(principal,undo),e=>e.code==='AUTH_FORBIDDEN')
 }
 assert.equal(Number((await store.readIdentityForUser(userId)).revision),12)
 assert.equal((await db.query('select revision from public.pjsdas_workspaces where user_id=$1',[userId])).rows[0].revision,'0')
 assert.equal((await db.query('select count(*)::int n from public.pjsdas_command_ledger where user_id=$1',[userId])).rows[0].n,0)
 console.log('PASS all six activated central management executors: original grant HTTP readers, dedicated row guards, current-state replay, exact Undo, revoked replay/Undo denial, no retained blob/ledger write')
}

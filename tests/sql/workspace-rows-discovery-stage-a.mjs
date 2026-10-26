import assert from 'node:assert/strict'
import pg from 'pg'
import { randomUUID,createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createSnapshot } from '../../src/snapshot.ts'
import { createDefaultDiscoveryProfile } from '../../src/discoveryProfile.ts'
import { discoveryProfileManagementFingerprint } from '../../src/discoveryProfileManagement.ts'
import { verifyDiscoverySourceObservation } from '../../gateway/discoverySourceVerifier.ts'
import { applyVerifiedDiscoveryCommand } from '../../src/verifiedDiscoveryCommand.ts'
import { encodeWorkspaceRows, diffWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
const at='2030-01-01T00:00:00.000Z',now=new Date(at),wire=x=>JSON.parse(JSON.stringify(x)),equal=(a,b)=>assert(isDeepStrictEqual(a,wire(b)),'Discovery complete wire equality')
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
export async function testDiscoveryRows({db,source,connectionString,activate=false}) {
 const userId=randomUUID(),clientId='synthetic-discovery-client',sourceId='monitor:scope-proof'
 const profile={...createDefaultDiscoveryProfile(at),searchScopeVersion:1,targetRoleQueries:['产品经理'],mustNotHave:['劳务派遣']}
 const scopeFingerprint=await discoveryProfileManagementFingerprint(profile)
 const initial=createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[],discoveryProfile:profile},at)
 await db.query('insert into auth.users(id) values($1)',[userId])
 const workspaceId=(await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,initial])).rows[0].id
 await db.query("insert into public.google_drive_connections(user_id,google_subject,refresh_token_ciphertext,granted_scopes,discovery_automation_enabled) values($1,'synthetic-subject','synthetic-unused','{}',true)",[userId])
 const generation=(await db.query('select discovery_consent_generation from public.google_drive_connections where user_id=$1',[userId])).rows[0].discovery_consent_generation
 const authorization={kind:'automation',userId,googleSubject:'synthetic-subject',consentGeneration:generation}
 const amount=432031,policy={version:1,application:'todayaction',approvalId:'synthetic-retained-budget',accountId:userId,scopeFingerprint,currency:'USD',maximumMicroUsd:amount*2,validFrom:new Date(Date.now()-3600000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),tariffVersion:'todayaction-standard-search-text-2026-10-08'}
 const claim=n=>{
  const batch={version:1,planFingerprint:digest('plan-'+n),cycleId:digest('cycle-'+n),claimAttemptId:randomUUID(),index:0,count:1,queryStart:0,queryCount:1,totalQueryCount:1,phase:'claimed'}
  const hold={version:1,policy,policyFingerprint:digest(policy),sourceId,claimAttemptId:batch.claimAttemptId,searchRequestLimit:1,modelRequestLimit:1,reservedMicroUsd:amount}
  return {commandId:'synthetic-discovery-claim-'+n,payloadHash:digest('claim-'+n),operation:'checkpoint_discovery_search',principal:'automation',compensation:null,authorization,provenance:{sourceId,scopeFingerprint,producer:'server_scheduler',searchPlanFingerprint:batch.planFingerprint,searchCycleId:batch.cycleId,searchBatchIndex:0,searchPhase:'claimed',searchBatch:batch,discoveryBudgetHold:hold}}
 }
 const settle=(c,outcome='complete')=>{const x=structuredClone(c);x.commandId+='-settled';x.payloadHash=digest(x.commandId);delete x.provenance.discoveryBudgetHold;x.provenance.searchPhase='settled';x.provenance.searchBatch={...x.provenance.searchBatch,phase:'settled',outcome};return x}
 const legacy=async(command,revision,snapshot=initial)=> (await db.query('select * from public.pjsdas_commit_discovery_workspace_v1($1,$2,$3,$4,$5,$6,4,$7,$8,$9,$10,null,$11,$12)',[userId,command.commandId,command.operation,command.payloadHash,revision,JSON.stringify(snapshot),command.principal,command.clientId??null,command.provenance,command.compensation,command.receiptContext??{},command.authorization])).rows[0]
 // Retained real original ledger holds count toward the same cap after seeding
 // the row layout. The candidate must neither reset nor double-count them.
 const retained=claim(0),old=await legacy(retained,0);assert.equal(old.receipt.discoveryBudget.admitted,true)
 await legacy(settle(retained),1)
 const encoded=encodeWorkspaceRows(initial)
 await db.query('insert into pjsdas_rows_candidate.head(id,user_id,revision,envelope,manifest,legacy_snapshot) values($1,$2,2,$3,$4,$5)',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),initial])
 await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,2 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(encoded.rows)])
 // An exact retained-row copy must be de-duplicated, not charged twice.
 await db.query("insert into pjsdas_rows_candidate.ledger(workspace_id,user_id,command_id,payload_hash,resulting_revision,receipt,compensation,effect_digest,principal_kind,client_id,provenance,expected_revision,effective_time) select workspace_id,user_id,command_id,payload_hash,resulting_revision,receipt,coalesce(compensation,'null'::jsonb),'synthetic-import',principal_kind,client_id,provenance,expected_revision,effective_time from public.pjsdas_command_ledger where user_id=$1 and command_id=$2",[userId,retained.commandId])
 if(activate) await db.query('update public.pjsdas_workspaces w set row_candidate_epoch=h.epoch from pjsdas_rows_candidate.head h where w.id=h.id and w.user_id=$1',[userId])
 const before=await source.read(userId),nextClaim=claim(1)
 const malicious=structuredClone(initial);malicious.exportedAt='2031-01-01T00:00:00.000Z'
 await assert.rejects(source.commitDiscovery(before,malicious,nextClaim))
 const admitted=await source.commitDiscovery(before,initial,nextClaim);assert.equal(admitted.receipt.discoveryBudget.admitted,true)
 equal((await source.commitDiscovery(before,initial,nextClaim)).receipt,admitted.receipt)
 equal((await source.read(userId)).snapshot,initial)
 await assert.rejects(source.commitDiscovery(await source.read(userId),initial,{...nextClaim,commandId:'synthetic-second-original-claim'}))
 const missing=settle(claim(99));await assert.rejects(source.commitDiscovery(await source.read(userId),initial,missing))
 // Real verifier and domain core, with only an injected in-memory HTML response.
 const sourceUrl='https://source-tenant.zhiye.com/social/detail?jobAdId=b7a408f6-9a55-4e08-9f8d-160cfff60e20'
 const posting={'@context':'https://schema.org','@type':'JobPosting',url:sourceUrl,title:'产品经理',hiringOrganization:{'@type':'Organization',name:'独立来源公司'},description:'负责产品规划与需求分析。'}
 let localFetches=0
 const observation=await verifyDiscoverySourceObservation({sourceRecordId:'synthetic-candidate',company:'独立来源公司',role:'产品经理',sourceUrl,sourceTitle:'产品经理'},{now,profile,fetchImpl:async()=>{localFetches++;return new Response(`<html><script type="application/ld+json">${JSON.stringify(posting)}</script><main><article><h1>产品经理</h1><dl><dt>公司名称</dt><dd>独立来源公司</dd></dl><section>负责产品规划与需求分析。</section></article></main></html>`,{headers:{'content-type':'text/html'}})}})
 assert.equal(localFetches,1);assert.equal(observation.sourceVerification,'verified')
 const factsBefore=await source.read(userId),factsCommand={kind:'ingest_verified_discovery',commandId:'synthetic-row-discovery-facts',inputFingerprint:'a'.repeat(64),scopeFingerprint,run:{runId:'synthetic-facts-run',sourceId,producer:'mcp_trusted_ingestion',startedAt:at,completedAt:at,observations:[observation]}}
 const core=applyVerifiedDiscoveryCommand(factsBefore.snapshot,factsCommand,now);assert.equal(core.ingestion.run.outcomes.created,1)
 const settlement={...settle(nextClaim),commandId:factsCommand.commandId,payloadHash:'a'.repeat(64),operation:'ingest_verified_discovery'}
 const facts=await source.commitDiscovery(factsBefore,core.snapshot,settlement);assert.equal(facts.outcome,'COMMITTED');equal((await source.read(userId)).snapshot,core.snapshot)
 assert.equal(facts.receipt.discoveryBudget.retainedMicroUsd,amount)
 // Cap exhausted across one retained and one new hold: a forged receipt context
 // cannot convert the third rejection into admitted spending or successful facts.
 const deniedClaim=claim(2);deniedClaim.receiptContext={discoveryBudget:{admitted:true,retainedMicroUsd:0}}
 const deniedBefore=await source.read(userId),declined=await source.commitDiscovery(deniedBefore,deniedBefore.snapshot,deniedClaim)
 assert.equal(declined.receipt.discoveryBudget.admitted,false);assert.equal(declined.receipt.discoveryBudget.retainedMicroUsd,0)
 equal((await source.commitDiscovery(deniedBefore,deniedBefore.snapshot,deniedClaim)).receipt,declined.receipt)
 await assert.rejects(source.commitDiscovery(await source.read(userId),core.snapshot,{...settle(deniedClaim),operation:'ingest_verified_discovery'}))
 await source.commitDiscovery(await source.read(userId),core.snapshot,settle(deniedClaim,'budget_exhausted'))
 const changed=claim(3);changed.provenance.discoveryBudgetHold.policy={...policy,maximumMicroUsd:amount*10}
 await assert.rejects(source.commitDiscovery(await source.read(userId),core.snapshot,changed))
 const skipped=claim(4);skipped.provenance.searchBatch.index=2;skipped.provenance.searchBatchIndex=2
 await assert.rejects(source.commitDiscovery(await source.read(userId),core.snapshot,skipped))
 // Two actual service-role DB sessions compete for a one-batch remaining cap.
 // The original shared workspace lock serializes history admission; stale CAS
 // loses without a hold, and an explicit fresh retry records a declined hold.
 const raceBefore=await source.read(userId),raceCommands=[claim(10),claim(11)].map(c=>{
  c.provenance.discoveryBudgetHold.policy={...policy,approvalId:'synthetic-concurrent-cap',maximumMicroUsd:amount}
  c.provenance.discoveryBudgetHold.policyFingerprint=digest(c.provenance.discoveryBudgetHold.policy);return c
 })
 const clients=[new pg.Client({connectionString}),new pg.Client({connectionString})];await Promise.all(clients.map(c=>c.connect()));await Promise.all(clients.map(c=>c.query('set role service_role')))
 try {
  await db.query('begin');await db.query('select id from public.pjsdas_workspaces where id=$1 for update',[workspaceId])
  const pending=clients.map((client,i)=>client.query('select pjsdas_rows_candidate.commit_discovery($1,$2) value',[{...diffWorkspaceRows(raceBefore.snapshot,raceBefore.snapshot),...raceCommands[i],workspaceId,userId,expectedEpoch:raceBefore.epoch,expectedRevision:raceBefore.revision,schemaVersion:4},authorization]).then(r=>({result:r.rows[0].value}),error=>({error})))
  const until=Date.now()+5000;for(;;){await db.query('select pg_stat_clear_snapshot()');const n=(await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and pid<>pg_backend_pid()")).rows[0].n;if(n>=2)break;if(Date.now()>until)throw new Error('Discovery shared history lock contention absent');await new Promise(r=>setTimeout(r,20))}
  await db.query('commit');const raced=await Promise.all(pending);for(const r of raced)if(r.error)throw r.error
  assert.equal(raced.filter(r=>r.result.outcome==='COMMITTED').length,1);assert.equal(raced.filter(r=>r.result.outcome==='CONFLICT').length,1)
  assert.equal(raced.find(r=>r.result.outcome==='COMMITTED').result.receipt.discoveryBudget.admitted,true)
  const loser=raced.findIndex(r=>r.result.outcome==='CONFLICT'),fresh=await source.read(userId)
  const retry=await source.commitDiscovery(fresh,fresh.snapshot,raceCommands[loser]);assert.equal(retry.receipt.discoveryBudget.admitted,false)
  const held=(await db.query("select count(*)::int n,sum((receipt#>>'{discoveryBudget,retainedMicroUsd}')::bigint)::text held from pjsdas_rows_candidate.ledger where user_id=$1 and provenance#>>'{discoveryBudgetHold,policy,approvalId}'='synthetic-concurrent-cap'",[userId])).rows[0]
  assert.equal(held.n,2);assert.equal(Number(held.held),amount)
 } finally {await db.query('rollback');await Promise.all(clients.map(c=>c.end()))}
 console.log('PASS Discovery real two-session cap/CAS race: one retained hold, stale conflict without hold, explicit fresh retry declined')
 const grant=(await db.query("insert into public.pjsdas_authorization_grants(user_id,client_id,source_id,capability) values($1,$2,$3,'ingest_discovery_run') returning id,revision",[userId,clientId,sourceId])).rows[0]
 const delegated={kind:'delegated_mcp',userId,clientId,sourceId,grantId:grant.id,grantRevision:Number(grant.revision)}
 const delegatedBefore=await source.read(userId),secondFacts={...factsCommand,commandId:'synthetic-delegated-facts',run:{...factsCommand.run,runId:'synthetic-delegated-run'}}
 const refreshed=applyVerifiedDiscoveryCommand(delegatedBefore.snapshot,secondFacts,now)
 const delegatedCommand={commandId:secondFacts.commandId,payloadHash:'d'.repeat(64),operation:'ingest_verified_discovery',principal:'delegated_mcp',clientId,authorization:delegated,provenance:{sourceId},compensation:null}
 await assert.rejects(source.commitDiscovery(delegatedBefore,refreshed.snapshot,{...delegatedCommand,clientId:'foreign-client'}))
 await assert.rejects(source.commitDiscovery(delegatedBefore,refreshed.snapshot,{...nextClaim,principal:'delegated_mcp',clientId,authorization:delegated}))
 const refreshedResult=await source.commitDiscovery(delegatedBefore,refreshed.snapshot,delegatedCommand);equal((await source.read(userId)).snapshot,refreshed.snapshot);assert.equal(refreshedResult.receipt.discoveryAuthorization.grantId,grant.id)
 // Conflicting imported provenance under an existing command ID must block,
 // rather than silently choosing whichever ledger happens to be queried first.
 await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,expected_revision,principal_kind,client_id,provenance,compensation,status,resulting_revision,receipt) select workspace_id,user_id,command_id,receipt->>'operation',payload_hash,expected_revision,principal_kind,client_id,provenance||'{\"syntheticConflict\":true}'::jsonb,nullif(compensation,'null'::jsonb),receipt->>'status',resulting_revision,receipt from pjsdas_rows_candidate.ledger where user_id=$1 and command_id=$2",[userId,nextClaim.commandId])
 const ambiguousBefore=await source.read(userId);await assert.rejects(source.commitDiscovery(ambiguousBefore,ambiguousBefore.snapshot,claim(12)))
 equal((await source.read(userId)).snapshot,ambiguousBefore.snapshot)
 await db.query('update public.pjsdas_authorization_grants set revoked_at=now() where id=$1',[grant.id]);await assert.rejects(source.commitDiscovery(delegatedBefore,refreshed.snapshot,delegatedCommand))
 await db.query('update public.google_drive_connections set discovery_automation_enabled=false where user_id=$1',[userId]);await assert.rejects(source.commitDiscovery(before,initial,nextClaim))
 console.log('PASS Discovery real verifier/domain/HTTP: retained-history budget cap, original claim/replay/settlement, declined hold cannot fabricate facts, fixed terms, no skipped batch, scoped delegated/automation authority and revoked replay; no external search/model')
}

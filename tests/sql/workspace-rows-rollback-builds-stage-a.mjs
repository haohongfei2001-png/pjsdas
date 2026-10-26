// Offline two-checkout compatibility proof, not a production rollback drill.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {resolveHistoricalSource} from './workspace-rows-historical-sources.mjs'
import {pathToFileURL} from 'node:url'
import {resolve,join} from 'node:path'
import {encodeWorkspaceRows} from '../../gateway/workspaceRowsCodec.ts'
import {createWorkspaceRowsCandidate} from '../../gateway/workspaceRowsCandidate.ts'
import {applyGmailSemanticBatch} from '../../src/gmailSemanticIntake.ts'

export async function testTwoRowCompatibleCheckouts({db,origin,token,initial,records}) {
 const checkout=process.env.TA_ROW_ROLLBACK_CHECKOUT
 if(!checkout&&process.env.TA_ROW_ROLLBACK_FIXTURE!=='1'){console.log('OPEN two-source compatibility requires TA_ROW_ROLLBACK_FIXTURE=1 or an explicit original checkout; not counted as passed');return}
 const rollbackSource=resolveHistoricalSource('serial',{checkout}),directory=rollbackSource.root,expected=rollbackSource.sourceCommit
 const {createWorkspaceRowsCandidate:createRollback}=await import(pathToFileURL(join(directory,'gateway/workspaceRowsCandidate.ts')).href)
 const userId=randomUUID(),encoded=encodeWorkspaceRows(initial)
 await db.query('insert into auth.users(id) values($1)',[userId])
 const workspaceId=(await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,initial])).rows[0].id
 const epoch=(await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) returning epoch',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),initial])).rows[0].epoch
 await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(encoded.rows)])
 await db.query('update public.pjsdas_workspaces set row_candidate_epoch=$2 where id=$1',[workspaceId,epoch])
 let active=0,peak=0
 const fetchImpl=async(url,init)=>{const page=String(url).endsWith('read_page');if(page){active++;peak=Math.max(peak,active)}try{return await fetch(String(url).replace('/rest/v1/','/'),init)}finally{if(page)active--}}
 const config={supabaseUrl:origin,serviceRoleKey:token,readsEnabled:true,writesEnabled:true,rpcTransport:'public-v1',fetchImpl}
 const a=createRollback(config),b=createWorkspaceRowsCandidate({...config,readConcurrency:4})
 const before=await b.read(userId);assert(peak>1&&peak<=4,'real candidate B issues bounded overlapping page requests')
 const applied=applyGmailSemanticBatch(before.snapshot,{runId:'synthetic-version-b',sourceId:'gmail:primary',checkedAt:initial.exportedAt,records,authorized:true,workspaceRevision:'txn:0'})
 const command={commandId:'synthetic-version-b',payloadHash:'a'.repeat(64),operation:'gmail_semantic_intake',principal:'automation',sourceId:'gmail:primary',compensation:applied.compensation}
 const first=await b.commit(before,applied.snapshot,command);assert.equal(first.outcome,'COMMITTED')
 const rollbackRead=await a.read(userId);assert.deepEqual(rollbackRead.snapshot,JSON.parse(JSON.stringify(applied.snapshot)));assert.equal(rollbackRead.revision,1)
 const resumed=applyGmailSemanticBatch(rollbackRead.snapshot,{runId:'synthetic-version-a',sourceId:'gmail:primary',checkedAt:'2030-01-02T00:00:00.000Z',records:[],authorized:true,workspaceRevision:'txn:1'})
 assert.equal((await a.commit(rollbackRead,resumed.snapshot,{...command,commandId:'synthetic-version-a',payloadHash:'b'.repeat(64),compensation:resumed.compensation})).outcome,'COMMITTED')
 assert.deepEqual((await b.read(userId)).snapshot,JSON.parse(JSON.stringify(resumed.snapshot)))
 const replay=await a.commit(before,applied.snapshot,command);assert.equal(replay.outcome,'ALREADY_APPLIED');assert.deepEqual(replay.receipt,first.receipt)
 assert.equal((await b.read(userId)).revision,2)
 await assert.rejects(b.commit(before,applied.snapshot,{...command,commandId:'synthetic-stale-cross-version',payloadHash:'c'.repeat(64)}),/CONFLICT/)
 assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.ledger where user_id=$1',[userId])).rows[0].n,2)
 assert.deepEqual((await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1',[userId])).rows[0].snapshot,JSON.parse(JSON.stringify(initial)))
 console.log(JSON.stringify({twoCheckoutCompatibility:'PASS_LOCAL_ONLY',rollbackCommit:expected,sourceKind:rollbackSource.sourceKind,manifestSha256:rollbackSource.manifestSha256,activeReadConcurrency:peak,contract:'workspace-rows-v1',productionReleaseEvidence:false}))
}

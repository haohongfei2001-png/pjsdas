/** Local synthetic shared-helper semantics only. Direct administrator calls
 * test existing private helpers, not a new product authorization route. */
import assert from 'node:assert/strict'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {install,checkpointMigration} from './gmail-empty-checkpoint-fixture.mjs'
import {migration} from './discovery-authority-fixture.mjs'
import {stagedOpportunityFixture} from '../fixtures/workspaceRowsStagedOpportunity.ts'
import {readOpportunityManagement,applyOpportunityManagement,restoreOpportunityManagement} from '../../src/opportunityManagement.ts'
import {encodeWorkspaceRows,diffWorkspaceRows} from '../../gateway/workspaceRowsCodec.ts'
import {prepareStagedEffects} from '../../gateway/workspaceRowsLargeCommandPrototype.ts'
const url=new URL(process.env.TA_ROW_DATABASE_URL);assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname))
const admin=new pg.Client({connectionString:url.href}),name='ta_finalizer_equiv_'+randomUUID().replaceAll('-','');url.pathname='/'+name
const db=new pg.Client({connectionString:url.href});let created=false
const wire=x=>JSON.parse(JSON.stringify(x))
try{
 await admin.connect();await admin.query('create database '+name);created=true;await db.connect();await install(db);await db.query(await migration(checkpointMigration))
 for(const f of ['workspace-rows-stage-a.sql','workspace-rows-large-command-prototype.sql'])await db.query(readFileSync(new URL('./candidates/'+f,import.meta.url),'utf8'))
 const f=await stagedOpportunityFixture(8,{compactIds:true}),before=structuredClone(f.before)
 before.data.actions.splice(2,0,{...before.data.actions[0],id:'r',opportunityId:'r',futureField:{preserve:['未知',null]}})
 const review=await readOpportunityManagement(before,'o'),result=await applyOpportunityManagement(before,{operations:[{kind:'archive_opportunity',id:'o',expectedFingerprint:review.archive.fingerprint,dependencies:review.archive.dependencies,reason:'Synthetic exact private-helper test'}]},'synthetic-small-archive',new Date(f.at));assert.equal(result.status,'APPLIED');assert(result.compensation)
 const undo=restoreOpportunityManagement(result.snapshot,result.compensation,new Date('2030-01-01T00:01:00Z'))
 for(const fixture of [{label:'mixed-archive',before,after:result.snapshot},{label:'mixed-undo',before:result.snapshot,after:undo}]){
  const owner=randomUUID(),workspace=randomUUID(),encoded=encodeWorkspaceRows(fixture.before),delta=diffWorkspaceRows(fixture.before,fixture.after)
  await db.query('insert into auth.users(id) values($1)',[owner]);const epoch=(await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) returning epoch',[workspace,owner,encoded.envelope,JSON.stringify(encoded.manifest),fixture.before])).rows[0].epoch
  await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) x(collection text,id text,ordinal bigint,value jsonb)',[workspace,owner,JSON.stringify(encoded.rows)])
  // Only effect_digest (different original/staged algorithms), created_at and
  // receipt.committedAt are intentionally excluded from cross-run equality.
  const state=async()=>({head:(await db.query('select * from pjsdas_rows_candidate.head where id=$1',[workspace])).rows,rows:(await db.query('select * from pjsdas_rows_candidate.item where workspace_id=$1 order by collection,id',[workspace])).rows,ledger:(await db.query("select workspace_id,user_id,command_id,payload_hash,client_id,resulting_revision,receipt-'committedAt' receipt,compensation,principal_kind,provenance,expected_revision,effective_time from pjsdas_rows_candidate.ledger where workspace_id=$1 order by command_id",[workspace])).rows})
  const baseline=await state()
  const cases=[
   {label:'valid',mutate:()=>{}},
   {label:'missing-after',code:'22023',mutate:d=>{delete d.changes.at(-1).after}},
   {label:'malformed-after',code:'22023',mutate:d=>{const c=d.changes.find(c=>c.after!==null);c.after={...c.after,ordinal:'0'}}},
   {label:'missing-preimage',code:'PT409',mutate:d=>{d.changes.find(c=>c.before!==null).before=null}},
   {label:'late-stale-preimage',code:'PT409',mutate:d=>{const c=d.changes.filter(c=>c.before!==null).at(-1);c.before={...c.before,value:{id:c.id,stale:true}}}},
   {label:'ordinal-gap',code:'22023',mutate:d=>{d.changes.find(c=>c.after!==null).after.ordinal=999}},
   {label:'duplicate-key',code:'22023',stagedCode:'23505',mutate:d=>{d.changes.push(structuredClone(d.changes[0]))}},
  ]
  // Undo inserts many actions; duplicate ordinal must roll back all preceding DML.
  if(fixture.label==='mixed-undo')cases.push({label:'duplicate-ordinal',code:'22023',mutate:d=>{const a=d.changes.filter(c=>c.collection==='actions'&&c.after!==null);a[1].after.ordinal=a[0].after.ordinal}})
  for(const test of cases){
   const d=wire(delta);test.mutate(d);const p=prepareStagedEffects(d),req={...p.metadata,workspaceId:workspace,userId:owner,expectedEpoch:epoch,expectedRevision:0,commandId:'equivalence-'+test.label,payloadHash:'a'.repeat(64),operation:fixture.label==='mixed-undo'?'undo_command':'opportunity_management',principal:'delegated_mcp',compensation:result.compensation,provenance:{},effectiveTime:f.at},out=[]
   for(const staged of [false,true]){
    await db.query('begin');let code,after
    try{
     if(staged){const stage=randomUUID();await db.query("insert into pjsdas_rows_candidate.large_stage(id,user_id,workspace_id,request,effect_count,final_digest,expires_at) values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour')",[stage,owner,workspace,req,p.parts.length,p.finalDigest]);await db.query('savepoint append_page');try{await db.query('select pjsdas_rows_candidate.large_append($1,$2,$3)',[stage,owner,JSON.stringify(p.parts)])}catch(e){if(test.label==='duplicate-key'){await db.query('rollback to append_page');assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.large_effect where stage_id=$1',[stage])).rows[0].n,0);assert.deepEqual((await db.query('select next_ordinal,rolling_digest,received_bytes from pjsdas_rows_candidate.large_stage where id=$1',[stage])).rows[0],{next_ordinal:0,rolling_digest:'0'.repeat(64),received_bytes:'0'})}throw e}await db.query('select pjsdas_rows_internal.apply_staged_rows($1,$2)',[req,stage])}
     else await db.query('select pjsdas_rows_internal.apply_rows($1)',[{...req,changes:d.changes}])
     await db.query('set constraints all immediate');after=await state()
    }catch(e){code=e.code}finally{await db.query('rollback')}
    assert.equal(code,staged?(test.stagedCode??test.code):test.code,fixture.label+'/'+test.label+'/'+staged);assert.deepEqual(await state(),baseline,'failed/rolled-back helper cannot publish partial rows/head/ledger');out.push(after)
   }
   if(!test.code)assert.deepEqual(out[0],out[1],'complete old and staged state/receipt semantics')
   console.log('PASS FINALIZER_EQUIVALENCE',JSON.stringify({fixture:fixture.label,case:test.label,originalCode:test.code??'COMMITTED',stagedCode:test.stagedCode??test.code??'COMMITTED',allStateRolledBack:true}))
  }
 }
}finally{await db.end().catch(()=>{});if(created)await admin.query('drop database '+name+' with(force)');await admin.end();console.log('FINALIZER_EQUIVALENCE_CLEANUP owned diagnostic database removed')}

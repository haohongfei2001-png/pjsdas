/** Local-only complete shared-finalizer query matrix. EXPLAIN ANALYZE DML is
 * rolled back; absent/fresh/stale statistics and custom/generic plans are test
 * inputs, never runtime settings. No production statistics/index changes. */
import assert from 'node:assert/strict'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {largeAbandonFixture} from '../fixtures/workspaceRowsLargeCommand.ts'
import {stagedOpportunityFixture} from '../fixtures/workspaceRowsStagedOpportunity.ts'
import {applyOpportunityManagement,readOpportunityManagement,restoreOpportunityManagement} from '../../src/opportunityManagement.ts'
import {encodeWorkspaceRows,diffWorkspaceRows} from '../../gateway/workspaceRowsCodec.ts'
const connection=process.env.TA_ROW_DATABASE_URL;assert(connection)
const url=new URL(connection);assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname))
const database='ta_finalizer_plan_'+randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString:connection})
url.pathname='/'+database;const db=new pg.Client({connectionString:url.href});let created=false
const report={localOnly:true,fixtureFilter:process.env.TA_PLAN_FIXTURES??null,workMemKiB:2184,statementTimeoutMs:10000,cases:[],equivalence:[]}
const a=readFileSync(new URL('./candidates/workspace-rows-stage-a.sql',import.meta.url),'utf8'),b=readFileSync(new URL('./candidates/workspace-rows-large-command-prototype.sql',import.meta.url),'utf8')
const valid=a.slice(a.indexOf('create function pjsdas_rows_candidate.valid_state'),a.indexOf('-- Original command identity'))
const bound="with effects as materialized (select effect,ordinal,effect->>'collection' collection,effect->>'id' id from pjsdas_rows_candidate.large_effect where stage_id=$2),preimages as materialized (select collection,id,ordinal,value from pjsdas_rows_candidate.item where workspace_id=$1) select e.effect,case when i.id is null then 'null'::jsonb else jsonb_build_object('collection',i.collection,'id',i.id,'ordinal',i.ordinal,'value',i.value) end actual_before from effects e left join preimages i on i.collection=e.collection and i.id=e.id order by e.ordinal"
const originalDelete="delete from pjsdas_rows_candidate.item i using pjsdas_rows_candidate.large_effect e where e.stage_id=$2 and e.effect->'after'='null'::jsonb and i.workspace_id=$1 and i.collection=e.effect->>'collection' and i.id=e.effect->>'id'"
const scalarDelete="with deletions as materialized (select effect->>'collection' collection,effect->>'id' id from pjsdas_rows_candidate.large_effect where stage_id=$2 and effect->'after'='null'::jsonb) delete from pjsdas_rows_candidate.item i using deletions d where i.workspace_id=$1 and i.collection=d.collection and i.id=d.id"
const upsert="insert into pjsdas_rows_candidate.item(workspace_id,user_id,collection,id,ordinal,value,updated_revision) select $1,$1,e.effect->>'collection',e.effect->>'id',(e.effect#>>'{after,ordinal}')::bigint,e.effect#>'{after,value}',1 from pjsdas_rows_candidate.large_effect e where e.stage_id=$2 and e.effect->'after'<>'null'::jsonb order by e.ordinal on conflict(workspace_id,collection,id) do update set ordinal=excluded.ordinal,value=excluded.value,updated_revision=excluded.updated_revision"
const queries={
 preimage:bound,
 original_delete:originalDelete,
 scalar_delete:scalarDelete,
 upsert,
 effect_integrity:"select * from pjsdas_rows_candidate.large_effect where stage_id=$2 order by ordinal for share",
 duplicate_keys:"select 1 from pjsdas_rows_candidate.large_effect where stage_id=$2 group by effect->>'collection',effect->>'id' having count(*)>1",
 head_lock:"select * from pjsdas_rows_candidate.head where id=$1 for update",
 stage_lock:"select * from pjsdas_rows_candidate.large_stage where id=$2 for update",
 original_ledger:"select * from pjsdas_rows_candidate.ledger where user_id=$1 and command_id='original'",
 undo_evidence:"select compensation,receipt->>'operation',receipt->>'status' from pjsdas_rows_candidate.ledger where user_id=$1 and command_id='original'",
 scalar_projection:"with effects as materialized (select c->>'collection' collection,c->>'id' id,c->'after' after from pjsdas_rows_internal.staged_changes($2) c),projected as (select i.ordinal,i.value from pjsdas_rows_candidate.item i where i.workspace_id=$1 and i.collection='actions' and not exists(select 1 from effects e where e.collection='actions' and e.id=i.id) union all select (e.after->>'ordinal')::bigint,e.after->'value' from effects e where e.collection='actions' and e.after is distinct from 'null'::jsonb) select coalesce(jsonb_agg(value order by ordinal),'[]'::jsonb) from projected",
 v3_old_rows:"select coalesce(jsonb_agg(i.value order by i.ordinal),'[]'::jsonb) from pjsdas_rows_candidate.item i where i.workspace_id=$1 and i.collection='actions'",
 v3_projection:"with projected as (select i.ordinal,i.value from pjsdas_rows_candidate.item i where i.workspace_id=$1 and i.collection='actions' and not exists(select 1 from pjsdas_rows_internal.staged_changes($2) c where c->>'collection'='actions' and c->>'id'=i.id) union all select (c#>>'{after,ordinal}')::bigint,c#>'{after,value}' from pjsdas_rows_internal.staged_changes($2) c where c->>'collection'='actions' and c->'after' is distinct from 'null'::jsonb) select coalesce(jsonb_agg(value order by ordinal),'[]'::jsonb) from projected",
 // JSON arguments are fetched from the same stage row to keep EXPLAIN output
 // compact. Single-row subplans are reported explicitly, not hidden timings.
 head_update:"update pjsdas_rows_candidate.head set revision=1,envelope=(select request->'afterEnvelope' from pjsdas_rows_candidate.large_stage where id=$2),manifest=(select request->'afterManifest' from pjsdas_rows_candidate.large_stage where id=$2),schema_version=4 where id=$1",
 valid_state:"select pjsdas_rows_candidate.valid_state($1)",
 ledger_insert:"insert into pjsdas_rows_candidate.ledger(workspace_id,user_id,command_id,payload_hash,resulting_revision,receipt,compensation,effect_digest,principal_kind,provenance,expected_revision,effective_time) select $1,$1,'applied',repeat('0',64),1,jsonb_build_object('status','COMMITTED','operation','synthetic'),request->'compensation',final_digest,'first_party_web','{}',0,now() from pjsdas_rows_candidate.large_stage where id=$2",
 audit_size:"select octet_length((to_jsonb(l)-'effect_digest')::text)+octet_length(to_jsonb(l.receipt->>'operation')::text)+64>2097150 from pjsdas_rows_candidate.ledger l where l.workspace_id=$1 and l.command_id='original'",
 stage_update:"update pjsdas_rows_candidate.large_stage set result=jsonb_build_object('outcome','COMMITTED') where id=$2",
}
const normalize=rows=>rows.map(({collection,id,ordinal,value})=>({collection,id,ordinal:Number(ordinal),value})).sort((x,y)=>(x.collection+'\0'+x.id).localeCompare(y.collection+'\0'+y.id))
try{
 await admin.connect();await admin.query('create database '+database);created=true;await db.connect();await db.query("set work_mem='2184kB';set statement_timeout='10s'")
 const f=largeAbandonFixture(),v=await stagedOpportunityFixture(2050,{compactIds:true})
 const mixed=structuredClone(v.before),retained=Array.from({length:300},(_,n)=>({...mixed.data.actions[0],id:n?'kept'+n:'r',opportunityId:'r',futureField:{keep:['未知',n]}}))
 for(let n=0;n<retained.length;n++)mixed.data.actions.splice(n*7,0,retained[n])
 const review=await readOpportunityManagement(mixed,'o'),mr=await applyOpportunityManagement(mixed,{operations:[{kind:'archive_opportunity',id:'o',expectedFingerprint:review.archive.fingerprint,dependencies:review.archive.dependencies,reason:'Synthetic mixed retained archive'}]},'mixed-archive',new Date(v.at));assert.equal(mr.status,'APPLIED');assert(mr.compensation)
 const mu=restoreOpportunityManagement(mr.snapshot,mr.compensation,new Date('2030-01-01T00:01:00.000Z'))
 for(const fixture of [{label:'first-party-abandon',before:f.before,after:f.result.snapshot,compensation:f.result.compensation},{label:'first-party-undo',before:f.result.snapshot,after:f.undo,compensation:f.result.compensation},{label:'v3-archive',before:v.before,after:v.result.snapshot,compensation:v.result.compensation},{label:'v3-undo',before:v.result.snapshot,after:v.undo,compensation:v.result.compensation},{label:'v3-mixed-archive',before:mixed,after:mr.snapshot,compensation:mr.compensation},{label:'v3-mixed-undo',before:mr.snapshot,after:mu,compensation:mr.compensation}]){
  if(process.env.TA_PLAN_FIXTURES&&!fixture.label.includes(process.env.TA_PLAN_FIXTURES))continue
  await db.query('deallocate all;drop schema if exists pjsdas_rows_candidate cascade;drop schema if exists pjsdas_rows_internal cascade;create schema pjsdas_rows_candidate;create schema pjsdas_rows_internal;'+a.slice(a.indexOf('create table pjsdas_rows_candidate.head'),a.indexOf('alter table pjsdas_rows_candidate.head'))+b.slice(b.indexOf('create table pjsdas_rows_candidate.large_stage'),b.indexOf('alter table pjsdas_rows_candidate.large_stage'))+valid+"create function pjsdas_rows_internal.staged_changes(target_stage uuid) returns setof jsonb language sql stable security invoker set search_path=pg_catalog as $$select effect from pjsdas_rows_candidate.large_effect where stage_id=target_stage order by ordinal$$;")
  for(const table of ['head','item','ledger','large_stage','large_effect'])await db.query(`alter table pjsdas_rows_candidate.${table} set(autovacuum_enabled=false)`)
  for(const [key,sql] of Object.entries(queries))await db.query(`prepare ${key}(uuid,uuid) as ${sql}`)
  const before=encodeWorkspaceRows(fixture.before),after=encodeWorkspaceRows(fixture.after),effects=diffWorkspaceRows(fixture.before,fixture.after).changes,owners=[]
  async function seed(){const owner=randomUUID(),stage=randomUUID();owners.push({owner,stage});await db.query("insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$1,$2,$3,'{}')",[owner,before.envelope,JSON.stringify(before.manifest)]);await db.query('insert into pjsdas_rows_candidate.item select $1,$1,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($2) x(collection text,id text,ordinal bigint,value jsonb)',[owner,JSON.stringify(before.rows)]);await db.query("insert into pjsdas_rows_candidate.large_stage(id,user_id,workspace_id,request,effect_count,final_digest,expires_at) values($1,$2,$2,$3,$4,repeat('0',64),now()+interval '1 hour')",[stage,owner,{afterEnvelope:after.envelope,afterManifest:after.manifest,compensation:fixture.compensation},effects.length]);await db.query("insert into pjsdas_rows_candidate.large_effect select $1,(n-1)::integer,value::text,repeat('0',64),value from jsonb_array_elements($2) with ordinality e(value,n)",[stage,JSON.stringify(effects)]);await db.query("insert into pjsdas_rows_candidate.ledger(workspace_id,user_id,command_id,payload_hash,resulting_revision,receipt,compensation,effect_digest) values($1,$1,'original',repeat('0',64),0,'{\"status\":\"COMMITTED\",\"operation\":\"synthetic\"}',$2,repeat('0',64))",[owner,fixture.compensation]);return{owner,stage}}
  async function sample(label,target){
   const stats=(await db.query("select tablename,attname,n_distinct,most_common_freqs from pg_stats where schemaname='pjsdas_rows_candidate' and attname in ('workspace_id','stage_id','collection','id','user_id') order by tablename,attname")).rows
   const counts=(await db.query('select (select count(*) from pjsdas_rows_candidate.item)::int items,(select count(*) from pjsdas_rows_candidate.large_effect)::int effects')).rows[0]
   const foreignFingerprint=async()=> (await db.query("select md5(coalesce(string_agg(to_jsonb(i)::text,',' order by workspace_id,collection,id),'')) fingerprint from pjsdas_rows_candidate.item i where workspace_id<>$1",[target.owner])).rows[0].fingerprint,foreignBefore=await foreignFingerprint()
   const call=key=>`execute ${key}('${target.owner}','${target.stage}')`
   for(const mode of ['force_custom_plan','force_generic_plan']){
    await db.query('set plan_cache_mode='+mode)
    for(const key of Object.keys(queries)){
     if(!fixture.label.startsWith('v3-')&&(key.startsWith('v3_')||key==='scalar_projection'))continue
     await db.query('begin');let estimated,plan,error;const start=performance.now()
     try{estimated=(await db.query('explain(format json,settings) '+call(key))).rows[0]['QUERY PLAN'];plan=(await db.query('explain(analyze,buffers,settings,format json) '+call(key))).rows[0]['QUERY PLAN']
      if(key==='scalar_delete'||key==='original_delete'){const actual=(await db.query('select collection,id,ordinal,value from pjsdas_rows_candidate.item where workspace_id=$1',[target.owner])).rows,deleted=new Set(effects.filter(e=>e.after===null).map(e=>e.collection+'\0'+e.id));assert.deepEqual(normalize(actual),normalize(before.rows.filter(r=>!deleted.has(r.collection+'\0'+r.id))))}
     }catch(e){error={code:e.code,message:e.message};if(!['original_delete','v3_projection'].includes(key))throw e}finally{await db.query('rollback');const entry={fixture:fixture.label,label,mode,query:key,workspaces:owners.length,rowsPerWorkspace:before.rows.length,effectsPerStage:effects.length,counts,stats,elapsedMs:Math.round(performance.now()-start),estimated,plan,error};report.cases.push(entry);console.log('FINALIZER_PLAN',JSON.stringify({...entry,stats:undefined,estimated:undefined,plan:undefined}))}
    }
    if(fixture.label.startsWith('v3-'))assert.deepEqual((await db.query(call('scalar_projection'))).rows[0].coalesce,fixture.after.data.actions)
    // Exact full preimages including null creation, and full DML/manifest state.
    const preimages=(await db.query(call('preimage'))).rows;assert.deepEqual(preimages.map(r=>r.actual_before),effects.map(e=>e.before))
    await db.query('begin');try{await db.query(call('scalar_delete'));await db.query(call('upsert'));await db.query(call('head_update'));await db.query('set constraints all immediate');const actual=(await db.query('select collection,id,ordinal,value from pjsdas_rows_candidate.item where workspace_id=$1',[target.owner])).rows;assert.deepEqual(normalize(actual),normalize(after.rows));assert.equal((await db.query(call('valid_state'))).rows[0].valid_state,true);assert.equal(await foreignFingerprint(),foreignBefore);const revisions=(await db.query('select collection,id,updated_revision from pjsdas_rows_candidate.item where workspace_id=$1',[target.owner])).rows,changed=new Set(effects.filter(e=>e.after!==null).map(e=>e.collection+'\0'+e.id));for(const row of revisions)assert.equal(Number(row.updated_revision),changed.has(row.collection+'\0'+row.id)?1:0)}finally{await db.query('rollback')}
    report.equivalence.push({fixture:fixture.label,label,mode,exactPreimages:true,exactDmlRows:true,foreignOwnerCompleteRowsDigestUnchanged:true,updatedRevisionsExact:true,manifestAndDeferredConstraints:true})
   }
  }
  const first=await seed();await sample('single-no-statistics',first);await db.query('analyze');await sample('single-analyzed',first);for(let n=1;n<24;n++)await seed();await sample('24-owner-stale-single-owner-statistics',owners.at(-1));await db.query('analyze');await sample('24-owner-analyzed',owners.at(-1))
 }
 report.complete=true
}finally{if(process.env.TA_PLAN_REPORT)writeFileSync(process.env.TA_PLAN_REPORT,JSON.stringify(report,null,2));await db.end().catch(()=>{});if(created)await admin.query('drop database '+database+' with(force)');await admin.end();console.log('FINALIZER_PLAN_CLEANUP owned diagnostic database removed')}

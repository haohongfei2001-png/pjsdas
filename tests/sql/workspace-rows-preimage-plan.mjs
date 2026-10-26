/** Isolated synthetic query-plan diagnostic. No production connection permitted. */
import assert from 'node:assert/strict'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {largeAbandonFixture} from '../fixtures/workspaceRowsLargeCommand.ts'
import {encodeWorkspaceRows,diffWorkspaceRows} from '../../gateway/workspaceRowsCodec.ts'
const connection=process.env.TA_ROW_DATABASE_URL;assert(connection)
const url=new URL(connection);assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname))
const database='ta_intent_plan_'+randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString:connection})
url.pathname='/'+database;const db=new pg.Client({connectionString:url.href});let created=false
const result={localOnly:true,workMemKiB:2184,statementTimeoutMs:10000,cases:[]}
try{
 await admin.connect();await admin.query('create database '+database);created=true;await db.connect()
 await db.query(`set work_mem='2184kB';set statement_timeout='10s';create schema pjsdas_rows_candidate;
 create table pjsdas_rows_candidate.item(workspace_id uuid not null,user_id uuid not null,collection text collate "C" not null,id text not null,ordinal bigint not null,value jsonb not null,updated_revision bigint not null,primary key(workspace_id,collection,id),unique(workspace_id,collection,ordinal) deferrable initially deferred) with (autovacuum_enabled=false);
 create table pjsdas_rows_candidate.large_effect(stage_id uuid not null,ordinal integer not null,wire text not null,digest text not null,effect jsonb not null,primary key(stage_id,ordinal)) with (autovacuum_enabled=false);
 create unique index large_effect_identity on pjsdas_rows_candidate.large_effect(stage_id,(effect->>'collection'),(effect->>'id'));`)
 const f=largeAbandonFixture(),rows=encodeWorkspaceRows(f.before).rows,effects=diffWorkspaceRows(f.before,f.result.snapshot).changes,owners=[]
 async function seed(){const owner=randomUUID(),stage=randomUUID();owners.push({owner,stage});await db.query('insert into pjsdas_rows_candidate.item select $1,$1,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($2) x(collection text,id text,ordinal bigint,value jsonb)',[owner,JSON.stringify(rows)]);await db.query("insert into pjsdas_rows_candidate.large_effect select $1,(n-1)::integer,value::text,repeat('0',64),value from jsonb_array_elements($2) with ordinality e(value,n)",[stage,JSON.stringify(effects)]);return{owner,stage}}
 const projection="select e.effect,case when i.id is null then 'null'::jsonb else jsonb_build_object('collection',i.collection,'id',i.id,'ordinal',i.ordinal,'value',i.value) end from pjsdas_rows_candidate.large_effect e "
 const old=projection+"left join pjsdas_rows_candidate.item i on i.workspace_id=$1 and i.collection=e.effect->>'collection' and i.id=e.effect->>'id' where e.stage_id=$2 order by e.ordinal"
 const next=projection+"left join lateral (select i.collection,i.id,i.ordinal,i.value from pjsdas_rows_candidate.item i where i.workspace_id=$1 and i.collection=e.effect->>'collection' and i.id=e.effect->>'id' limit 1) i on true where e.stage_id=$2 order by e.ordinal"
 const bounded="with effects as materialized (select effect,ordinal,effect->>'collection' collection,effect->>'id' id from pjsdas_rows_candidate.large_effect where stage_id=$2),preimages as materialized (select collection,id,ordinal,value from pjsdas_rows_candidate.item where workspace_id=$1) "+projection.replace('pjsdas_rows_candidate.large_effect','effects')+"left join preimages i on i.collection=e.collection and i.id=e.id order by e.ordinal"
 await db.query('prepare bounded(uuid,uuid) as '+bounded)
 await db.query('prepare original(uuid,uuid) as '+old);await db.query('prepare indexed(uuid,uuid) as '+next)
 async function sample(label,target){
  const counts=(await db.query('select (select count(*) from pjsdas_rows_candidate.item)::int items,(select count(*) from pjsdas_rows_candidate.large_effect)::int effects')).rows[0]
  const stats=(await db.query("select tablename,attname,n_distinct,most_common_freqs from pg_stats where schemaname='pjsdas_rows_candidate' and attname in ('workspace_id','stage_id','collection','id') order by tablename,attname")).rows
  for(const mode of ['force_custom_plan','force_generic_plan'])for(const query of ['original','indexed','bounded']){
   await db.query('set plan_cache_mode='+mode);const sql=`execute ${query}('${target.owner}','${target.stage}')`,estimated=(await db.query('explain(format json,settings) '+sql)).rows[0]['QUERY PLAN'];const start=performance.now();let plan,error
   try{plan=(await db.query('explain(analyze,buffers,settings,format json) '+sql)).rows[0]['QUERY PLAN']}catch(e){error={code:e.code,message:e.message}}
   const entry={label,workspaces:owners.length,rowsPerWorkspace:rows.length,effectsPerStage:effects.length,counts,stats,mode,query,elapsedMs:Math.round(performance.now()-start),estimated,plan,error};result.cases.push(entry);console.log('PLAN_CASE',JSON.stringify({label,workspaces:owners.length,mode,query,elapsedMs:entry.elapsedMs,error}))
  }
 }
 const first=await seed();await sample('single-no-statistics',first);await db.query('analyze pjsdas_rows_candidate.item;analyze pjsdas_rows_candidate.large_effect');await sample('single-analyzed',first)
 for(let n=1;n<24;n++)await seed();await sample('24-owner-stale-single-owner-statistics',owners.at(-1));await db.query('analyze pjsdas_rows_candidate.item;analyze pjsdas_rows_candidate.large_effect');await sample('24-owner-analyzed',owners.at(-1))
 const originalRows=(await db.query('execute original(\''+owners.at(-1).owner+'\',\''+owners.at(-1).stage+'\')')).rows,boundedRows=(await db.query('execute bounded(\''+owners.at(-1).owner+'\',\''+owners.at(-1).stage+'\')')).rows;assert.deepEqual(boundedRows,originalRows);result.exactPreimageRowsEqual=true
 if(process.env.TA_PLAN_REPORT)writeFileSync(process.env.TA_PLAN_REPORT,JSON.stringify(result,null,2))
}finally{await db.end().catch(()=>{});if(created)await admin.query('drop database '+database+' with(force)');await admin.end();console.log('PLAN_CLEANUP owned diagnostic database removed')}

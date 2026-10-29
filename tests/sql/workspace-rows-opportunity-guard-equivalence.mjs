/** Synthetic local PG differential proof against the immutable pre-optimization
 * complete v3 inner guard. Authority/CAS/ledger are covered by the native suites;
 * this suite compares exact JSONB output, SQLSTATE, message and error ordering. */
import assert from 'node:assert/strict'
import pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {install,checkpointMigration} from './gmail-empty-checkpoint-fixture.mjs'
import {migration} from './discovery-authority-fixture.mjs'
import {stagedOpportunityFixture} from '../fixtures/workspaceRowsStagedOpportunity.ts'
const url=new URL(process.env.TA_ROW_DATABASE_URL);assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname))
const admin=new pg.Client({connectionString:url.href}),name='ta_guard_equiv_'+randomUUID().replaceAll('-','');url.pathname='/'+name
const db=new pg.Client({connectionString:url.href});let created=false,count=0,fullGuardCases=0
const original=readFileSync(new URL('./fixtures/opportunity-guard-pre-scalar.sql',import.meta.url),'utf8')
assert.equal(createHash('sha256').update(original).digest('hex'),'64f12841423cc3410192e6706a1c4c0c2d848e57cf6da0fe847e61157bec1722','fixed original guard preimage')
const source=readFileSync(new URL('./candidates/workspace-rows-opportunity-stage-a.sql',import.meta.url),'utf8')
const start="    if (target_snapshot - array['data','version','exportedAt'])",end='\n end if;\n return pjsdas_rows_internal.apply_rows'
const optimized=source.slice(source.indexOf(start),source.indexOf(end))
const declarations=`evidence jsonb; changes jsonb; archives jsonb; old_history jsonb; new_history jsonb; old_rows jsonb; new_rows jsonb;
retained_old jsonb; retained_new jsonb; expected_rows jsonb; change jsonb; before_row jsonb; after_row jsonb; current_row jsonb; proposed_row jsonb;
kind text; collection text; row_index integer; old_ids text[]; new_ids text[]; change_ids text[]; expected_ids text[]; insertion_index integer; kind_changes jsonb; dense_slots integer[]; dense_slot integer; dense_old_count integer;`
const wire=x=>JSON.stringify(x).replaceAll('"@1.0@"','1.0').replaceAll('"@huge@"','1e100')
const exactJsonb=new WeakMap()
const outcome=async(fn,args)=>{try{const raw=(await db.query(`select ${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')})::text value`,args.map(x=>typeof x==='string'&&['opportunity_management','undo_command'].includes(x)?x:wire(x)))).rows[0].value;const result={value:JSON.parse(raw)};exactJsonb.set(result,raw);return result}catch(e){return{code:e.code,message:e.message}}}
async function compare(label,mode,args){const old=await outcome('guard_'+mode+'_original',args),now=await outcome('guard_'+mode+'_optimized',args);assert.deepEqual(now,old,label);assert.equal(exactJsonb.get(now),exactJsonb.get(old),label+'/exact-server-jsonb-text');count++;if(mode==='full')fullGuardCases++;return old}
try{
 await admin.connect();await admin.query('create database '+name);created=true;await db.connect();await install(db);await db.query(await migration(checkpointMigration))
 for(const [label,body] of [['original',original],['optimized',optimized]]){
  await db.query(`create function guard_full_${label}(old_snapshot jsonb,target_snapshot jsonb,prior_evidence jsonb,target_operation text) returns jsonb language plpgsql as $$ declare ${declarations} begin ${body} return jsonb_build_object('accepted',true); end $$`)
  const fast=body.indexOf('        -- Only the ordinary, identity-preserving integer-index subset uses');const a=fast<0?body.indexOf('        expected_rows:=old_rows;'):fast,b=body.indexOf('        if expected_rows is distinct from new_rows',a);assert(a>0&&b>a)
  await db.query(`create function guard_loop_${label}(old_rows jsonb,changes jsonb) returns jsonb language plpgsql as $$ declare expected_rows jsonb; change jsonb; row_index integer; kind text:='opportunity'; old_ids text[]; expected_ids text[]; insertion_index integer; kind_changes jsonb; dense_slots integer[]; dense_slot integer; dense_old_count integer; begin
   select coalesce(array_agg(r.value->>'id' order by r.n),array[]::text[]) into old_ids from jsonb_array_elements(old_rows) with ordinality r(value,n);
   select coalesce(jsonb_agg(c.value order by c.n),'[]'::jsonb) into kind_changes from jsonb_array_elements(changes) with ordinality c(value,n) where c.value->>'type'=kind;
   ${body.slice(a,b)} return jsonb_build_object('value',expected_rows,'sqlNull',expected_rows is null); end $$`)
 }
 const f=await stagedOpportunityFixture(6,{compactIds:true}),e=structuredClone(f.result.compensation)
 const fixtures=[{label:'archive',old:f.before,next:f.result.snapshot,op:'opportunity_management'},{label:'undo',old:f.result.snapshot,next:f.undo,op:'undo_command'}]
 for(const f of fixtures){
  const mutations=[['valid',()=>{}],['unrelated-before-evidence',x=>{x.next.data.prep=[{id:'unrelated'}];x.e.payload.changes=null}],['timeline-before-evidence',x=>{x.next.data.timeline=null;x.e.payload.changes=null}],['changes-null',x=>{x.e.payload.changes=null}],['changes-object',x=>{x.e.payload.changes={}}],['duplicate-change',x=>x.e.payload.changes.push(structuredClone(x.e.payload.changes[0]))],['duplicate-archive',x=>x.e.payload.archives.push(x.e.payload.archives[0])],['unknown-kind',x=>{x.e.payload.changes[0].type='other'}],['blank-id',x=>{x.e.payload.changes[0].id=' '}],['numeric-id',x=>{x.e.payload.changes[0].id=1}],['missing-after',x=>{delete x.e.payload.changes[0].after}],['missing-before',x=>{delete x.e.payload.changes[0].before}],['null-before',x=>{x.e.payload.changes[0].before=null}],['scalar-before',x=>{x.e.payload.changes[0].before=3}],['wrong-before-id',x=>{x.e.payload.changes[0].before.id='wrong'}],['null-after',x=>{x.e.payload.changes[0].after={id:'wrong'}}],['missing-index',x=>{delete x.e.payload.changes[0].beforeIndex}],['negative-index',x=>{x.e.payload.changes[0].beforeIndex=-1}],['fraction-index',x=>{x.e.payload.changes[0].beforeIndex=.5}],['scale-index',x=>{x.e.payload.changes[0].beforeIndex='@1.0@'}],['huge-index',x=>{x.e.payload.changes[0].beforeIndex='@huge@'}],['string-index',x=>{x.e.payload.changes[0].beforeIndex='bad'}],['collection-missing',x=>{delete x.old.data.actions}],['collection-null',x=>{x.old.data.actions=null}],['collection-object',x=>{x.old.data.actions={}}],['duplicate-old-row',x=>{const r=x.old.data.actions[0]??{id:'retained'};x.old.data.actions.push(r,r)}],['duplicate-new-row',x=>{const r=x.next.data.actions[0]??{id:'retained'};x.next.data.actions.push(r,r)}],['row-null',x=>{x.old.data.actions.push(null)}],['row-id-null',x=>{x.next.data.actions.push({id:null})}],['retained-rewrite',x=>{x.old.data.actions.push({id:'retained',unknown:1});x.next.data.actions.push({id:'retained',unknown:2})}],['retained-reorder',x=>{x.old.data.actions.push({id:'r1'},{id:'r2'});x.next.data.actions.push({id:'r2'},{id:'r1'})}],['before-mismatch',x=>{x.e.payload.changes.at(-1).before.unknown='mismatch'}]]
  for(const [label,mutate] of mutations){const x=structuredClone({...f,e});mutate(x);const result=await compare(f.label+'/'+label,'full',[x.old,x.next,x.e,x.op]);if(label==='valid')assert.deepEqual(result,{value:{accepted:true}})}
 }
 // Valid retained unknown fields, append/delete ordinals and profile replacement
 // exercise all optimized adjacent scans, not just pure full-array archives.
 for(const f of fixtures){const x=structuredClone(f),retained={id:'retained',opportunityId:'outside',unknown:{unicode:'未知',fields:[null,1]}};x.old.data.actions.push(retained);x.next.data.actions.push(retained);assert.deepEqual(await compare(f.label+'/valid-retained','full',[x.old,x.next,e,x.op]),{value:{accepted:true}})}
 const profileBefore=structuredClone(f.before),profileAfter=structuredClone(f.before),beforeRow=profileBefore.data.opportunities[0];profileAfter.data.opportunities[0].roleType='synthetic-updated'
 const profileEvidence={operation:'opportunity_management_restore',payload:{archives:[],guards:[],changes:[{type:'opportunity',id:beforeRow.id,beforeIndex:0,before:beforeRow,after:profileAfter.data.opportunities[0]}]}}
 for(const [label,old,next,op] of [['edit',profileBefore,profileAfter,'opportunity_management'],['undo-edit',profileAfter,profileBefore,'undo_command']])assert.deepEqual(await compare(label+'/valid-profile','full',[old,next,profileEvidence,op]),{value:{accepted:true}})
 const change=(id,beforeIndex,before={id})=>({type:'opportunity',id,beforeIndex,before,after:null})
 const rows=[{id:'a',unknown:['未知',null]},{id:'b'},{id:'c'}]
 const loopCases=[['replace',[change('b',0,{id:'b',unknown:{keep:true}})]],['insert-front',[change('x',0)]],['append-end',[change('x',3)]],['append-clamped',[change('x',999)]],['two-equal-index',[change('x',1),change('y',1)]],['ordered-inserts',[change('x',2),change('y',0)]],['duplicate-induced',[change('a',0,{id:'b'}),change('b',1,{id:'b',last:true})]],['null-induced',[change('a',0,null),change(null,1,{id:'z'})]],['missing-before',[{type:'opportunity',id:'x',beforeIndex:0},change('y','@huge@')]],['missing-replace-before',[{type:'opportunity',id:'a',beforeIndex:0},change('y','@huge@')]],['wrong-before-id',[change('a',0,{id:'x'}),change('x',1,{id:'x',value:1})]],['duplicate-id',[change('a',0),change('a',1,{id:'a',value:2})]],['missing-id',[{type:'opportunity',beforeIndex:0,before:{id:'x'}}]],['unicode',[change('é',0,{id:'未知'}),change('未知',1,{id:'未知',value:2})]]]
 for(const before of [null,0,'bad',[],{}, {id:null},{id:2},{id:'b'}])for(const id of ['a','new'])loopCases.push(['malformed-before-'+id+'-'+JSON.stringify(before),[change(id,0,before),change('b',1)]])
 for(const index of [null,-1,.5,'@1.0@','@huge@','bad',{},[],true])for(const id of ['a','new'])loopCases.push(['index-'+id+'-'+JSON.stringify(index),[change(id,index)]])
 for(const [label,changes] of loopCases)await compare('loop/'+label,'loop',[rows,changes])
 // Deterministic generated combinations cover first-match duplicates, retained
 // ordinals, interleaved replacements/appends, SQL NULL propagation and errors.
 let seed=0x5eed;const pick=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n}
 for(let i=0;i<240;i++){const changes=Array.from({length:1+pick(6)},()=>{const id=['a','b','x','未知',null][pick(5)],before=[{id},null,{id:'b'},{},4,{id:'未知',unknown:[null,'x']}][pick(6)];return change(id,[0,1,2,3,99,-1,.5,'@1.0@'][pick(8)],before)});await compare('generated/'+i,'loop',[i%7===0?[...rows,{id:'a',second:true}]:rows,changes])}
 console.log('PASS OPPORTUNITY_GUARD_EQUIVALENCE',JSON.stringify({cases:count,fullGuardCases,preimageSha256:createHash('sha256').update(original).digest('hex'),exactServerJsonbText:true,exactOutputSqlstateMessage:true,originalErrorsPreserved:true}))
}finally{await db.end().catch(()=>{});if(created)await admin.query('drop database '+name+' with(force)');await admin.end();console.log('OPPORTUNITY_GUARD_EQUIVALENCE_CLEANUP owned synthetic database removed')}

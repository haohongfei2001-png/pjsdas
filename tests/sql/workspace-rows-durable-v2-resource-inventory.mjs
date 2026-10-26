/** Exact ORIGINAL logical representation accounting, not files/WAL/control metadata. */
import assert from 'node:assert/strict'
export async function inventory(h,t){
 const r=await h.scalar('select * from ta_resource_reservations.reservation where stage_id=$1',[t.stage]);assert(r)
 const physical=(await h.db.query(`select representation,sum(n)::text bytes from (
  select 'intent-record' representation,octet_length(jsonb_build_object('identity',identity,'binding',binding,'encoded',encoded)::text)::bigint n from pjsdas_rows_candidate.large_command_intent where stage_id=$1
  union all select 'manifest-wire',octet_length(manifest_wire) from pjsdas_rows_candidate.large_document_bundle where stage_id=$1
  union all select 'manifest-jsonb',octet_length(manifest::text) from pjsdas_rows_candidate.large_document_bundle where stage_id=$1
  union all select 'document:'||document_name,octet_length(bytes) from pjsdas_rows_candidate.large_document_fragment where stage_id=$1
  union all select 'effect-wire',octet_length(wire) from pjsdas_rows_candidate.large_effect where stage_id=$1
  union all select 'effect-jsonb',octet_length(effect::text) from pjsdas_rows_candidate.large_effect where stage_id=$1
  union all select case when family like 'documents:%' then 'stage-binding' else 'reconstructed-request' end,octet_length(request::text) from pjsdas_rows_candidate.large_stage where id=$1
  union all select 'stage-result',octet_length(result::text) from pjsdas_rows_candidate.large_stage where id=$1 and result is not null
 ) x group by representation order by representation`,[t.stage])).rows
 const accounted=(await h.db.query(`select case when allocation_id like 'effect-wire:%' then 'effect-wire' when allocation_id like 'effect-jsonb:%' then 'effect-jsonb' else allocation_id end representation,sum(present)::text bytes from ta_resource_reservations.allocation where stage_id=$1 and not removed group by 1 order by 1`,[t.stage])).rows
 assert.deepEqual(accounted,physical,'all original logical representations charged exactly')
 assert.equal(physical.reduce((n,x)=>n+BigInt(x.bytes),0n),BigInt(r.present))
 const allocation=await h.scalar('select coalesce(sum(occupied),0)::text occupied,coalesce(sum(present),0)::text present from ta_resource_reservations.allocation where stage_id=$1',[t.stage])
 assert.equal(allocation.occupied,r.occupied);assert.equal(allocation.present,r.present)
 for(const user of [r.user_id,null]){
  const rows=(await h.db.query('select reserved,occupied,present from ta_resource_reservations.reservation'+(user?' where user_id=$1':''),user?[user]:[])).rows
  const aggregate=await h.scalar('select held,occupied,present from ta_resource_reservations.'+(user?'owner where user_id=$1':'pool'),user?[user]:[])
  for(const[key,column]of [['held','reserved'],['occupied','occupied'],['present','present']])assert.equal(BigInt(aggregate[key]),rows.reduce((n,x)=>n+BigInt(x[column]),0n))
 }
 return{reservation:r,representations:physical,allocation,notPhysicalStorageOrMemory:true,attemptControlMetadataExcluded:true}
}
export function originalResource(actual,original){
 for(const key of ['stage_id','user_id','command_id','binding','reserved','expires_at','deadline_at','intent_protocol'])assert.deepEqual(actual[key],original[key],key+' must remain original')
}

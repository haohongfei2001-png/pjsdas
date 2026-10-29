/** Synthetic original-authority integration ONLY; these tables are not runtime
 * replacements. No roles/ACL/credentials are created or modified. */
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
export const sha = data => createHash('sha256').update(data).digest('hex')
export async function installResourceAuthorityFixture(db) {
 await db.query(`create schema ta_resource_fixture;
 create table ta_resource_fixture.original_grant(user_id text primary key,active boolean not null default true,revision bigint not null default 1);
 create table ta_resource_fixture.original_head(workspace_id text primary key);
 create table ta_resource_fixture.original_stage(stage_id text primary key,binding jsonb not null,admission jsonb not null,finalizer_fence text);
 create table ta_resource_fixture.original_command(user_id text,command_id text,binding jsonb not null,resulting_revision bigint not null,receipt jsonb,projection jsonb,compensation jsonb,primary key(user_id,command_id));`)
}
export function resourceAuthorityFixture() {
 return {
  async lockOriginalAuthority(db,binding) {
   const g=(await db.query('select * from ta_resource_fixture.original_grant where user_id=$1 for share',[binding.userId])).rows[0]
   assert(g?.active&&Number(g.revision)===binding.authority.grantRevision,'ORIGINAL_AUTHORITY_DENIED')
  },
  async lockOriginalHeadStageAndValidate(db,binding) {
   assert((await db.query('select 1 from ta_resource_fixture.original_head where workspace_id=$1 for update',[binding.workspaceId])).rows.length,'ORIGINAL_HEAD_MISSING')
   const stage=(await db.query('select * from ta_resource_fixture.original_stage where stage_id=$1 for update',[binding.stageId])).rows[0]
   assert.deepEqual(stage?.binding,binding,'ORIGINAL_STAGE_BINDING_MISMATCH')
  },
  async readOriginalAdmission(db,binding) {
   return (await db.query('select admission from ta_resource_fixture.original_stage where stage_id=$1',[binding.stageId])).rows[0].admission
  },
  async fenceAndReadOriginalOutcome(db,binding) {
   const stage=(await db.query('update ta_resource_fixture.original_stage set finalizer_fence=coalesce(finalizer_fence,$2) where stage_id=$1 returning *',[binding.stageId,randomUUID()])).rows[0]
   const command=(await db.query('select * from ta_resource_fixture.original_command where user_id=$1 and command_id=$2',[binding.userId,binding.commandId])).rows[0]
   if(!command)return {outcome:'not-committed',fenceId:stage.finalizer_fence}
   assert.deepEqual(command.binding,binding,'ORIGINAL_OUTCOME_BINDING_MISMATCH')
   assert(command.receipt&&command.projection&&command.compensation,'ORIGINAL_AUDIT_RETENTION_REQUIRED')
   return {outcome:'committed',fenceId:stage.finalizer_fence,resultingRevision:Number(command.resulting_revision),auditRetention:'original-receipt-projection-compensation-retained'}
  }
 }
}
export async function seedResource(db,{stageId=randomUUID(),userId=randomUUID(),commandId=stageId,bytes=80,lifetime=60000}={}) {
 const now=Number((await db.query('select floor(extract(epoch from clock_timestamp())*1000)::bigint now')).rows[0].now)
 const binding={stageId,userId,commandId,workspaceId:'workspace-'+userId,expectedEpoch:'original-epoch',expectedRevision:4,family:'first_party_abandon',operation:'abandon_opportunity',principal:'first_party_web',authority:{grantRevision:1},payloadHash:sha('original payload'),manifestSha256:sha('original manifest'),preparedSha256:sha('original prepared')}
 const admission={binding,reservedBytes:bytes,expiresAt:now+lifetime,deadlineAt:now+lifetime}
 await db.query('insert into ta_resource_fixture.original_grant(user_id) values($1) on conflict do nothing',[userId])
 await db.query('insert into ta_resource_fixture.original_head(workspace_id) values($1) on conflict do nothing',[binding.workspaceId])
 await db.query('insert into ta_resource_fixture.original_stage(stage_id,binding,admission) values($1,$2,$3)',[stageId,binding,admission])
 return {binding,admission}
}
/** Simulates the original business transaction, not an adapter outcome string.
 * It obeys grant -> global -> owner -> reservation -> head -> stage, so a
 * resolver waiting for global cannot deadlock with its finalizer. */
export async function originalFixtureFinalize(db,adapter,binding,{hold=false,missingAudit=false}={}) {
 const authority=resourceAuthorityFixture()
 await db.query('begin')
 try {
  await authority.lockOriginalAuthority(db,binding)
  const pool=(await db.query('select * from ta_resource_reservations.pool where singleton for update')).rows[0]
  assert.equal(pool.generation,adapter.generation,'STALE_RESOURCE_GENERATION')
  await db.query('select 1 from ta_resource_reservations.owner where user_id=$1 for update',[binding.userId])
  const reservation=(await db.query('select * from ta_resource_reservations.reservation where stage_id=$1 for update',[binding.stageId])).rows[0]
  assert.equal(reservation.phase,'finalizing','FINALIZE_NOT_DISPATCHED')
  await authority.lockOriginalHeadStageAndValidate(db,binding)
  const stage=(await db.query('select * from ta_resource_fixture.original_stage where stage_id=$1',[binding.stageId])).rows[0]
  assert.equal(stage.finalizer_fence,null,'FINALIZER_CLOSED')
  const audit={original:true,commandId:binding.commandId,unknownForward:{retained:'未来😀'}}
  await db.query('insert into ta_resource_fixture.original_command values($1,$2,$3,37,$4,$5,$6)',[binding.userId,binding.commandId,binding,audit,missingAudit?null:audit,audit])
  if(!hold)await db.query('commit')
 }catch(error){await db.query('rollback').catch(()=>{});throw error}
}

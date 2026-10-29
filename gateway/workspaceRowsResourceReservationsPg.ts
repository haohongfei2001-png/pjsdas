/** Local-only normalized Postgres adapter. This is NOT connected to any runtime.
 * All participating writers must use the same lock order. The authority hooks
 * below are trusted integration code, not evidence supplied by a request. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createResourceLedger, ResourceAccountingError,
  type ResourceAdmission, type ResourceBinding, type ResourceConfiguration,
  type ResourceKind, type ResourceOutcome } from './workspaceRowsResourceAccounting.js'

export interface ResourcePgClient {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, any>[]; rowCount?: number | null }>
}
export interface ResourcePgAuthority {
  /** Existing original grant/share lock FIRST. SQL only, on this connection. */
  lockOriginalAuthority(db: ResourcePgClient, binding: ResourceBinding): Promise<void>
  /** Original metadata -> head -> stage locks, then current authority/binding
   * validation AFTER waits. No external IO, no new authority lock here. */
  lockOriginalHeadStageAndValidate(db: ResourcePgClient, binding: ResourceBinding): Promise<void>
  /** Read an already authorized reservation. Never mint or widen a grant. */
  readOriginalAdmission(db: ResourcePgClient, binding: ResourceBinding): Promise<ResourceAdmission>
  /** Permanently close/drain original finalization and read its authoritative
   * command ledger in THIS transaction; retained receipt/projection/Undo required.
   * A timeout, missing result, or unfenced absent row is not this evidence. */
  fenceAndReadOriginalOutcome(db: ResourcePgClient, binding: ResourceBinding): Promise<ResourceOutcome>
}
export interface ResourcePgResult { disposition: 'applied' | 'replayed' | 'disabled'; phase?: string; revision?: number }
type Row = Record<string, any>
type Context = { db: ResourcePgClient; pool: Row; owner?: Row; reservation?: Row; now: number }
const ns = 'ta_resource_reservations'
const MAX = Number.MAX_SAFE_INTEGER
const kinds: ResourceKind[] = ['intent-encoded','intent-decoded','document-fragments','effect-wire','effect-jsonb','audit-spool','storage-overhead']
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new ResourceAccountingError(code) }
function integer(value: unknown) { check(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'INVALID_RESOURCE_INTEGER'); return value }
function number(value: unknown) { const n = Number(value); return integer(n) }
function nonempty(value: unknown): asserts value is string { check(typeof value === 'string' && value.trim().length > 0, 'INVALID_RESOURCE_ID') }
function bindingCheck(b: ResourceBinding) {
  check(b && typeof b === 'object', 'INVALID_RESOURCE_BINDING')
  for (const k of ['stageId','userId','commandId','workspaceId','expectedEpoch','family','operation','principal'] as const) nonempty(b[k])
  integer(b.expectedRevision)
  check(/^[a-f0-9]{64}$/.test(b.payloadHash) && /^[a-f0-9]{64}$/.test(b.manifestSha256)
    && (b.preparedSha256 === undefined || /^[a-f0-9]{64}$/.test(b.preparedSha256))
    && b.authority && typeof b.authority === 'object' && !Array.isArray(b.authority), 'INVALID_RESOURCE_BINDING')
  check(isDeepStrictEqual(JSON.parse(JSON.stringify(b)), b), 'NON_JSON_RESOURCE_BINDING')
}
const same = (a: unknown, b: unknown, code: string) => check(isDeepStrictEqual(a,b),code)
function frozenCopy<T>(value:T):T {
  const copy=structuredClone(value)
  const freeze=(v:any)=>{if(v&&typeof v==='object'){Object.freeze(v);for(const child of Object.values(v))freeze(child)}}
  freeze(copy);return copy
}
/** Native SAVEPOINT is an exact backend transaction-state probe: outside a
 * transaction it fails 25P01 without opening one; inside it is released and the
 * caller transaction is left untouched. Never silently nest BEGIN/COMMIT. */
async function requireIdle(db:ResourcePgClient) {
  const name='ta_resource_probe_'+randomUUID().replaceAll('-','')
  try {await db.query('savepoint '+name)} catch(error) {
    if((error as {code?:string}).code==='25P01')return
    throw error
  }
  await db.query('release savepoint '+name)
  throw new ResourceAccountingError('RESOURCE_TRANSACTION_ALREADY_OPEN')
}
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const result = (r: Row, disposition: 'applied' | 'replayed'): ResourcePgResult => ({ disposition, phase:r.phase, revision:number(r.revision) })

export class PgResourceReservations {
  private constructor(readonly generation: string, readonly configuration: ResourceConfiguration, private readonly authority: ResourcePgAuthority) {}
  /** Coordinator startup/recovery: always invalidate old handles and freeze new
   * bytes before serving work. Multiple SQL sessions use the returned handle;
   * do not call start per request. Configuration is immutable, no capacity reset. */
  static async start(db: ResourcePgClient, authority: ResourcePgAuthority, configuration: ResourceConfiguration = {}): Promise<PgResourceReservations> {
    const canonical = createResourceLedger(configuration).configuration
    const generation = randomUUID(), enabled = canonical.enabled === true
    await requireIdle(db)
    await db.query('begin isolation level read committed')
    try {
      await db.query(`insert into ${ns}.pool(singleton,enabled,command_limit,owner_limit,global_limit,generation) values(true,$1,$2,$3,$4,$5) on conflict do nothing`,
        [enabled, enabled ? canonical.limits.commandBytes : null, enabled ? canonical.limits.ownerBytes : null, enabled ? canonical.limits.globalBytes : null,generation])
      const p = (await db.query(`select * from ${ns}.pool where singleton for update`)).rows[0]
      check(p.enabled === enabled && (!enabled || number(p.command_limit)===canonical.limits.commandBytes
        && number(p.owner_limit)===canonical.limits.ownerBytes && number(p.global_limit)===canonical.limits.globalBytes), 'RESOURCE_CONFIGURATION_CHANGED')
      await db.query(`update ${ns}.pool set generation=$1,inventory_verified=false,inventory_revision=null,revision=revision+1 where singleton`,[generation])
      await db.query('commit')
      return new PgResourceReservations(generation,canonical,authority)
    } catch(error) { await db.query('rollback').catch(()=>{}); throw error }
  }
  private async transaction<T>(db: ResourcePgClient, binding: ResourceBinding | undefined, operation: (c: Context)=>Promise<T>): Promise<T> {
    if (binding) bindingCheck(binding)
    await requireIdle(db)
    await db.query('begin isolation level read committed')
    try {
      if (binding) await this.authority.lockOriginalAuthority(db,binding)
      const pool = (await db.query(`select * from ${ns}.pool where singleton for update`)).rows[0]
      check(pool && pool.generation === this.generation,'STALE_RESOURCE_GENERATION')
      const c: Context = {db,pool,now:0}
      if (binding && pool.enabled) {
        await db.query(`insert into ${ns}.owner(user_id) values($1) on conflict do nothing`,[binding.userId])
        c.owner = (await db.query(`select * from ${ns}.owner where user_id=$1 for update`,[binding.userId])).rows[0]
        c.reservation = (await db.query(`select * from ${ns}.reservation where stage_id=$1 for update`,[binding.stageId])).rows[0]
        if(c.reservation) same(c.reservation.binding,binding,'RESOURCE_BINDING_MISMATCH')
        await this.authority.lockOriginalHeadStageAndValidate(db,binding)
      }
      // Trusted server clock, evaluated AFTER all authority/head/stage waits.
      c.now = number((await db.query('select floor(extract(epoch from clock_timestamp())*1000)::bigint now')).rows[0].now)
      const output = await operation(c)
      await db.query('commit')
      return output
    } catch(error) { await db.query('rollback').catch(()=>{}); throw error }
  }
  private writable(c: Context): Row {
    check(c.pool.inventory_verified,'RESOURCE_RECONCILIATION_REQUIRED')
    const r=c.reservation; check(r,'RESOURCE_BINDING_MISMATCH')
    check(r.phase==='open' && !r.writer_fence && c.now<number(r.deadline_at) && c.now<number(r.expires_at),'RESOURCE_WRITES_CLOSED')
    return r
  }
  private async bump(c: Context) {
    await c.db.query(`update ${ns}.pool set revision=revision+1 where singleton`)
    if(c.reservation) c.reservation=(await c.db.query(`update ${ns}.reservation set revision=revision+1 where stage_id=$1 returning *`,[c.reservation.stage_id])).rows[0]
  }
  private async count(c: Context, held: number, occupied: number, present: number) {
    const r=c.reservation; check(r && c.owner,'RESOURCE_BINDING_MISMATCH')
    await c.db.query(`update ${ns}.pool set held=held+$1,occupied=occupied+$2,present=present+$3 where singleton`,[held,occupied,present])
    await c.db.query(`update ${ns}.owner set held=held+$2,occupied=occupied+$3,present=present+$4 where user_id=$1`,[r.user_id,held,occupied,present])
    if(occupied || present) c.reservation=(await c.db.query(`update ${ns}.reservation set occupied=occupied+$2,present=present+$3 where stage_id=$1 returning *`,[r.stage_id,occupied,present])).rows[0]
  }
  async admit(db: ResourcePgClient, binding: ResourceBinding): Promise<ResourcePgResult> {
    binding = frozenCopy(binding)
    return this.transaction(db,binding,async c=>{
      if(!c.pool.enabled) return {disposition:'disabled'}
      const a=await this.authority.readOriginalAdmission(db,binding)
      same(a.binding,binding,'ORIGINAL_RESERVATION_BINDING_MISMATCH')
      integer(a.reservedBytes); integer(a.deadlineAt); integer(a.expiresAt); check(a.reservedBytes>0,'INVALID_RESOURCE_ADMISSION')
      if(c.reservation) {
        same([number(c.reservation.reserved),number(c.reservation.expires_at),number(c.reservation.deadline_at)],[a.reservedBytes,a.expiresAt,a.deadlineAt],'RESERVATION_IDENTITY_REUSED')
        return result(c.reservation,'replayed')
      }
      check(c.pool.inventory_verified,'RESOURCE_RECONCILIATION_REQUIRED')
      check(c.now<a.expiresAt && c.now<a.deadlineAt,'RESOURCE_ADMISSION_EXPIRED')
      check(a.reservedBytes<=number(c.pool.command_limit),'COMMAND_LIMIT_EXCEEDED')
      check(a.reservedBytes<=number(c.pool.owner_limit)-number(c.owner!.held),'OWNER_LIMIT_EXCEEDED')
      check(a.reservedBytes<=number(c.pool.global_limit)-number(c.pool.held),'GLOBAL_LIMIT_EXCEEDED')
      check(!(await db.query(`select 1 from ${ns}.reservation where user_id=$1 and command_id=$2`,[binding.userId,binding.commandId])).rows.length,'COMMAND_ID_REUSED')
      c.reservation=(await db.query(`insert into ${ns}.reservation(stage_id,user_id,command_id,binding,reserved,expires_at,deadline_at) values($1,$2,$3,$4,$5,$6,$7) returning *`,[binding.stageId,binding.userId,binding.commandId,binding,a.reservedBytes,a.expiresAt,a.deadlineAt])).rows[0]
      await this.count(c,a.reservedBytes,0,0); await this.bump(c)
      return result(c.reservation!,'applied')
    })
  }
  private async charge(c: Context, allocationId: string, kind: ResourceKind, offset: number, bytes: number, sha256: string) {
    const r=this.writable(c); nonempty(allocationId); integer(offset); integer(bytes)
    check(bytes>0 && kinds.includes(kind) && /^[a-f0-9]{64}$/.test(sha256),'INVALID_APPEND')
    let a=(await c.db.query(`select * from ${ns}.allocation where stage_id=$1 and allocation_id=$2 for update`,[r.stage_id,allocationId])).rows[0]
    if(a) check(a.kind===kind && !a.removed,'ALLOCATION_IDENTITY_REUSED')
    const prior=(await c.db.query(`select * from ${ns}.chunk where stage_id=$1 and allocation_id=$2 and byte_offset=$3`,[r.stage_id,allocationId,offset])).rows[0]
    if(prior) {
      check(number(prior.bytes)===bytes && prior.sha256===sha256,'APPEND_IDENTITY_REUSED')
      return false
    }
    check(offset===(a?number(a.next_offset):0),'APPEND_GAP_OR_OVERLAP')
    check(bytes<=number(r.reserved)-number(r.occupied) && offset<=MAX-bytes,'RESERVATION_EXCEEDED')
    if(!a) a=(await c.db.query(`insert into ${ns}.allocation(stage_id,allocation_id,kind) values($1,$2,$3) returning *`,[r.stage_id,allocationId,kind])).rows[0]
    await c.db.query(`insert into ${ns}.chunk(stage_id,allocation_id,byte_offset,bytes,sha256) values($1,$2,$3,$4,$5)`,[r.stage_id,allocationId,offset,bytes,sha256])
    await c.db.query(`update ${ns}.allocation set next_offset=next_offset+$3,occupied=occupied+$3 where stage_id=$1 and allocation_id=$2`,[r.stage_id,allocationId,bytes])
    await this.count(c,0,bytes,0); await this.bump(c)
    return true
  }
  async precharge(db: ResourcePgClient, binding: ResourceBinding, part: {allocationId:string;kind:ResourceKind;offset:number;bytes:number;sha256:string}): Promise<ResourcePgResult> {
    binding = frozenCopy(binding); part = frozenCopy(part)
    return this.transaction(db,binding,async c=>{
      if(!c.pool.enabled) return {disposition:'disabled'}
      const applied=await this.charge(c,part.allocationId,part.kind,part.offset,part.bytes,part.sha256)
      return result(c.reservation!,applied?'applied':'replayed')
    })
  }
  private async write(c: Context, allocationId: string, offset: number, input: Uint8Array) {
    const r=this.writable(c); nonempty(allocationId); integer(offset)
    const data=Buffer.from(input), digest=hash(data)
    const chunk=(await c.db.query(`select * from ${ns}.chunk where stage_id=$1 and allocation_id=$2 and byte_offset=$3 for update`,[r.stage_id,allocationId,offset])).rows[0]
    check(chunk && number(chunk.bytes)===data.length && chunk.sha256===digest,'EXACT_PRECHARGE_REQUIRED')
    const prior=(await c.db.query(`select data from ${ns}.temporary_bytes where stage_id=$1 and allocation_id=$2 and byte_offset=$3`,[r.stage_id,allocationId,offset])).rows[0]
    if(prior) check(Buffer.from(prior.data).equals(data),'PHYSICAL_APPEND_IDENTITY_REUSED')
    else {
      check(chunk.status!=='present','CONFIRMED_BYTES_MISSING')
      await c.db.query(`insert into ${ns}.temporary_bytes(stage_id,allocation_id,byte_offset,data) values($1,$2,$3,$4)`,[r.stage_id,allocationId,offset,data])
    }
    if(chunk.status==='present') return false
    await c.db.query(`update ${ns}.chunk set status='present' where stage_id=$1 and allocation_id=$2 and byte_offset=$3`,[r.stage_id,allocationId,offset])
    await c.db.query(`update ${ns}.allocation set present=present+$3 where stage_id=$1 and allocation_id=$2`,[r.stage_id,allocationId,data.length])
    await this.count(c,0,0,data.length); await this.bump(c)
    return true
  }
  async materialize(db: ResourcePgClient, binding: ResourceBinding, allocationId: string, offset: number, input: Uint8Array): Promise<ResourcePgResult> {
    binding = frozenCopy(binding)
    // Copy before awaiting locks: caller mutation cannot change admitted bytes.
    const data=Buffer.from(input)
    return this.transaction(db,binding,async c=>{
      if(!c.pool.enabled) return {disposition:'disabled'}
      const applied=await this.write(c,allocationId,offset,data)
      return result(c.reservation!,applied?'applied':'replayed')
    })
  }
  async append(db: ResourcePgClient, binding: ResourceBinding, allocationId: string, kind: ResourceKind, offset: number, input: Uint8Array): Promise<ResourcePgResult> {
    binding = frozenCopy(binding)
    const data=Buffer.from(input)
    return this.transaction(db,binding,async c=>{
      if(!c.pool.enabled) return {disposition:'disabled'}
      const charged=await this.charge(c,allocationId,kind,offset,data.length,hash(data))
      const written=await this.write(c,allocationId,offset,data)
      return result(c.reservation!,charged||written?'applied':'replayed')
    })
  }
  async beginFinalize(db: ResourcePgClient, binding: ResourceBinding, attemptId: string): Promise<ResourcePgResult> {
    binding = frozenCopy(binding)
    nonempty(attemptId)
    return this.transaction(db,binding,async c=>{
      if(!c.pool.enabled) return {disposition:'disabled'}
      const r=c.reservation; check(r,'RESOURCE_BINDING_MISMATCH')
      if(r.finalize_attempt) {check(r.finalize_attempt===attemptId,'FINALIZE_ATTEMPT_REUSED');return result(r,'replayed')}
      this.writable(c)
      c.reservation=(await db.query(`update ${ns}.reservation set phase='finalizing',finalize_attempt=$2 where stage_id=$1 returning *`,[r.stage_id,attemptId])).rows[0]
      await this.bump(c);return result(c.reservation!,'applied')
    })
  }
  async markUnknown(db: ResourcePgClient, binding: ResourceBinding, attemptId: string): Promise<ResourcePgResult> {
    binding = frozenCopy(binding)
    return this.transaction(db,binding,async c=>{
      if(!c.pool.enabled) return {disposition:'disabled'}
      const r=c.reservation;check(r && r.finalize_attempt===attemptId,'FINALIZE_ATTEMPT_REUSED')
      if(r.phase!=='finalizing') {check(['unknown','committed','not-committed','reclaiming','released'].includes(r.phase),'FINALIZE_NOT_DISPATCHED');return result(r,'replayed')}
      c.reservation=(await db.query(`update ${ns}.reservation set phase='unknown' where stage_id=$1 returning *`,[r.stage_id])).rows[0]
      await this.bump(c);return result(c.reservation!,'applied')
    })
  }
  async stop(db: ResourcePgClient, binding: ResourceBinding, reason: 'cancelled'|'expired'|'process-crash'): Promise<ResourcePgResult> {
    binding = frozenCopy(binding)
    check(['cancelled','expired','process-crash'].includes(reason),'INVALID_STOP_REASON')
    return this.transaction(db,binding,async c=>{
      if(!c.pool.enabled) return {disposition:'disabled'}
      const r=c.reservation;check(r,'RESOURCE_BINDING_MISMATCH')
      if(reason==='expired')check(c.now>=Math.min(number(r.deadline_at),number(r.expires_at)),'NOT_EXPIRED')
      if(!['open','finalizing'].includes(r.phase))return result(r,'replayed')
      c.reservation=(await db.query(`update ${ns}.reservation set phase=$2,stop_reason=$3 where stage_id=$1 returning *`,[r.stage_id,r.phase==='open'?'stopped':'unknown',reason])).rows[0]
      await this.bump(c);return result(c.reservation!,'applied')
    })
  }
  async resolve(db: ResourcePgClient, binding: ResourceBinding, expectedReservationRevision: number): Promise<ResourcePgResult> {
    binding = frozenCopy(binding)
    integer(expectedReservationRevision)
    return this.transaction(db,binding,async c=>{
      if(!c.pool.enabled) return {disposition:'disabled'}
      const r=c.reservation;check(r,'RESOURCE_BINDING_MISMATCH')
      if(r.outcome)return result(r,'replayed')
      check(number(r.revision)===expectedReservationRevision,'STALE_RESOLUTION_EVIDENCE')
      const evidence=await this.authority.fenceAndReadOriginalOutcome(db,binding)
      nonempty(evidence.fenceId)
      check(evidence.outcome==='not-committed'||evidence.outcome==='committed'&&Number.isSafeInteger(evidence.resultingRevision)
        && evidence.resultingRevision>0&&evidence.auditRetention==='original-receipt-projection-compensation-retained','ORIGINAL_AUDIT_RETENTION_REQUIRED')
      c.reservation=(await db.query(`update ${ns}.reservation set phase=$2,outcome=$3 where stage_id=$1 returning *`,[r.stage_id,evidence.outcome,evidence])).rows[0]
      await this.bump(c);return result(c.reservation!,'applied')
    })
  }
  private async inventory(db: ResourcePgClient, stageId?: string): Promise<Row[]> {
    // Entire DB-owned temporary namespace is scanned under the global write
    // fence. Digest comes from actual bytea, not a caller-provided digest list.
    return (await db.query(`with expected as (
      select c.* from ${ns}.chunk c join ${ns}.allocation a using(stage_id,allocation_id)
      where not a.removed and ($1::text is null or c.stage_id=$1)
    ), observed as (select * from ${ns}.temporary_bytes where $1::text is null or stage_id=$1)
    select coalesce(e.stage_id,o.stage_id) stage_id,coalesce(e.allocation_id,o.allocation_id) allocation_id,
      coalesce(e.byte_offset,o.byte_offset) byte_offset,
      case when e.stage_id is null then 'orphan' when o.stage_id is null then 'missing-confirmed' else 'mismatch' end code
    from expected e full join observed o using(stage_id,allocation_id,byte_offset)
    where e.stage_id is null or (o.stage_id is null and e.status='present')
       or (o.stage_id is not null and (octet_length(o.data)<>e.bytes or encode(sha256(o.data),'hex')<>e.sha256))`,[stageId??null])).rows
  }
  async beginReclaim(db: ResourcePgClient, binding: ResourceBinding, reclaimId: string, expectedReservationRevision: number): Promise<ResourcePgResult> {
    binding = frozenCopy(binding)
    nonempty(reclaimId);integer(expectedReservationRevision)
    return this.transaction(db,binding,async c=>{
      if(!c.pool.enabled)return {disposition:'disabled'}
      const r=c.reservation;check(r,'RESOURCE_BINDING_MISMATCH')
      if(r.reclaim_id){check(r.reclaim_id===reclaimId,'RECLAIM_ID_REUSED');return result(r,'replayed')}
      check(r.phase==='committed'||r.phase==='not-committed','ORIGINAL_OUTCOME_UNRESOLVED')
      check(number(r.revision)===expectedReservationRevision,'STALE_WRITER_FENCE')
      const issues=await this.inventory(db,r.stage_id)
      check(!issues.length,'RESOURCE_INVENTORY_INCONSISTENT')
      // No compliant DB writer can run across this transaction's global lock;
      // the durable fence also prevents all later stale session/retry writes.
      c.reservation=(await db.query(`update ${ns}.reservation set phase='reclaiming',reclaim_id=$2,writer_fence=$3,
        writer_fence_revision=revision,reclaim_inventory_revision=$4 where stage_id=$1 returning *`,[r.stage_id,reclaimId,randomUUID(),c.pool.revision])).rows[0]
      await this.bump(c);return result(c.reservation!,'applied')
    })
  }
  async removeAllocation(db: ResourcePgClient, binding: ResourceBinding, reclaimId: string, allocationId: string): Promise<ResourcePgResult> {
    binding = frozenCopy(binding)
    nonempty(reclaimId);nonempty(allocationId)
    return this.transaction(db,binding,async c=>{
      if(!c.pool.enabled)return {disposition:'disabled'}
      const r=c.reservation;check(r && r.reclaim_id===reclaimId&&r.writer_fence&&['reclaiming','released'].includes(r.phase),'RECLAIM_FENCE_REQUIRED')
      const a=(await db.query(`select * from ${ns}.allocation where stage_id=$1 and allocation_id=$2 for update`,[r.stage_id,allocationId])).rows[0]
      check(a,'ALLOCATION_NOT_FOUND')
      if(a.removed)return result(r,'replayed')
      // Only this table is a deletion target. No original receipt/Undo tables.
      await db.query(`delete from ${ns}.temporary_bytes where stage_id=$1 and allocation_id=$2`,[r.stage_id,allocationId])
      check(!(await db.query(`select 1 from ${ns}.temporary_bytes where stage_id=$1 and allocation_id=$2`,[r.stage_id,allocationId])).rows.length,'PHYSICAL_REMOVAL_NOT_CONFIRMED')
      await db.query(`update ${ns}.allocation set removed=true,occupied=0,present=0 where stage_id=$1 and allocation_id=$2`,[r.stage_id,allocationId])
      await this.count(c,0,-number(a.occupied),-number(a.present));await this.bump(c)
      return result(c.reservation!,'applied')
    })
  }
  async release(db: ResourcePgClient, binding: ResourceBinding, reclaimId: string): Promise<ResourcePgResult> {
    binding = frozenCopy(binding)
    nonempty(reclaimId)
    return this.transaction(db,binding,async c=>{
      if(!c.pool.enabled)return {disposition:'disabled'}
      const r=c.reservation;check(r&&r.reclaim_id===reclaimId&&r.writer_fence&&['reclaiming','released'].includes(r.phase),'RECLAIM_FENCE_REQUIRED')
      if(r.phase==='released')return result(r,'replayed')
      check(!(await db.query(`select 1 from ${ns}.allocation where stage_id=$1 and not removed limit 1`,[r.stage_id])).rows.length,'PHYSICAL_REMOVAL_NOT_CONFIRMED')
      check(!(await db.query(`select 1 from ${ns}.temporary_bytes where stage_id=$1 limit 1`,[r.stage_id])).rows.length,'PHYSICAL_REMOVAL_NOT_CONFIRMED')
      await this.count(c,-number(r.reserved),0,0)
      c.reservation=(await db.query(`update ${ns}.reservation set phase='released' where stage_id=$1 returning *`,[r.stage_id])).rows[0]
      await this.bump(c);return result(c.reservation!,'applied')
    })
  }
  /** No caller may assert completeness or supply observed entries. This method
   * owns the complete DB scan and exact current revision under the writer lock.
   * It does NOT cover filesystem/process-local buffers or old runtime storage. */
  async reconcile(db: ResourcePgClient): Promise<{verified:boolean;issues:Row[]}> {
    // Commit the freeze separately: any later scan timeout/error/connection loss
    // must leave admission disabled, not roll back to a previously verified flag.
    await this.transaction(db,undefined,async c=>{
      if(c.pool.enabled)await db.query(`update ${ns}.pool set inventory_verified=false,inventory_revision=null,revision=revision+1 where singleton`)
    })
    return this.transaction(db,undefined,async c=>{
      if(!c.pool.enabled)return {verified:false,issues:[{code:'disabled'}]}
      const issues=await this.inventory(db)
      const structure=(await db.query(`
        with ordered as (select stage_id,allocation_id,byte_offset,
          coalesce(sum(bytes) over(partition by stage_id,allocation_id order by byte_offset rows between unbounded preceding and 1 preceding),0) expected_offset
          from ${ns}.chunk)
        select 'noncontiguous-chunk' code,stage_id,allocation_id from ordered where byte_offset<>expected_offset
        union all select 'invalid-removal-phase',a.stage_id,a.allocation_id from ${ns}.allocation a join ${ns}.reservation r using(stage_id)
          where (a.removed and r.phase not in ('reclaiming','released')) or (not a.removed and r.phase='released')`)).rows
      issues.push(...structure)
      if((await db.query(`select 1 from ${ns}.owner where held>$1 limit 1`,[c.pool.owner_limit])).rows.length)issues.push({code:'owner-limit-exceeded'})
      if((await db.query(`select 1 from ${ns}.reservation where phase<>'released' and reserved>$1 limit 1`,[c.pool.command_limit])).rows.length)issues.push({code:'command-limit-exceeded'})
      const totals=(await db.query(`select coalesce(sum(case when phase='released' then 0 else reserved end),0)::text held,
        coalesce(sum(occupied),0)::text occupied,coalesce(sum(present),0)::text present from ${ns}.reservation`)).rows[0]
      if(['held','occupied','present'].some(k=>number(totals[k])!==number(c.pool[k])))issues.push({code:'global-counter-mismatch'})
      for(const {kind,id} of (await db.query(`
        select 'owner' kind,o.user_id id from ${ns}.owner o left join (
          select user_id,sum(case when phase='released' then 0 else reserved end) held,sum(occupied) occupied,sum(present) present
          from ${ns}.reservation group by user_id) r using(user_id)
          where (o.held,o.occupied,o.present) is distinct from (coalesce(r.held,0),coalesce(r.occupied,0),coalesce(r.present,0))
        union all select 'reservation',r.stage_id from ${ns}.reservation r left join (
          select stage_id,sum(occupied) occupied,sum(present) present from ${ns}.allocation group by stage_id) a using(stage_id)
          where (r.occupied,r.present) is distinct from (coalesce(a.occupied,0),coalesce(a.present,0))
        union all select 'allocation',a.stage_id||'/'||a.allocation_id from ${ns}.allocation a left join (
          select stage_id,allocation_id,sum(bytes) bytes,sum(case when status='present' then bytes else 0 end) present from ${ns}.chunk group by stage_id,allocation_id) c using(stage_id,allocation_id)
          where a.next_offset<>coalesce(c.bytes,0) or (a.occupied,a.present) is distinct from
            (case when a.removed then 0 else coalesce(c.bytes,0) end,case when a.removed then 0 else coalesce(c.present,0) end)`)).rows)issues.push({code:'counter-mismatch',kind,id})
      await db.query(`update ${ns}.pool set inventory_verified=$1,inventory_revision=revision,revision=revision+1 where singleton`,[!issues.length])
      return {verified:!issues.length,issues}
    })
  }
}

import {describe,it,expect} from 'vitest'
import {createResourceLedger,transitionResourceLedger,resourceTotals,assertResourceLedger,restoreResourceLedger,
 type ResourceAction,type ResourceBinding,type ResourceLedger,type ResourceInventoryEntry} from '../gateway/workspaceRowsResourceAccounting.js'
const hash='a'.repeat(64),other='b'.repeat(64)
const binding=(id:string,owner='u'):ResourceBinding=>({stageId:id,userId:owner,commandId:id,workspaceId:'w'+owner,expectedEpoch:'e',expectedRevision:0,
 family:'first_party_abandon',operation:'abandon_opportunity',principal:'first_party_web',authority:{},payloadHash:hash,manifestSha256:hash})
const act=(s:ResourceLedger,a:ResourceAction)=>transitionResourceLedger(s,s.revision,a,1).state
const init=()=>act(createResourceLedger({enabled:true,limits:{commandBytes:100,ownerBytes:110,globalBytes:220}}),{type:'inventory',observedRevision:0,complete:true,entries:[]})
const entries=(s:ResourceLedger):ResourceInventoryEntry[]=>s.reservations.flatMap(r=>r.allocations.filter(a=>!a.removed).flatMap(a=>a.chunks.map(c=>({stageId:r.binding.stageId,allocationId:a.allocationId,offset:c.offset,bytes:c.bytes,sha256:c.sha256}))))
function prepared(s=init(),b=binding('a'),bytes=70){
 s=act(s,{type:'admit',admission:{binding:b,reservedBytes:100,expiresAt:90,deadlineAt:80}})
 s=act(s,{type:'append',binding:b,allocationId:'payload',kind:'intent-encoded',offset:0,bytes,sha256:hash})
 s=act(s,{type:'confirm-append',binding:b,allocationId:'payload',offset:0,bytes,sha256:hash})
 return act(s,{type:'resolve',binding:b,reservationRevision:s.reservations.find(r=>r.binding.stageId===b.stageId)!.revision,
 evidence:{outcome:'committed',fenceId:'original-ledger',resultingRevision:1,auditRetention:'original-receipt-projection-compensation-retained'}})
}
function retireAction(s:ResourceLedger,b=binding('a'),bytes=10):ResourceAction{
 const control={stageId:b.stageId,allocationId:'retained-control',offset:0,bytes,sha256:other}
 return{type:'retire-to-control',binding:b,reclaimId:'reclaim-'+b.stageId,writerFenceId:'permanent-'+b.stageId,
 reservationRevision:s.reservations.find(r=>r.binding.stageId===b.stageId)!.revision,inventory:entries(s),control,observedControl:control}
}
function oracle(s:ResourceLedger){
 let H=0n,O=0n,P=0n;const owners=new Map<string,bigint>()
 for(const r of s.reservations){let control=0n,o=0n,p=0n
  expect(BigInt(r.currentHeldBytes)+BigInt(r.releasedBytes)).toBe(BigInt(r.reservedBytes))
  for(const a of r.allocations)if(!a.removed)for(const c of a.chunks){o+=BigInt(c.bytes);if(c.status==='present')p+=BigInt(c.bytes);if(a.kind==='retained-control')control+=BigInt(c.bytes)}
  expect(control).toBe(BigInt(r.retainedControlBytes));expect(p<=o&&o<=BigInt(r.currentHeldBytes)).toBe(true)
  if(r.phase==='reclaimed')expect([p,o,BigInt(r.currentHeldBytes)]).toEqual([control,control,control])
  expect(BigInt(r.peakOccupiedBytes)>=o).toBe(true);H+=BigInt(r.currentHeldBytes);O+=o;P+=p;owners.set(r.binding.userId,(owners.get(r.binding.userId)??0n)+BigInt(r.currentHeldBytes))
 }
 expect(resourceTotals(s).global).toEqual({heldBytes:Number(H),occupiedUpperBoundBytes:Number(O),confirmedPresentBytes:Number(P)})
 for(const o of resourceTotals(s).owners)expect(BigInt(o.usage.heldBytes)).toBe(owners.get(o.userId))
 assertResourceLedger(s)
}
describe('atomic retained-control reclamation (logical oracle, not native DB proof)',()=>{
 it('keeps R immutable, precharges transition peak, releases R-C once, and reuses only real capacity',()=>{
  let s=prepared();const a=retireAction(s);s=act(s,a);oracle(s)
  expect(s.reservations[0]).toMatchObject({reservedBytes:100,currentHeldBytes:10,releasedBytes:90,retainedControlBytes:10,peakOccupiedBytes:80,phase:'reclaimed'})
  expect(transitionResourceLedger(s,s.revision,a,99).state).toBe(s)
  s=prepared(s,binding('b'));oracle(s);expect(resourceTotals(s).global.heldBytes).toBe(110)
  expect(()=>prepared(s,binding('c'))).toThrow('OWNER_LIMIT_EXCEEDED')
  s=act(s,retireAction(s,binding('b')));oracle(s)
  expect(()=>prepared(s,binding('c'))).toThrow('OWNER_LIMIT_EXCEEDED') // C+C+R, not free metadata
  expect(s.reservations[0].peakOccupiedBytes).toBe(80) // peak > current H is valid
 })
 it('cannot make an original peak failure pass by deleting early or enlarging R',()=>{
  const s=prepared(undefined,undefined,95),before=JSON.stringify(s)
  expect(()=>act(s,retireAction(s))).toThrow('RESERVATION_EXCEEDED');expect(JSON.stringify(s)).toBe(before)
  expect(s.reservations[0].currentHeldBytes).toBe(100)
 })
 it('requires exact original outcome, full inventory, confirmed bytes, revision and residual identity',()=>{
  const s=prepared(),a=retireAction(s);if(a.type!=='retire-to-control')throw Error('type')
  for(const bad of [{...a,reservationRevision:0},{...a,inventory:[]},{...a,observedControl:{...a.control,sha256:hash}},{...a,control:{...a.control,bytes:0}}])expect(()=>act(s,bad)).toThrow()
  const retired=act(s,a)
  expect(()=>act(retired,{...a,reclaimId:'other'})).toThrow('RECLAIM_ID_REUSED')
  expect(()=>act(retired,{type:'append',binding:binding('a'),allocationId:'payload',kind:'intent-encoded',offset:0,bytes:70,sha256:hash})).toThrow('RESOURCE_WRITES_CLOSED')
  expect(()=>act(retired,{type:'confirm-removed',binding:binding('a'),reclaimId:'reclaim-a',allocationId:'retained-control'})).toThrow('RETAINED_CONTROL_PERMANENT')
  const restored=restoreResourceLedger(retired);expect(restored.inventoryVerified).toBe(false);oracle(restored)
  const bad=structuredClone(retired);bad.reservations[0].currentHeldBytes=0;expect(()=>assertResourceLedger(bad)).toThrow()
  const erased=structuredClone(retired);erased.reservations[0].allocations.find(a=>a.kind==='retained-control')!.removed=true;Object.assign(erased.reservations[0],{phase:'released',currentHeldBytes:0,releasedBytes:100,retainedControlBytes:0});expect(()=>restoreResourceLedger(erased)).toThrow('RETAINED_CONTROL_PERMANENT')
  const history=structuredClone(retired);history.reservations[0].allocations[0].chunks[0].bytes=101;expect(()=>restoreResourceLedger(history)).toThrow('RESERVATION_EXCEEDED')
  const peak=structuredClone(retired);peak.reservations[0].peakOccupiedBytes=10;expect(()=>restoreResourceLedger(peak)).toThrow('HISTORICAL_PEAK_MISMATCH')
  const corrupt=structuredClone(s);Object.assign(corrupt.reservations[0],{phase:'open',resolution:undefined,currentHeldBytes:90,releasedBytes:10});expect(()=>restoreResourceLedger(corrupt)).toThrow('UNFENCED_CAPACITY_RELEASE')
 })
 it('differentially checks seeded retained-control histories, replay and counter-crash snapshots',()=>{
  let seed=0x647b3bbe;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed}
  for(let run=0;run<80;run++){
   let s=init();const b=binding('a'),payload=20+rand()%65,residual=1+rand()%10;s=prepared(s,b,payload)
   const before=JSON.stringify(s),action=retireAction(s,b,residual),retired=act(s,action);oracle(retired)
   expect(JSON.stringify(s)).toBe(before) // aborted persistence preserves all old counters
   expect(transitionResourceLedger(retired,retired.revision,action,100).state).toBe(retired)
   const restored=restoreResourceLedger(retired);oracle(restored)
   expect(restored.reservations[0].peakOccupiedBytes).toBe(payload+residual)
   const next=prepared(retired,binding('b','v'),10+rand()%70);oracle(next)
   const done=act(next,retireAction(next,binding('b','v'),1+rand()%10));oracle(done)
  }
 })
 it('recomputes mixed LIVE/reclaimed owners with independent BigInt arithmetic',()=>{
  let s=init();for(const owner of ['u','v']){const b=binding(owner,owner);s=prepared(s,b,50);oracle(s);s=act(s,retireAction(s,b,5));oracle(s)}
  s=prepared(s,binding('fresh','u'),90);oracle(s)
  const live=s.reservations.find(r=>r.binding.stageId==='fresh')!;expect(live.currentHeldBytes).toBe(100)
  expect(resourceTotals(s).global.heldBytes).toBe(110)
 })
})

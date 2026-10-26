import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceRowsCandidate } from '../gateway/workspaceRowsCandidate'
import { encodeWorkspaceRows } from '../gateway/workspaceRowsCodec'
import { createSnapshot } from '../src/snapshot'
const userId='11111111-1111-1111-1111-111111111111',workspaceId='22222222-2222-2222-2222-222222222222',epoch='33333333-3333-3333-3333-333333333333'
const snapshot=createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:Array.from({length:400},(_,i)=>({id:`synthetic:${i}`,kind:'baseline_backfill' as const,category:'data' as const,source:'system' as const,occurredAt:'2030-01-01T00:00:00Z',recordedAt:'2030-01-01T00:00:00Z',title:'Synthetic bounded page'}))},'2030-01-01T00:00:00Z')
const encoded=encodeWorkspaceRows(snapshot),head={workspaceId,userId,epoch,revision:0,schemaVersion:4,format:'workspace-rows-v1',envelope:encoded.envelope,manifest:encoded.manifest}
const response=(value:unknown)=>new Response(JSON.stringify(value))
function fixture(mode:'normal'|'conflict'|'mixed'|'gap'|'empty'='normal'){
 let active=0,peak=0,aborted=0,heads=0
 const fetchImpl=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  if(String(url).endsWith('read_head'))return response(mode==='mixed'&&heads++>0?{...head,revision:1}:head)
  const q=JSON.parse(String(init?.body));active++;peak=Math.max(peak,active)
  try{
   await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,q.after_ordinal===null?8:1);init?.signal?.addEventListener('abort',()=>{clearTimeout(timer);aborted++;reject(new Error('aborted'))},{once:true})})
   if(mode==='conflict'&&q.after_ordinal!==null)return response({outcome:'CONFLICT'})
   const start=q.after_ordinal===null?0:q.after_ordinal+1
   // Force byte-short pages and out-of-order completion, not only full segments.
   const rows=encoded.rows.slice(start,start+Math.min(q.max_rows,31))
   if(mode==='gap'&&start===0)rows.shift()
   return response({outcome:'PAGE',workspaceId,epoch,revision:0,rows:mode==='empty'?[]:rows,end:start+rows.length===encoded.rows.length})
  }finally{active--}
 })
 const source=createWorkspaceRowsCandidate({supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',readsEnabled:true,readConcurrency:4,fetchImpl})
 return{source,fetchImpl,stats:()=>({active,peak,aborted})}
}
describe('row-compatible B bounded parallel read',()=>{
 it('reassembles out-of-order byte-short segments exactly with at most four requests in flight',async()=>{
  const f=fixture();expect((await f.source.read(userId))?.snapshot).toEqual(snapshot)
  expect(f.stats().peak).toBe(4);expect(f.stats().active).toBe(0)
  for(const [,init] of f.fetchImpl.mock.calls.filter(([url])=>String(url).endsWith('read_page'))){const body=JSON.parse(String(init?.body));expect(body.max_rows).toBeGreaterThan(0);expect(body.max_rows).toBeLessThanOrEqual(127);expect(init?.signal).toBeDefined()}
 })
 it.each(['conflict','mixed'] as const)('fails closed on %s generation without partial snapshot',async mode=>{
  const f=fixture(mode);await expect(f.source.read(userId)).rejects.toMatchObject({code:'CONFLICT'});expect(f.stats().active).toBe(0)
  if(mode==='conflict')expect(f.stats().aborted).toBeGreaterThan(0)
 })
 it.each(['gap','empty'] as const)('rejects %s pages instead of skipping entities',async mode=>{
  const f=fixture(mode);await expect(f.source.read(userId)).rejects.toMatchObject({code:'INVALID'});expect(f.stats().active).toBe(0)
 })
 it.each([0,5,1.5,NaN])('rejects unsupported concurrency %s before fetching',value=>{
  const fetchImpl=vi.fn();expect(()=>createWorkspaceRowsCandidate({supabaseUrl:'',serviceRoleKey:'',readsEnabled:true,readConcurrency:value,fetchImpl})).toThrow('INVALID');expect(fetchImpl).not.toHaveBeenCalled()
 })
})

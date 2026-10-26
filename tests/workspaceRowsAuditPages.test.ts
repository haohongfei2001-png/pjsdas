import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createWorkspaceRowsCandidate } from '../gateway/workspaceRowsCandidate.js'
import { withWorkspaceRowsRuntime } from '../gateway/workspaceRowsRuntime.js'
const userId='11111111-1111-4111-8111-111111111111',workspaceId='22222222-2222-4222-8222-222222222222',epoch='33333333-3333-4333-8333-333333333333'
const row={user_id:userId,workspace_id:workspaceId,command_id:'synthetic-page-command',resulting_revision:2,receipt:{contractVersion:5,unknownForward:'未来😀"\\'.repeat(200000)},compensation:{untouched:true}}
const bytes=Buffer.from(JSON.stringify(row)),document={protocol:'workspace-audit-bytes-v1',userId,workspaceId,epoch,revision:2,commandId:row.command_id,resultingRevision:2,totalBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
const descriptor={user_id:userId,workspace_id:workspaceId,command_id:row.command_id,resulting_revision:2,auditDocument:document},proof={userId,principal:'first_party_web' as const}
const head={workspaceId,userId,epoch,revision:2,format:'workspace-rows-v1',schemaVersion:4,envelope:{version:4},manifest:[]},fence={outcome:'FENCED',workspaceId,userId,epoch,revision:2}
const names=async()=>(await readdir(tmpdir())).filter(x=>x.startsWith('ta-audit-read-')).sort()
function fixture(hook?:(rpc:string,body:any,value:any)=>any,signal?:AbortSignal,pageSize=16){
 const signals:AbortSignal[]=[]
 const fetchImpl=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  signals.push(init!.signal as AbortSignal)
  const rpc=String(url).split('/').at(-1)!,body=JSON.parse(String(init?.body));let value:any
  if(rpc==='read_head')value=head
  else if(rpc==='read_history')value={outcome:'HISTORY',auditProtocol:'workspace-audit-bytes-v1',auditPageProtocol:'workspace-audit-page-v1',workspaceId,userId,epoch,revision:2,rows:[descriptor],hasMore:false}
  else if(rpc==='read_audit_fence')value=fence
  else if(rpc==='read_audit_page')value={protocol:'workspace-audit-page-v1',document,offset:body.byte_offset,fragments:Array.from({length:Math.min(pageSize,Math.ceil((bytes.length-body.byte_offset)/65536))},(_,i)=>{const offset=body.byte_offset+i*65536;return{offset,base64:bytes.subarray(offset,offset+65536).toString('base64')}})}
  else throw Error('unexpected RPC '+rpc)
  return new Response(JSON.stringify(hook?await hook(rpc,body,value):value))
 })
 const source=createWorkspaceRowsCandidate({supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',readsEnabled:true,auditReadsEnabled:true,auditPagesEnabled:true,auditReadAuthorization:proof,fetchImpl,signal})
 return{fetchImpl,signals,read:()=>source.readHistory(userId,epoch,{mode:'command',commandId:row.command_id})}
}
it.each([1,7,16])('aggregates %i original fragments per bounded page without changing exact bytes, deadline or final fences',async size=>{
 const before=await names(),signal=new AbortController().signal,f=fixture(undefined,signal,size)
 expect((await f.read()).rows).toEqual([row]);expect(await names()).toEqual(before)
 const paths=f.fetchImpl.mock.calls.map(([url])=>String(url).split('/').at(-1))
 expect(paths.filter(x=>x==='read_audit_page')).toHaveLength(Math.ceil(Math.ceil(bytes.length/65536)/size));expect(paths).not.toContain('read_audit_fragment')
 expect(paths.filter(x=>x==='read_audit_fence')).toHaveLength(2);expect(f.signals.every(x=>x===signal)).toBe(true)
})
it('requires original byte mode and defaults to no page transport',()=>{
 const options={supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic'}
 expect(()=>withWorkspaceRowsRuntime(options,{PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:'1'})).toThrow('Audit pages require')
 expect(()=>createWorkspaceRowsCandidate({...options,auditPagesEnabled:true})).toThrow()
})
it.each(['absent','wrong','empty'] as const)('requires exact page ACK even when %s and never falls back',async kind=>{
 const f=fixture((rpc,_body,v)=>rpc==='read_history'?{...v,auditPageProtocol:kind==='wrong'?'other':undefined,...(kind==='empty'?{rows:[]}: {})}:v)
 await expect(f.read()).rejects.toMatchObject({code:'INVALID'});expect(f.fetchImpl.mock.calls).toHaveLength(2)
})
it.each(['owner','workspace','epoch','revision','command','total','sha','extra-descriptor','page-offset','protocol','empty','too-many','duplicate','reordered','gap','short','bytes','base64','extra-tail','extra-field'] as const)('rejects malformed %s page and disposes provisional bytes',async kind=>{
 const before=await names(),f=fixture((rpc,body,v)=>{
  if(rpc!=='read_audit_page')return v
  if(kind==='extra-tail'&&body.byte_offset+16*65536<bytes.length)return v
  const out=structuredClone(v)
  if(kind==='owner')out.document.userId=workspaceId
  if(kind==='workspace')out.document.workspaceId=userId
  if(kind==='epoch')out.document.epoch=workspaceId
  if(kind==='revision')out.document.revision++
  if(kind==='command')out.document.commandId='foreign'
  if(kind==='total')out.document.totalBytes++
  if(kind==='sha')out.document.sha256='f'.repeat(64)
  if(kind==='extra-descriptor')out.document.unexpected=true
  if(kind==='page-offset')out.offset++
  if(kind==='protocol')out.protocol='other'
  if(kind==='empty')out.fragments=[]
  if(kind==='too-many')out.fragments.push(out.fragments[0])
  if(kind==='duplicate')out.fragments[1].offset=out.fragments[0].offset
  if(kind==='reordered')out.fragments.reverse()
  if(kind==='gap')out.fragments[1].offset++
  if(kind==='short')out.fragments[0].base64='YQ=='
  if(kind==='bytes'){const b=Buffer.from(out.fragments[0].base64,'base64');b[0]^=1;out.fragments[0].base64=b.toString('base64')}
  if(kind==='base64')out.fragments[0].base64='!!!'
  if(kind==='extra-tail')out.fragments.push({offset:Math.ceil(bytes.length/65536)*65536,base64:'YQ=='})
  if(kind==='extra-field')out.fragments[0].userId=workspaceId
  return out
 })
 await expect(f.read()).rejects.toMatchObject({code:'INVALID'});expect(await names()).toEqual(before)
})
it.each([1,2])('denies authority/generation change at final fence %i after all pages',async at=>{
 let n=0;const before=await names(),f=fixture((rpc,_body,v)=>rpc==='read_audit_fence'&&++n===at?{outcome:'CONFLICT'}:v)
 await expect(f.read()).rejects.toMatchObject({code:'CONFLICT'});expect(await names()).toEqual(before)
})
it('abort after the first full page cannot consume its buffered fragments or return partial history',async()=>{
 const before=await names(),controller=new AbortController(),f=fixture((rpc,_body,v)=>{if(rpc==='read_audit_page')controller.abort();return v},controller.signal)
 await expect(f.read()).rejects.toThrow();expect(await names()).toEqual(before)
})
it('verified per-request reuse still negotiates and authorizes twice, but does not download pages again',async()=>{
 const f=fixture();await f.read();const count=()=>f.fetchImpl.mock.calls.filter(([url])=>String(url).endsWith('read_audit_page')).length,n=count()
 expect((await f.read()).rows).toEqual([row]);expect(count()).toBe(n);expect(f.fetchImpl.mock.calls.filter(([url])=>String(url).endsWith('read_audit_fence'))).toHaveLength(4)
})

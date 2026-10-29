import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createWorkspaceRowsCandidate } from '../gateway/workspaceRowsCandidate'
import { boundedAuditResponse } from '../gateway/workspaceRowsAuditSpool'
import { encodeWorkspaceRows } from '../gateway/workspaceRowsCodec'
import { createSnapshot } from '../src/snapshot'

const userId='11111111-1111-4111-8111-111111111111',workspaceId='22222222-2222-4222-8222-222222222222',epoch='33333333-3333-4333-8333-333333333333'
const authorization={userId,principal:'first_party_web' as const}
const encoded=encodeWorkspaceRows(createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[]},'2030-01-01T00:00:00Z'))
const head={workspaceId,userId,epoch,revision:2,schemaVersion:4,format:'workspace-rows-v1',envelope:encoded.envelope,manifest:encoded.manifest}
const row={workspace_id:workspaceId,user_id:userId,command_id:'synthetic-original',resulting_revision:1,operation:'opportunity_management',status:'COMMITTED',payload_hash:'a'.repeat(64),
 receipt:{contractVersion:5,unknownForwardField:{unicode:'未来😀"\\'.repeat(220_000),empty:[],optional:null},projectionDelta:{unknown:'preserved'}},compensation:{original:['untouched',null],unknown:{future:true}}}
const bytes=Buffer.from(JSON.stringify(row)),sha256=createHash('sha256').update(bytes).digest('hex')
const document={protocol:'workspace-audit-bytes-v1',workspaceId,userId,epoch,revision:2,commandId:row.command_id,resultingRevision:1,totalBytes:bytes.length,sha256}
const descriptor={workspace_id:workspaceId,user_id:userId,command_id:row.command_id,resulting_revision:1,auditDocument:document}
const fence={outcome:'FENCED',workspaceId,userId,epoch,revision:2}
const names=async()=>(await readdir(tmpdir())).filter(x=>x.startsWith('ta-audit-read-')).sort()
type Hook=(rpc:string,body:Record<string, unknown>,value:Record<string, unknown>)=>Record<string, unknown>|Promise<Record<string, unknown>>
function fixture(hook?:Hook,enabled=true,signal?:AbortSignal){
 const signals:AbortSignal[]=[]
 const fetchImpl=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  const rpc=String(url).split('/').at(-1)!,body=JSON.parse(String(init?.body));signals.push(init!.signal!)
  init!.signal!.throwIfAborted()
  let value:Record<string,unknown>
  if(rpc==='read_head')value=head
  else if(rpc==='read_history')value={outcome:'HISTORY',auditProtocol:'workspace-audit-bytes-v1',workspaceId,userId,epoch,revision:2,rows:[descriptor],hasMore:false}
  else if(rpc==='read_audit_fence')value=fence
  else if(rpc==='read_audit_fragment'){const offset=body.byte_offset;value={...document,documentKey:row.command_id,offset,base64:bytes.subarray(offset,offset+65536).toString('base64')}}
  else throw Error('unexpected RPC '+rpc)
  return new Response(JSON.stringify(hook?await hook(rpc,body,value):value))
 })
 const source=createWorkspaceRowsCandidate({supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',readsEnabled:true,auditReadsEnabled:enabled,auditReadAuthorization:authorization,fetchImpl,signal})
 return {source,fetchImpl,signals,read:()=>source.readHistory(userId,epoch,{mode:'command',commandId:row.command_id})}
}
it('actual history reader materializes complete UTF8/unknown V5 fields only after verified bounded spool and both final fences',async()=>{
 expect(bytes.length).toBeGreaterThan(2097152)
 const before=await names(),f=fixture(),result=await f.read()
 expect(result.rows).toEqual([row]);expect(await names()).toEqual(before)
 const rpcs=f.fetchImpl.mock.calls.map(([url])=>String(url).split('/').at(-1))
 expect(rpcs.filter(rpc=>rpc==='read_audit_fragment').length).toBe(Math.ceil(bytes.length/65536))
 expect(rpcs.at(-1)).toBe('read_audit_fence');expect(rpcs.filter(rpc=>rpc==='read_audit_fence')).toHaveLength(2)
 expect(new Set(f.signals).size).toBe(1)
})
it('new byte route stays off and refuses descriptors without making any byte request',async()=>{
 const f=fixture(undefined,false);await expect(f.read()).rejects.toMatchObject({code:'INVALID'})
 expect(f.fetchImpl.mock.calls).toHaveLength(2)
})
it('requires the actual history server to acknowledge the exact protocol even for an empty lookup',async()=>{
 const f=fixture((rpc,_body,value)=>{if(rpc!=='read_history')return value;const {auditProtocol:_ignored,...old}=value;return {...old,rows:[]}})
 await expect(f.read()).rejects.toMatchObject({code:'INVALID'});expect(f.fetchImpl.mock.calls).toHaveLength(2)
})
it('copies original proof before awaits rather than allowing callers to replace a grant',async()=>{
 const sourceAuthorization={userId,principal:'delegated_mcp' as const,family:'opportunity_v3' as const,grantId:workspaceId,grantRevision:1,clientId:'synthetic-original-client'}
 const sent:unknown[]=[]
 const source=createWorkspaceRowsCandidate({supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',readsEnabled:true,auditReadsEnabled:true,auditReadAuthorization:sourceAuthorization,
  fetchImpl:async(url,init)=>{const rpc=String(url).split('/').at(-1),body=JSON.parse(String(init?.body));
   if(rpc==='read_head'){sourceAuthorization.grantRevision=99;return Response.json(head)}
   if(rpc==='read_history'){sent.push(body.query.auditAuthorization);return Response.json({outcome:'HISTORY',auditProtocol:'workspace-audit-bytes-v1',workspaceId,userId,epoch,revision:2,rows:[],hasMore:false})}
   sent.push(body.proof);return Response.json(fence)
  }})
 await source.readHistory(userId,epoch,{mode:'command',commandId:'synthetic-missing'});expect(sent).toHaveLength(2)
 for(const proof of sent)expect(proof).toMatchObject({grantRevision:1,clientId:'synthetic-original-client'})
})
it('same request reuses only the last exact verified document after fresh authorization/descriptor/generation fences',async()=>{
 const f=fixture(),first=await f.read(),fragments=()=>f.fetchImpl.mock.calls.filter(([url])=>String(url).endsWith('read_audit_fragment')).length
 const n=fragments();(first.rows[0].receipt as Record<string,unknown>).unknownForwardField='caller mutation'
 expect((await f.read()).rows).toEqual([row]);expect(fragments()).toBe(n)
 expect(f.fetchImpl.mock.calls.filter(([url])=>String(url).endsWith('read_audit_fence')).length).toBe(4)
})
it('cached bytes cannot skip a revoked final authority or different descriptor',async()=>{
 let denied=false,changed=false
 const f=fixture((rpc,_body,value)=>{
  if(denied&&rpc==='read_audit_fence')return {outcome:'CONFLICT'}
  if(changed&&rpc==='read_history')return {...value,rows:[{...descriptor,auditDocument:{...document,sha256:'f'.repeat(64)}}]}
  return value
 })
 await f.read();denied=true;await expect(f.read()).rejects.toMatchObject({code:'CONFLICT'})
 denied=false;changed=true;await expect(f.read()).rejects.toMatchObject({code:'INVALID'})
})
it.each(['owner','workspace','epoch','revision','command','total','sha','offset','base64','short','bytes','final-fence','post-materialize-fence'] as const)('discards every provisional byte after %s corruption',async kind=>{
 const before=await names();let fences=0
 const f=fixture((rpc,body,value)=>{
  if(rpc==='read_audit_fence'&&++fences===(kind==='post-materialize-fence'?2:1)&&kind.includes('fence'))return {outcome:'CONFLICT'}
  if(rpc!=='read_audit_fragment'||body.byte_offset!==65536)return value
  const v={...value}
  if(kind==='owner')v.userId=workspaceId
  if(kind==='workspace')v.workspaceId=userId
  if(kind==='epoch')v.epoch=workspaceId
  if(kind==='revision')v.revision=3
  if(kind==='command')v.documentKey='foreign'
  if(kind==='total')v.totalBytes=Number(v.totalBytes)+1
  if(kind==='sha')v.sha256='f'.repeat(64)
  if(kind==='offset')v.offset=65537
  if(kind==='base64')v.base64='!!!'
  if(kind==='short')v.base64=Buffer.from('short').toString('base64')
  if(kind==='bytes'){const b=Buffer.from(String(v.base64),'base64');b[0]^=1;v.base64=b.toString('base64')}
  return v
 })
 await expect(f.read()).rejects.toMatchObject({code:kind.includes('fence')?'CONFLICT':'INVALID'});expect(await names()).toEqual(before)
})
it('the unchanged aggregate capability is checked before allocating a spool or fetching bytes',async()=>{
 const before=await names(),f=fixture((rpc,_body,value)=>rpc==='read_history'?{...value,rows:[{...descriptor,auditDocument:{...document,totalBytes:33_554_432}}]}:value)
 await expect(f.read()).rejects.toMatchObject({code:'INVALID'});expect(f.fetchImpl.mock.calls).toHaveLength(2);expect(await names()).toEqual(before)
})
it.each(['start','fragment','fence'] as const)('caller cancellation at %s discards complete/partial provisional bytes',async when=>{
 const before=await names(),controller=new AbortController(),f=fixture((rpc,body,value)=>{
  if(when==='fragment'&&rpc==='read_audit_fragment'&&body.byte_offset===65536||when==='fence'&&rpc==='read_audit_fence')controller.abort()
  return value
 },true,controller.signal)
 if(when==='start')controller.abort()
 await expect(f.read()).rejects.toThrow();expect(await names()).toEqual(before)
})
it('bounds a dishonest/chunked HTTP body before JSON parsing and cancels its reader',async()=>{
 let cancelled=false
 const response=new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(1_048_576))},cancel(){cancelled=true}}),{headers:{'content-length':'1'}})
 await expect(boundedAuditResponse(response,new AbortController().signal)).rejects.toThrow('AUDIT_RESPONSE_TOO_LARGE');expect(cancelled).toBe(true)
})

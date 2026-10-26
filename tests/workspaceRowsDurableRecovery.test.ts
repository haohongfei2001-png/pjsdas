import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceRowsStagedBridge, stagedCommandStageId, type StagedBridgeOptions } from '../gateway/workspaceRowsStagedBridge.js'
import { encodePreparedIntent, decodePreparedIntent, prepareAuditModeDocuments, selectDurableAuditDocuments, type DurablePreparedIntent, type WorkspaceRowsAuditMode } from '../gateway/workspaceRowsDurableIntent.js'
import * as documents from '../gateway/workspaceRowsStagedDocumentsPrototype.js'
import { diffReadableWorkspaceRows, encodeWorkspaceRows } from '../gateway/workspaceRowsCodec.js'
import * as effects from '../gateway/workspaceRowsLargeCommandPrototype.js'
import { largeAbandonFixture } from './fixtures/workspaceRowsLargeCommand.js'

const userId='11111111-1111-4111-8111-111111111111',workspaceId='22222222-2222-4222-8222-222222222222',epoch='33333333-3333-4333-8333-333333333333'
const proof={userId,principal:'first_party_web' as const}
const options={supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',readsEnabled:true,writesEnabled:true,rpcTransport:'public-v1' as const,durableIntent:true,auditReadAuthorization:proof}
const modes:WorkspaceRowsAuditMode[]=['legacy-inline-v1','fragments-v1','pages-v1']
const f=largeAbandonFixture()
function fixture(mode:WorkspaceRowsAuditMode,undo=false){
 const before={userId,workspaceId,rowEpoch:epoch,revision:undo?1:0,schemaVersion:4,snapshot:undo?f.result.snapshot:f.before}
 const input={userId,commandId:undo?'synthetic-original-undo':f.command.commandId,operation:undo?'undo_command':'domain:abandon_opportunity',payloadHash:'b'.repeat(64),expectedRevision:before.revision,principalKind:'first_party_web' as const,schemaVersion:4,snapshot:undo?f.undo:f.result.snapshot,
  compensation:undo?null:f.result.compensation as unknown as Record<string,unknown>,provenance:undo?{undoOf:f.command.commandId}:{},effectiveTime:f.at,
  receiptContext:{contractVersion:5,projectionDelta:{unknownFuture:['未来😀','\u0000',{keep:true}]}}}
 const delta=diffReadableWorkspaceRows(before.snapshot,input.snapshot),preparedEffects=effects.prepareStagedEffects(delta)
 const {changes:_changes,...envelopes}=delta
 const metadata={...envelopes,commandId:input.commandId,payloadHash:input.payloadHash,operation:input.operation,principal:input.principalKind,workspaceId,userId,expectedEpoch:epoch,expectedRevision:before.revision,schemaVersion:input.snapshot.version,compensation:input.compensation,provenance:input.provenance,receiptContext:input.receiptContext,effectiveTime:input.effectiveTime}
 const binding={stageId:stagedCommandStageId(metadata,'first_party_abandon'),family:'first_party_abandon',userId,workspaceId,expectedEpoch:epoch,expectedRevision:before.revision,commandId:input.commandId,payloadHash:input.payloadHash,operation:input.operation,principal:input.principalKind,authority:{}}
 const chain={protocol:'workspace-effect-chain-v1' as const,count:preparedEffects.parts.length,sha256:preparedEffects.finalDigest}
 // Independent baseline oracle: exact 103d8c9 metadata construction, NOT the
 // new selector/helper. This proves recovery of old persisted manifest bytes.
 const prepared=documents.prepareStagedRequestDocuments({...metadata,
  ...(mode!=='legacy-inline-v1'?{auditReadProtocol:'workspace-audit-bytes-v1',...(mode==='pages-v1'?{auditReadPageProtocol:'workspace-audit-page-v1'}:{})}:{})},binding,chain)
 const saved:DurablePreparedIntent={protocol:'workspace-prepared-intent-v1',before,input,manifestSha256:prepared.manifest.sha256,deadlineAt:Date.now()+10000}
 const encoded=encodePreparedIntent(saved)
 const stored={encoded,reservedBytes:encoded.bytes,deadlineAt:saved.deadlineAt,binding:{...binding,preparedSha256:encoded.sha256,manifestSha256:saved.manifestSha256}}
 return{before,input,metadata,binding,chain,prepared,saved,stored}
}
function transport(h:ReturnType<typeof fixture>,hook?:(path:string,body:any)=>Response|undefined){
 const paths:string[]=[],signals:AbortSignal[]=[],bodies:any[]=[]
 const offsets={metadata:0,beforeEnvelope:0,afterEnvelope:0,compensation:0}
 const fetchImpl=vi.fn<typeof fetch>(async(url,init)=>{
  const path=String(url).split('_v1_').at(-1)!,body=JSON.parse(String(init?.body));paths.push(path);signals.push(init!.signal as AbortSignal);bodies.push(body)
  const overridden=hook?.(path,body);if(overridden)return overridden
  if(path==='large_intent_read')return Response.json(h.stored)
  if(path==='large_documents_check_reservation')return Response.json(true)
  if(path==='large_documents_begin'){
   expect(body.manifest_sha256).toBe(h.saved.manifestSha256)
   expect(body.manifest_wire).toBe(h.prepared.manifestWire)
   return Response.json({stageId:h.binding.stageId,manifestSha256:h.saved.manifestSha256,completed:false,nextOffsets:offsets})
  }
  if(path==='large_documents_append'){
   const part=body.part;offsets[part.document as keyof typeof offsets]=part.offset+Buffer.from(part.base64,'base64').length
   return Response.json({stageId:h.binding.stageId,manifestSha256:h.saved.manifestSha256,document:part.document,nextOffset:offsets[part.document as keyof typeof offsets]})
  }
  if(path==='large_append')return Response.json({})
  if(path==='large_documents_finish')return Response.json({outcome:'COMMITTED',revision:h.before.revision+1,receipt:{...h.input.receiptContext,commandId:h.input.commandId,operation:h.input.operation,status:'COMMITTED',revision:h.before.revision+1}})
  if(path==='read_head'){const e=encodeWorkspaceRows(h.before.snapshot);return Response.json({workspaceId,userId,epoch,revision:h.before.revision,schemaVersion:4,format:'workspace-rows-v1',envelope:e.envelope,manifest:e.manifest})}
  if(path==='read_history')return Response.json({outcome:'HISTORY',workspaceId,userId,epoch,revision:h.before.revision,auditProtocol:body.query.auditProtocol,auditPageProtocol:body.query.auditPageProtocol,rows:[{user_id:userId,workspace_id:workspaceId,command_id:f.command.commandId,resulting_revision:1,receipt:{operation:'domain:abandon_opportunity'}}],hasMore:false})
  if(path==='read_audit_fence')return Response.json({outcome:'FENCED',workspaceId,userId,epoch,revision:h.before.revision})
  throw Error('unexpected RPC '+path)
 })
 return{fetchImpl,paths,signals,bodies}
}
afterEach(()=>vi.restoreAllMocks())
describe('original complete v1 audit-mode recovery',()=>{
 it('binds distinct known metadata shapes to distinct exact hashes without changing original documents',()=>{
  const h=fixture('legacy-inline-v1'),original=JSON.stringify(h.metadata)
  const prepared=modes.map(mode=>prepareAuditModeDocuments(h.metadata,h.binding,h.chain,mode))
  expect(new Set(prepared.map(p=>p.manifest.sha256)).size).toBe(3)
  for(let i=0;i<modes.length;i++){
   const selected=selectDurableAuditDocuments(h.metadata,h.binding,h.chain,prepared[i].manifest.sha256)
   expect(selected.mode).toBe(modes[i]);expect(selected.prepared.manifestWire).toBe(prepared[i].manifestWire)
   expect(selected.prepared.manifest.documents.slice(1)).toEqual(prepared[0].manifest.documents.slice(1))
  }
  expect(JSON.stringify(h.metadata)).toBe(original)
 })
 it('rejects an unknown or ambiguous original hash rather than selecting the preferred mode',()=>{
  const h=fixture('pages-v1')
  expect(()=>selectDurableAuditDocuments(h.metadata,h.binding,h.chain,'f'.repeat(64))).toThrow('Invalid durable prepared intent')
  vi.spyOn(documents,'prepareStagedRequestDocuments').mockReturnValue(h.prepared)
  expect(()=>selectDurableAuditDocuments(h.metadata,h.binding,h.chain,h.saved.manifestSha256)).toThrow('Invalid durable prepared intent')
 })
 it.each(modes.flatMap(mode=>[false,true].flatMap(pages=>[false,true].map(stopNew=>({mode,pages,stopNew})))) )('recovers $mode with current pages=$pages stopNew=$stopNew and one bound effect chain',async({mode,pages,stopNew})=>{
  const h=fixture(mode),original=JSON.stringify(h.stored),t=transport(h),prepare=vi.spyOn(effects,'prepareStagedEffects')
  const result=await createWorkspaceRowsStagedBridge({...options,auditReadsEnabled:true,auditPagesEnabled:pages,auditAdmissionMode:pages?'pages-v1':'fragments-v1',durableIntentAdmissionEnabled:!stopNew,fetchImpl:t.fetchImpl}).rowLayoutWriter!.resumePrepared!(h.before,h.input)
  expect(result?.outcome).toBe('COMMITTED');expect(result?.snapshot).toEqual(h.input.snapshot)
  expect(result?.receipt).toMatchObject(h.input.receiptContext);expect(prepare).toHaveBeenCalledTimes(1)
  expect(t.paths).not.toContain('large_intent_admit');expect(t.paths).not.toContain('commit_authoritative')
  expect(t.paths.filter(p=>p==='large_documents_finish')).toHaveLength(1);expect(JSON.stringify(h.stored)).toBe(original)
 })
 it.each(modes)('recovers $0 with both new audit flags off and new durable admission stopped',async mode=>{
  const h=fixture(mode),t=transport(h)
  const bridge=createWorkspaceRowsStagedBridge({...options,auditReadsEnabled:false,auditPagesEnabled:false,durableIntentAdmissionEnabled:false,fetchImpl:t.fetchImpl})
  expect((await bridge.rowLayoutWriter!.resumePrepared!(h.before,h.input))?.outcome).toBe('COMMITTED')
  expect(t.paths).not.toContain('large_intent_admit')
  const newTransport=transport(h)
  await expect(createWorkspaceRowsStagedBridge({...options,durableIntentAdmissionEnabled:false,fetchImpl:newTransport.fetchImpl}).rowLayoutWriter!.commit(h.before,h.input)).rejects.toMatchObject({code:'WORKSPACE_UNAVAILABLE'})
  expect(newTransport.paths).toEqual([])
 })
 it.each(modes)('original Undo adopts selected $0 reader and shares its unextended original signal',async mode=>{
  const h=fixture(mode,true),t=transport(h),originalDeadline=h.saved.deadlineAt
  const timeout=vi.spyOn(AbortSignal,'timeout')
  const result=await createWorkspaceRowsStagedBridge({...options,auditReadsEnabled:mode==='legacy-inline-v1',auditPagesEnabled:mode==='legacy-inline-v1',fetchImpl:t.fetchImpl}).rowLayoutWriter!.resumePrepared!(h.before,h.input)
  expect(result?.outcome).toBe('COMMITTED');expect(h.saved.deadlineAt).toBe(originalDeadline)
  const query=t.bodies[t.paths.indexOf('read_history')].query
  expect(query.auditProtocol).toBe(mode==='legacy-inline-v1'?undefined:'workspace-audit-bytes-v1')
  expect(query.auditPageProtocol).toBe(mode==='pages-v1'?'workspace-audit-page-v1':undefined)
  const first=t.paths.indexOf('read_head'),signal=t.signals[first]
  expect(t.signals.slice(first).every(s=>s===signal)).toBe(true)
  expect(timeout.mock.calls.every(([ms])=>ms>0&&ms<=10000)).toBe(true)
 })
 it('fails closed before upload if selected page Undo lacks its ACK, even when current admission prefers fragments',async()=>{
  const h=fixture('pages-v1',true),t=transport(h,(path)=>path==='read_history'?Response.json({outcome:'HISTORY',workspaceId,userId,epoch,revision:1,auditProtocol:'workspace-audit-bytes-v1',rows:[],hasMore:false}):undefined)
  await expect(createWorkspaceRowsStagedBridge({...options,auditReadsEnabled:true,auditPagesEnabled:false,fetchImpl:t.fetchImpl}).rowLayoutWriter!.resumePrepared!(h.before,h.input)).rejects.toMatchObject({code:'WORKSPACE_INVALID'})
  expect(t.paths).toEqual(['large_intent_read','read_head','read_history'])
 })
 it.each(['manifest','deadline','owner','grant','reservation','compressed'] as const)('refuses altered original $0 before upload',async kind=>{
  const h=fixture('pages-v1')
  if(kind==='manifest'){h.saved.manifestSha256='e'.repeat(64);h.stored.binding.manifestSha256=h.saved.manifestSha256;h.stored.encoded=encodePreparedIntent(h.saved);h.stored.binding.preparedSha256=h.stored.encoded.sha256;h.stored.reservedBytes=h.stored.encoded.bytes}
  if(kind==='deadline')h.stored.deadlineAt=Date.now()-1
  if(kind==='owner')h.stored.binding.userId=workspaceId
  if(kind==='grant')h.stored.binding.authority={grantId:workspaceId}
  if(kind==='reservation')h.stored.reservedBytes=1
  if(kind==='compressed')h.stored.encoded.compressedSha256='0'.repeat(64)
  const t=transport(h)
  await expect(createWorkspaceRowsStagedBridge({...options,auditReadsEnabled:true,fetchImpl:t.fetchImpl}).rowLayoutWriter!.resumePrepared!(h.before,h.input)).rejects.toBeDefined()
  expect(t.paths).toEqual(['large_intent_read'])
 })
 it.each([
  {mode:'legacy-inline-v1' as const,auditReadsEnabled:false,auditPagesEnabled:false,auditAdmissionMode:undefined},
  {mode:'fragments-v1' as const,auditReadsEnabled:true,auditPagesEnabled:true,auditAdmissionMode:'fragments-v1' as const},
  {mode:'pages-v1' as const,auditReadsEnabled:true,auditPagesEnabled:false,auditAdmissionMode:'pages-v1' as const},
 ])('new $mode admission is independent of read preference and keeps original complete bytes',async profile=>{
  const h=fixture(profile.mode);let admitted:DurablePreparedIntent|undefined
  const t=transport(h,(path,body)=>{
   if(path!=='large_intent_admit')return
   admitted=decodePreparedIntent(body.encoded,body.encoded.bytes)
   expect(admitted.input).toEqual(h.input);expect(admitted.before).toEqual(h.before)
   expect(admitted.manifestSha256).toBe(h.prepared.manifest.sha256)
   return Response.json({encoded:body.encoded,reservedBytes:body.encoded.bytes,deadlineAt:body.deadline_at,binding:body.binding})
  })
  expect((await createWorkspaceRowsStagedBridge({...options,...profile,fetchImpl:t.fetchImpl}).rowLayoutWriter!.commit(h.before,h.input)).outcome).toBe('COMMITTED')
  expect(admitted).toBeDefined();expect(t.paths.filter(p=>p==='large_intent_admit')).toHaveLength(1)
  const metadata=t.bodies.filter((body,index)=>t.paths[index]==='large_documents_append'&&body.part.document==='metadata').map(body=>Buffer.from(body.part.base64,'base64'))
  const uploaded=JSON.parse(Buffer.concat(metadata).toString('utf8'))
  expect(uploaded.auditReadProtocol).toBe(profile.mode==='legacy-inline-v1'?undefined:'workspace-audit-bytes-v1')
  expect(uploaded.auditReadPageProtocol).toBe(profile.mode==='pages-v1'?'workspace-audit-page-v1':undefined)
 })
 it('rejects injected unknown/inline admission modes instead of interpreting them as false',()=>{
  for(const mode of ['legacy-inline-v1','pages-v2',''])expect(()=>createWorkspaceRowsStagedBridge({...options,auditReadsEnabled:true,auditAdmissionMode:mode as StagedBridgeOptions['auditAdmissionMode']})).toThrow('known complete audit')
 })
})

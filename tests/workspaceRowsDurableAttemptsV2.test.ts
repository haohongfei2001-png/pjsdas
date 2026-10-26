import {afterEach,describe,expect,it,vi} from 'vitest'
import {encodePreparedIntent,decodePreparedIntent,prepareAuditModeDocuments,type DurablePreparedIntentV2} from '../gateway/workspaceRowsDurableIntent.js'
import {createWorkspaceRowsStagedBridge,stagedCommandStageId} from '../gateway/workspaceRowsStagedBridge.js'
import {diffReadableWorkspaceRows} from '../gateway/workspaceRowsCodec.js'
import {prepareStagedEffects} from '../gateway/workspaceRowsLargeCommandPrototype.js'
import {largeAbandonFixture} from './fixtures/workspaceRowsLargeCommand.js'
import {withWorkspaceRowsRuntime} from '../gateway/workspaceRowsRuntime.js'
const userId='11111111-1111-4111-8111-111111111111',workspaceId='22222222-2222-4222-8222-222222222222',epoch='33333333-3333-4333-8333-333333333333'
const options={supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',readsEnabled:true,writesEnabled:true,rpcTransport:'public-v1' as const,durableIntent:true,durableAttemptsV2:true}
const f=largeAbandonFixture()
function fixture(){
 const before={userId,workspaceId,rowEpoch:epoch,revision:0,schemaVersion:4,snapshot:f.before}
 const input={userId,commandId:f.command.commandId,operation:'domain:abandon_opportunity',payloadHash:'b'.repeat(64),expectedRevision:0,principalKind:'first_party_web' as const,schemaVersion:4,snapshot:f.result.snapshot,
  compensation:f.result.compensation as unknown as Record<string,unknown>,provenance:{},effectiveTime:f.at,receiptContext:{contractVersion:5,unknownFuture:['未来😀','\u0000',{keep:true}]}}
 const {changes,...envelopes}=diffReadableWorkspaceRows(before.snapshot,input.snapshot),effects=prepareStagedEffects({changes,...envelopes})
 const metadata={...envelopes,commandId:input.commandId,payloadHash:input.payloadHash,operation:input.operation,principal:input.principalKind,workspaceId,userId,expectedEpoch:epoch,expectedRevision:0,schemaVersion:4,compensation:input.compensation,provenance:input.provenance,receiptContext:input.receiptContext,effectiveTime:input.effectiveTime}
 const binding={stageId:stagedCommandStageId(metadata,'first_party_abandon'),family:'first_party_abandon',userId,workspaceId,expectedEpoch:epoch,expectedRevision:0,commandId:input.commandId,payloadHash:input.payloadHash,operation:input.operation,principal:input.principalKind,authority:{}}
 const prepared=prepareAuditModeDocuments(metadata,binding,{protocol:'workspace-effect-chain-v1',count:effects.parts.length,sha256:effects.finalDigest},'legacy-inline-v1')
 const saved:DurablePreparedIntentV2={protocol:'workspace-prepared-intent-v2',before,input,manifestSha256:prepared.manifest.sha256}
 const encoded=encodePreparedIntent(saved)
 return{before,input,saved,stored:{protocol:saved.protocol,encoded,reservedBytes:encoded.bytes,deadlineAt:null,binding:{...binding,preparedSha256:encoded.sha256,manifestSha256:saved.manifestSha256}}}
}
afterEach(()=>vi.restoreAllMocks())
describe('durable intent v2 separates immutable bytes from DB execution attempt',()=>{
 it('preserves v1 bytes and rejects a v2 bundle carrying any legacy deadline',()=>{
  const h=fixture(),e=encodePreparedIntent(h.saved)
  expect(decodePreparedIntent(e,e.bytes)).toEqual(h.saved)
  expect(Object.hasOwn(decodePreparedIntent(e,e.bytes),'deadlineAt')).toBe(false)
  const old={...h.saved,protocol:'workspace-prepared-intent-v1' as const,deadlineAt:1},oldEncoded=encodePreparedIntent(old)
  expect(decodePreparedIntent(oldEncoded,oldEncoded.bytes)).toEqual(old)
  const changed=encodePreparedIntent({...h.saved,deadlineAt:1} as never)
  expect(()=>decodePreparedIntent(changed,changed.bytes)).toThrow()
 })
 it('keeps v2 independently default-off and rejects capability without durable recovery',()=>{
  expect(()=>withWorkspaceRowsRuntime(options,{PJSDAS_WORKSPACE_ROWS_DURABLE_ATTEMPTS_V2:'1'})).toThrow('requires durable intent')
  expect(()=>createWorkspaceRowsStagedBridge({...options,durableIntent:false})).toThrow('requires durable intent')
 })
 it('recognizes a DB-fenced terminal outcome before decode or upload',async()=>{
  const h=fixture(),fetchImpl=vi.fn(async()=>Response.json({outcome:'TERMINAL_UNCOMMITTED',reason:'LEGACY_INTENT_EXPIRED'}))
  await expect(createWorkspaceRowsStagedBridge({...options,fetchImpl}).rowLayoutWriter!.resumePrepared!(h.before,h.input)).rejects.toMatchObject({code:'WORKSPACE_RECOVERY_TERMINAL',retryable:false})
  expect(fetchImpl).toHaveBeenCalledTimes(1)
 })
 it('uses one exact DB attempt and monotonic remaining budget despite a distant worker wall clock',async()=>{
  const h=fixture(),paths:string[]=[],claims:unknown[]=[],signals:AbortSignal[]=[],attempt={id:'44444444-4444-4444-8444-444444444444',generation:8,deadlineAt:1}
  const offsets={metadata:0,beforeEnvelope:0,afterEnvelope:0,compensation:0}
  vi.spyOn(Date,'now').mockReturnValue(8_000_000_000_000)
  const fetchImpl=vi.fn<typeof fetch>(async(url,init)=>{
   const path=String(url).split('_v1_').at(-1)!,body=JSON.parse(String(init?.body));paths.push(path)
   if(path==='large_v2_intent_read')return Response.json(h.stored)
   if(path==='large_v2_attempt_begin')return Response.json({attempt,remainingMs:10000})
   claims.push(body.attempt);signals.push(init!.signal as AbortSignal)
   if(path==='large_v2_documents_check_reservation')return Response.json(true)
   if(path==='large_v2_documents_begin')return Response.json({stageId:h.stored.binding.stageId,manifestSha256:h.saved.manifestSha256,completed:false,nextOffsets:offsets})
   if(path==='large_v2_documents_append'){
    const p=body.part;offsets[p.document as keyof typeof offsets]=p.offset+Buffer.from(p.base64,'base64').length
    return Response.json({stageId:p.stageId,manifestSha256:p.manifestSha256,document:p.document,nextOffset:offsets[p.document as keyof typeof offsets]})
   }
   if(path==='large_v2_append')return Response.json({})
   if(path==='large_v2_documents_finish')return Response.json({outcome:'COMMITTED',revision:1,receipt:{...h.input.receiptContext,status:'COMMITTED',commandId:h.input.commandId,operation:h.input.operation,revision:1}})
   throw Error('unexpected '+path)
  })
  const result=await createWorkspaceRowsStagedBridge({...options,fetchImpl}).rowLayoutWriter!.resumePrepared!(h.before,h.input)
  expect(result?.outcome).toBe('COMMITTED');expect(result?.snapshot).toEqual(h.saved.input.snapshot)
  expect(paths.filter(x=>x==='large_v2_attempt_begin')).toHaveLength(1)
  expect(claims.length).toBeGreaterThan(3);expect(claims.every(c=>JSON.stringify(c)===JSON.stringify(attempt))).toBe(true)
  expect(signals.every(signal=>signal===signals[0])).toBe(true)
  expect(paths).not.toContain('large_intent_admit');expect(paths).not.toContain('commit_authoritative')
 })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { randomBytes, createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { encodePreparedIntent, decodePreparedIntent, type DurablePreparedIntent } from '../gateway/workspaceRowsDurableIntent.js'
import { createWorkspaceRowsStagedBridge, stagedCommandStageId } from '../gateway/workspaceRowsStagedBridge.js'
import { largeAbandonFixture } from './fixtures/workspaceRowsLargeCommand.js'
import { withWorkspaceRowsRuntime } from '../gateway/workspaceRowsRuntime.js'
const userId='11111111-1111-4111-8111-111111111111',workspaceId='22222222-2222-4222-8222-222222222222',epoch='33333333-3333-4333-8333-333333333333'
const options={supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',readsEnabled:true,writesEnabled:true,rpcTransport:'public-v1' as const,durableIntent:true}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
function fixture():DurablePreparedIntent {
 const f=largeAbandonFixture()
 return {protocol:'workspace-prepared-intent-v1',deadlineAt:Date.now()+10000,manifestSha256:'a'.repeat(64),
  before:{userId,workspaceId,rowEpoch:epoch,revision:0,schemaVersion:4,snapshot:f.before},
  input:{userId,commandId:f.command.commandId,operation:'domain:abandon_opportunity',payloadHash:'b'.repeat(64),expectedRevision:0,principalKind:'first_party_web',snapshot:f.result.snapshot,schemaVersion:4,
   compensation:f.result.compensation as unknown as Record<string,unknown>,receiptContext:{contractVersion:5,unknownFuture:{data:['\u0000','😀',{'extra':true}]}}}}
}
const stored=(v:DurablePreparedIntent,encoded=encodePreparedIntent(v))=>({encoded,reservedBytes:encoded.bytes,deadlineAt:v.deadlineAt,binding:{family:'first_party_abandon',authority:{},stageId:stagedCommandStageId({userId:v.input.userId,workspaceId:v.before.workspaceId,expectedEpoch:v.before.rowEpoch,commandId:v.input.commandId},'first_party_abandon'),preparedSha256:encoded.sha256,manifestSha256:v.manifestSha256,userId:v.input.userId,commandId:v.input.commandId,payloadHash:v.input.payloadHash,operation:v.input.operation,principal:v.input.principalKind,workspaceId:v.before.workspaceId,expectedEpoch:v.before.rowEpoch,expectedRevision:v.before.revision}})
afterEach(()=>vi.restoreAllMocks())
describe('complete bounded durable prepared intent',()=>{
 it('retains unknown fields and every original byte through a fresh decode',()=>{
  const value=fixture(),encoded=encodePreparedIntent(value)
  expect(decodePreparedIntent(encoded,encoded.bytes)).toEqual(value)
  expect(JSON.stringify(decodePreparedIntent(encoded,encoded.bytes))).toBe(JSON.stringify(value))
  expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(2097152)
 })
 it('refuses bad compressed/raw hashes, counts, base64 and reservation bounds',()=>{
  const value=fixture(),encoded=encodePreparedIntent(value)
  for(const changed of [{...encoded,sha256:'0'.repeat(64)},{...encoded,compressedSha256:'0'.repeat(64)},
   {...encoded,bytes:encoded.bytes-1},{...encoded,bytes:encoded.bytes+1},{...encoded,base64:encoded.base64+'\n'},
   {...encoded,encoding:'gzip-v2'},{...encoded,bytes:0}])expect(()=>decodePreparedIntent(changed as typeof encoded,encoded.bytes+1)).toThrow()
  expect(()=>decodePreparedIntent(encoded,encoded.bytes-1)).toThrow()
 })
 it('refuses concatenated gzip, trailing zero padding and alternate headers even with recomputed compressed hash',()=>{
  const e=encodePreparedIntent(fixture()),raw=Buffer.from(e.base64,'base64')
  const changedHeader=Buffer.from(raw);changedHeader[4]=1
  for(const b of [Buffer.concat([raw,gzipSync(Buffer.from('{}'))]),Buffer.concat([raw,Buffer.from([0])]),changedHeader]){
   expect(()=>decodePreparedIntent({...e,base64:b.toString('base64'),compressedSha256:sha(b)},e.bytes)).toThrow()
  }
 })
 it('rejects invalid UTF8, duplicate keys, null/array roots and noncanonical JSON',()=>{
  const canonical=Buffer.from(JSON.stringify(fixture())),badUtf8=Buffer.from(canonical);badUtf8[badUtf8.indexOf(Buffer.from('workspace-prepared'))]=255
  const duplicate=Buffer.from(canonical.toString().replace('{','{"protocol":"discarded",'))
  for(const raw of [badUtf8,duplicate,Buffer.from('null'),Buffer.from('[]'),Buffer.concat([canonical,Buffer.from(' ')])]){
   const compressed=gzipSync(raw)
   expect(()=>decodePreparedIntent({encoding:'gzip-v1',base64:compressed.toString('base64'),bytes:raw.length,sha256:sha(raw),compressedSha256:sha(compressed)},raw.length)).toThrow()
  }
 })
 it('has a bounded decompressor even when a small compressed member expands beyond its declared allowance',()=>{
  const b=gzipSync(Buffer.alloc(10_000_000,65))
  expect(()=>decodePreparedIntent({encoding:'gzip-v1',base64:b.toString('base64'),compressedSha256:sha(b),sha256:'0'.repeat(64),bytes:1024},1024)).toThrow()
 })
 it('keeps the durable capability independently default off and requires original staged authority',()=>{
  expect(()=>withWorkspaceRowsRuntime(options,{PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT:'1'})).toThrow('Durable intent requires')
  expect(()=>createWorkspaceRowsStagedBridge({...options,rpcTransport:'candidate'})).toThrow('deadline-guarded')
  expect(createWorkspaceRowsStagedBridge({...options,durableIntent:false}).rowLayoutWriter?.resumePrepared).toBeUndefined()
 })
 it('refuses a legal incompressible prepared bundle before any admission/upload rather than raising the old wire bound',async()=>{
  const v=fixture(),fetchImpl=vi.fn()
  // Unknown valid forward-compatible header survives the business operation.
  v.before.snapshot.data.actions.forEach((action,index)=>{const noise=randomBytes(1100).toString('base64');action.title=noise;v.input.snapshot.data.actions[index].title=noise})
  await expect(createWorkspaceRowsStagedBridge({...options,fetchImpl}).rowLayoutWriter!.commit(v.before,v.input)).rejects.toMatchObject({code:'WORKSPACE_INVALID'})
  expect(fetchImpl).not.toHaveBeenCalled()
 })
 it('never extends the persisted absolute deadline or dispatches upload when it has expired',async()=>{
  const v=fixture();v.deadlineAt=Date.now()-1;const encoded=encodePreparedIntent(v)
  const fetchImpl=vi.fn(async()=>Response.json(stored(v,encoded)))
  await expect(createWorkspaceRowsStagedBridge({...options,fetchImpl}).rowLayoutWriter!.resumePrepared!(v.before,v.input)).rejects.toMatchObject({code:'WORKSPACE_UNAVAILABLE'})
  expect(fetchImpl).toHaveBeenCalledTimes(1)
 })
 it('never routes a tampered durable small delta through the generic original fastpath',async()=>{
  const v=fixture();v.input.snapshot=v.before.snapshot;const encoded=encodePreparedIntent(v)
  const fetchImpl=vi.fn(async()=>Response.json(stored(v,encoded)))
  await expect(createWorkspaceRowsStagedBridge({...options,fetchImpl}).rowLayoutWriter!.resumePrepared!(v.before,v.input)).rejects.toMatchObject({code:'WORKSPACE_INVALID'})
  expect(fetchImpl).toHaveBeenCalledTimes(1)
 })
 it('rejects a changed generation/revision or stored command identity without running upload',async()=>{
  for(const mutate of [(v:DurablePreparedIntent)=>v.before.revision++, (v:DurablePreparedIntent)=>v.before.rowEpoch='44444444-4444-4444-8444-444444444444',
   (v:DurablePreparedIntent)=>v.input.payloadHash='c'.repeat(64)]){
   const original=fixture(),v=structuredClone(original);mutate(v);const encoded=encodePreparedIntent(v),fetchImpl=vi.fn(async()=>Response.json(stored(v,encoded)))
   await expect(createWorkspaceRowsStagedBridge({...options,fetchImpl}).rowLayoutWriter!.resumePrepared!(original.before,original.input)).rejects.toBeDefined()
   expect(fetchImpl).toHaveBeenCalledTimes(1)
  }
 })
})

import { createTransactionalWorkspaceSource } from '../gateway/transactionalWorkspaceSource'
import { createSnapshot } from '../src/snapshot'
import { encodeWorkspaceRows } from '../gateway/workspaceRowsCodec'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withWorkspaceRowsRuntime } from '../gateway/workspaceRowsRuntime'
import { createTransactionalWorkspaceStore } from '../gateway/transactionalWorkspaceStore'
import { createAiCaptureLedger } from '../gateway/aiCaptureLedger'
const userId='11111111-1111-4111-8111-111111111111',workspaceId='22222222-2222-4222-8222-222222222222',epoch='33333333-3333-4333-8333-333333333333'
const base={supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic'}
const marker=[{id:workspaceId,user_id:userId,row_candidate_epoch:epoch}]
const head={workspaceId,userId,epoch,revision:7,schemaVersion:4,format:'workspace-rows-v1',envelope:{schema:'pjsdas-local-snapshot',version:4,data:{}},manifest:[]}
afterEach(()=>vi.unstubAllEnvs())
describe('dormant shared row backend runtime',()=>{
 it('keeps default legacy configuration unchanged and performs no construction request',()=>{
  const options={...base,fetchImpl:vi.fn()}
  expect(withWorkspaceRowsRuntime(options,{})).toBe(options)
  expect(withWorkspaceRowsRuntime(options,{PJSDAS_WORKSPACE_ROWS_READS:'0',PJSDAS_WORKSPACE_ROWS_WRITES:'0'})).toBe(options)
  expect(options.fetchImpl).not.toHaveBeenCalled()
 })
 it('refuses writer-only mode and makes read-only mode incapable of admission/mutation',()=>{
  expect(()=>withWorkspaceRowsRuntime(base,{PJSDAS_WORKSPACE_ROWS_WRITES:'1'})).toThrow('Row writers require')
  const resolved=withWorkspaceRowsRuntime({...base,rowLayoutReader:undefined,rowLayoutWriter:undefined},{PJSDAS_WORKSPACE_ROWS_READS:'1'})
  expect(resolved.rowLayoutReader).toBeDefined();expect(resolved.rowLayoutWriter).toBeUndefined()
 })
 it('requires explicit server staged mode AND both existing row capabilities',()=>{
  for(const env of [{PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS:'1'},{PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS:'1',PJSDAS_WORKSPACE_ROWS_READS:'1'}])expect(()=>withWorkspaceRowsRuntime(base,env)).toThrow('Staged documents require')
  const fetchImpl=vi.fn(),resolved=withWorkspaceRowsRuntime({...base,fetchImpl,rowLayoutReader:undefined,rowLayoutWriter:undefined},{PJSDAS_WORKSPACE_ROWS_READS:'1',PJSDAS_WORKSPACE_ROWS_WRITES:'1',PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS:'1'})
  expect(resolved.rowLayoutReader).toBeDefined();expect(resolved.rowLayoutWriter).toBeDefined();expect(fetchImpl).not.toHaveBeenCalled()
 })
 it('combines caller cancellation without replacing the original request timeout with an unbounded signal',async()=>{
  const caller=new AbortController(),observed:AbortSignal[]=[]
  const fetchImpl=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{observed.push(init!.signal as AbortSignal);return Response.json(head)})
  const resolved=withWorkspaceRowsRuntime({...base,signal:caller.signal,fetchImpl,rowLayoutReader:undefined,rowLayoutWriter:undefined},{PJSDAS_WORKSPACE_ROWS_READS:'1',PJSDAS_WORKSPACE_ROWS_WRITES:'1'})
  await resolved.rowLayoutReader!.readIdentity(userId)
  expect(observed.length).toBeGreaterThan(0);for(const signal of observed){expect(signal).not.toBe(caller.signal);expect(signal.aborted).toBe(false)}
  caller.abort();for(const signal of observed)expect(signal.aborted).toBe(true)
 })
 it('defaults to serial reads and rejects unbounded ambient concurrency',()=>{
  for(const value of ['0','5','1.5','unlimited'])expect(()=>withWorkspaceRowsRuntime(base,{PJSDAS_WORKSPACE_ROWS_READS:'1',PJSDAS_WORKSPACE_ROWS_READ_CONCURRENCY:value})).toThrow('Invalid bounded row read concurrency')
  const options={...base,rowLayoutReader:undefined,rowLayoutWriter:undefined}
  expect(withWorkspaceRowsRuntime(options,{PJSDAS_WORKSPACE_ROWS_READS:'1',PJSDAS_WORKSPACE_ROWS_READ_CONCURRENCY:'4'}).rowLayoutReader).toBeDefined()
  expect(withWorkspaceRowsRuntime(base,{PJSDAS_WORKSPACE_ROWS_READ_CONCURRENCY:'4'})).toBe(base)
 })
 it('does not merge ambient credentials/writers into an explicitly injected reader',()=>{
  const options={...base,rowLayoutReader:{read:vi.fn(),readIdentity:vi.fn()}}
  expect(withWorkspaceRowsRuntime(options,{PJSDAS_WORKSPACE_ROWS_READS:'1',PJSDAS_WORKSPACE_ROWS_WRITES:'1'})).toBe(options)
 })
 it('all normal store callers obtain current row identity via their supplied transport',async()=>{
  vi.stubEnv('PJSDAS_WORKSPACE_ROWS_READS','1');vi.stubEnv('PJSDAS_WORKSPACE_ROWS_WRITES','1')
  const fetchImpl=vi.fn(async(url:RequestInfo|URL)=>Response.json(String(url).includes('row_candidate_epoch')?marker:head))
  const store=createTransactionalWorkspaceStore({...base,fetchImpl})
  expect(await store.readIdentityForUser(userId)).toMatchObject({revision:7,rowEpoch:epoch})
  expect(fetchImpl.mock.calls.some(([url])=>String(url)==='https://synthetic.invalid/rest/v1/rpc/pjsdas_rows_v1_read_head')).toBe(true)
 })
 it('source resolves runtime capability before choosing stored-schema preimage metadata',async()=>{
  vi.stubEnv('PJSDAS_WORKSPACE_ROWS_READS','1');vi.stubEnv('PJSDAS_WORKSPACE_ROWS_WRITES','1')
  const snapshot=createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[]},'2030-01-01T00:00:00Z'),encoded=encodeWorkspaceRows(snapshot)
  const fetchImpl=vi.fn(async(url:RequestInfo|URL)=>{
   const text=String(url)
   if(text.includes('row_candidate_epoch'))return Response.json(marker)
   if(text.endsWith('read_head'))return Response.json({...head,envelope:encoded.envelope,manifest:encoded.manifest})
   if(text.endsWith('read_page'))return Response.json({outcome:'PAGE',workspaceId,epoch,revision:7,rows:encoded.rows,end:true})
   if(text.endsWith('commit_rows'))return Response.json({outcome:'COMMITTED',revision:8,receipt:{commandId:'synthetic-source',operation:'gmail_semantic_intake',revision:8,status:'COMMITTED'}})
   throw new Error('Unexpected source request')
  })
  const source=createTransactionalWorkspaceSource({...base,fetchImpl,userId,principalKind:'automation',sourceId:'gmail:primary'})
  const value=await source.read()
  expect((await source.write!({snapshot:value.snapshot,expectedWorkspaceVersion:value.context.workspaceVersion,command:{commandId:'synthetic-source',operation:'gmail_semantic_intake',payload:{synthetic:true}}})).commandOutcome).toBe('COMMITTED')
 })
 it('direct AI ledger callers obey the same runtime admission route without an injected adapter',async()=>{
  vi.stubEnv('PJSDAS_WORKSPACE_ROWS_READS','1');vi.stubEnv('PJSDAS_WORKSPACE_ROWS_WRITES','1')
  const fetchImpl=vi.fn(async(url:RequestInfo|URL)=>Response.json(String(url).includes('row_candidate_epoch')?marker:String(url).endsWith('read_head')?head:[{user_id:userId,request_id:'synthetic-request',payload_hash:'a'.repeat(64),status:'DISPATCHED',expected_revision:7,reservation_units:1}]))
  await createAiCaptureLedger({...base,fetchImpl}).admit({userId,requestId:'synthetic-request',payloadHash:'a'.repeat(64),text:'Synthetic',timezone:'UTC',referenceTime:'2030-01-01T00:00:00Z',reservationUnits:1,expectedRevision:7,contextRefs:[]})
  expect(fetchImpl.mock.calls.some(([url])=>String(url).endsWith('/pjsdas_rows_v1_admit_ai_capture'))).toBe(true)
  expect(fetchImpl.mock.calls.some(([url])=>String(url).endsWith('/pjsdas_admit_ai_capture'))).toBe(false)
 })
})


describe('server-only admission and compatible recovery release controls',()=>{
 const enabled={PJSDAS_WORKSPACE_ROWS_READS:'1',PJSDAS_WORKSPACE_ROWS_WRITES:'1',PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS:'1',PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT:'1',PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES:'1'}
 it('keeps original durable recovery present when new admission is stopped',()=>{
  const resolved=withWorkspaceRowsRuntime({...base,rowLayoutReader:undefined,rowLayoutWriter:undefined},{...enabled,PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION:'0'})
  expect(resolved.rowLayoutWriter?.resumePrepared).toBeTypeOf('function')
 })
 it('requires known explicit controls and does not silently map unknown strings to false',()=>{
  for(const mode of ['','legacy-inline-v1','pages-v2'])expect(()=>withWorkspaceRowsRuntime(base,{...enabled,PJSDAS_WORKSPACE_ROWS_AUDIT_ADMISSION_MODE:mode})).toThrow('known staged')
  for(const value of ['','false','2'])expect(()=>withWorkspaceRowsRuntime(base,{...enabled,PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION:value})).toThrow('Durable admission control')
  expect(()=>withWorkspaceRowsRuntime(base,{...enabled,PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT:'0',PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION:'0'})).toThrow('Durable admission control')
  for(const profile of ['','unknown','__proto__','constructor'])expect(()=>withWorkspaceRowsRuntime(base,{...enabled,PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE:profile})).toThrow('Unknown preloaded')
 })
 it('preloads fragment release selection only with all original server prerequisites and rejects competing selectors',()=>{
  const profile={...enabled,PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE:'compatible-fragments-v1'}
  expect(withWorkspaceRowsRuntime({...base,rowLayoutWriter:undefined},profile).rowLayoutWriter?.resumePrepared).toBeTypeOf('function')
  for(const flag of ['PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS','PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT','PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES'])expect(()=>withWorkspaceRowsRuntime(base,{...profile,[flag]:'0'})).toThrow('Row release profile requires')
  expect(()=>withWorkspaceRowsRuntime(base,{...profile,PJSDAS_WORKSPACE_ROWS_AUDIT_ADMISSION_MODE:'pages-v1'})).toThrow('Conflicting server')
 })
})

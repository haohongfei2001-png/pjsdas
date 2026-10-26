/** Candidate staged effect helpers, imported by the default-off staged adapter.
 * These local prototype controls are not approved product resource quotas. */
import {createHash} from 'node:crypto'
import {Buffer} from 'node:buffer'
import type {WorkspaceRowDelta} from './workspaceRowsCodec.js'
const sha=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex')
export interface StagedEffectPart {ordinal:number;wire:string}
export function prepareStagedEffects(delta:WorkspaceRowDelta) {
 const {changes,...metadata}=delta
 let finalDigest='0'.repeat(64),totalBytes=0
 const parts=changes.map((effect,ordinal)=>{
  const wire=JSON.stringify(effect);totalBytes+=Buffer.byteLength(wire)
  finalDigest=sha(finalDigest+sha(wire))
  return {ordinal,wire}
 })
 return {metadata,parts,finalDigest,totalBytes}
}
/** Bound each upload, not the total business command; reject an unsupported
 * individual part explicitly rather than silently truncate/rewrite the effect. */
export function* stagedEffectPages(parts:readonly StagedEffectPart[],maxWireBytes=240_000):Generator<StagedEffectPart[]> {
 if(!Number.isSafeInteger(maxWireBytes)||maxWireBytes<2||maxWireBytes>240_000)throw Error('INVALID_PAGE_BUDGET')
 let page:StagedEffectPart[]=[],bytes=2
 for(const part of parts) {
  const n=Buffer.byteLength(JSON.stringify(part))
  if(n+2>maxWireBytes)throw Error('UNSUPPORTED_LARGE_EFFECT_REQUIRES_FRAGMENT_PROTOCOL')
  if(page.length===127||bytes+n+(page.length?1:0)>maxWireBytes){yield page;page=[];bytes=2}
  bytes+=n+(page.length?1:0);page.push(part)
 }
 if(page.length)yield page
}
/** Executable migration stop, not a heuristic claim that today's small state
 * proves every future valid operation stays within the prototype's bounds. */
export function stagedPrototypeMigrationDecision() {
 return {eligible:false as const,reasons:[
  'OTHER_COMMAND_FAMILIES_NOT_STAGED',
  'LARGE_SINGLE_ENTITY_AND_HEADER_READS_NOT_IMPLEMENTED',
  'LARGE_COMPENSATION_AND_UNBOUNDED_HISTORY_NOT_IMPLEMENTED',
  'STAGING_RESOURCE_ADMISSION_NOT_A_PRODUCT_QUOTA',
  'DURABLE_HANDLER_INTENT_AND_RESOURCE_RECLAMATION_NOT_IMPLEMENTED',
  'OLD_READER_RETIREMENT_AND_HOSTED_ROLLBACK_NOT_PROVEN',
 ] as const}
}

export interface VerifiedFragment {
 offset:number;totalBytes:number;base64:string;sha256:string|null;revision:number;epoch:string;documentKey:string
}
export interface ProvisionalByteSink {
 /** Must not make bytes observable as a committed document. */
 write(bytes:Uint8Array):Promise<void>
 /** Publish only after complete byte hash and final revision fence. */
 commit():Promise<void>
 abort():Promise<void>
}
/** A byte-stream primitive, not a whole-history array or snapshot parser. The
 * caller supplies a transactional spool/sink; partial bytes must never be used
 * as authority. No arbitrary total-history limit or silent truncation. */
export async function streamVerifiedDocument(input:{
 epoch:string;revision:number;documentKey:string;signal:AbortSignal;
 read:(offset:number)=>Promise<VerifiedFragment>;fence:()=>Promise<boolean>;sink:ProvisionalByteSink;
}) {
 let offset=0,total:number|undefined,expectedHash:string|undefined
 const digest=createHash('sha256')
 try {
  do {
   input.signal.throwIfAborted()
   const part=await input.read(offset)
   input.signal.throwIfAborted()
   if(part.epoch!==input.epoch||part.revision!==input.revision||part.documentKey!==input.documentKey||part.offset!==offset
    ||!Number.isSafeInteger(part.totalBytes)||part.totalBytes<0||(total!==undefined&&part.totalBytes!==total)
    ||typeof part.base64!=='string'||part.base64.length>87_384)throw Error('INVALID_FRAGMENT')
   if(total===undefined){
    if(typeof part.sha256!=='string'||! /^[0-9a-f]{64}$/.test(part.sha256))throw Error('INVALID_DIGEST')
    total=part.totalBytes;expectedHash=part.sha256
   }else if(part.sha256!==null&&part.sha256!==expectedHash)throw Error('CHANGED_DIGEST')
   const bytes=Buffer.from(part.base64,'base64')
   if(bytes.toString('base64')!==part.base64||bytes.length>65_536||offset+bytes.length>total||(bytes.length===0&&offset!==total))throw Error('INVALID_FRAGMENT_BYTES')
   digest.update(bytes);await input.sink.write(bytes);offset+=bytes.length
  }while(offset<total!)
  if(digest.digest('hex')!==expectedHash)throw Error('DOCUMENT_DIGEST_MISMATCH')
  input.signal.throwIfAborted()
  if(!await input.fence())throw Error('DOCUMENT_REVISION_CONFLICT')
  input.signal.throwIfAborted()
  await input.sink.commit()
  return {bytes:offset,sha256:expectedHash!}
 }catch(error){
  try{await input.sink.abort()}catch(cleanupError){throw new AggregateError([error,cleanupError],'DOCUMENT_STREAM_AND_CLEANUP_FAILED')}
  throw error
 }
}

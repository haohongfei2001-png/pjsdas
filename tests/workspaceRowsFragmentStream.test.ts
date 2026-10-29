import {it,expect} from 'vitest'
import {createHash} from 'node:crypto'
import {streamVerifiedDocument,type VerifiedFragment} from '../gateway/workspaceRowsLargeCommandPrototype.js'
function fixture(bytes:Buffer){
 const hash=createHash('sha256').update(bytes).digest('hex'),parts:Buffer[]=[]
 let committed=false,aborted=false,peak=0
 const state={get committed(){return committed},get aborted(){return aborted},get peak(){return peak},parts}
 const input={epoch:'epoch',revision:3,documentKey:'audit:unicode',signal:new AbortController().signal,
  read:async(offset:number):Promise<VerifiedFragment>=>({offset,totalBytes:bytes.length,base64:bytes.subarray(offset,offset+65536).toString('base64'),sha256:offset===0?hash:null,epoch:'epoch',revision:3,documentKey:'audit:unicode'}),
  fence:async()=>true,sink:{write:async(b:Uint8Array)=>{expect(committed).toBe(false);peak=Math.max(peak,b.length);parts.push(Buffer.from(b))},commit:async()=>{committed=true},abort:async()=>{aborted=true;parts.length=0}}}
 return {input,state}
}
it('byte-splits UTF-8/emoji across boundaries and publishes only a complete validated document',async()=>{
 const bytes=Buffer.from(JSON.stringify({notes:'汉字😀"\\'.repeat(100000),optional:null,empty:[]})),f=fixture(bytes)
 const result=await streamVerifiedDocument(f.input)
 expect(result.bytes).toBe(bytes.length);expect(Buffer.concat(f.state.parts).equals(bytes)).toBe(true);expect(f.state.peak).toBe(65536);expect(f.state.committed).toBe(true)
})
it.each(['digest','revision','identity','gap','end-fence','abort'] as const)('never publishes provisional fragments after %s failure',async(kind)=>{
 const f=fixture(Buffer.from('x'.repeat(140000))),read=f.input.read
 f.input.read=async(offset)=>{const p=await read(offset);if(offset){if(kind==='digest')p.base64=Buffer.from('y'.repeat(Math.min(65536,p.totalBytes-offset))).toString('base64');if(kind==='revision')p.revision++;if(kind==='identity')p.documentKey='foreign';if(kind==='gap')p.offset++;if(kind==='abort')throw Error('network interrupted')}return p}
 if(kind==='end-fence')f.input.fence=async()=>false
 await expect(streamVerifiedDocument(f.input)).rejects.toThrow();expect(f.state.committed).toBe(false);expect(f.state.aborted).toBe(true);expect(f.state.parts).toEqual([])
})
it('streams beyond the former 32 MiB history budget without a total allocation in the sink',async()=>{
 const chunk=Buffer.alloc(65536,97),total=33*1024*1024,digest=createHash('sha256');for(let n=0;n<total;n+=chunk.length)digest.update(chunk)
 const sha=digest.digest('hex');let received=0,committed=false
 const result=await streamVerifiedDocument({epoch:'e',revision:0,documentKey:'audit',signal:new AbortController().signal,
 read:async(offset)=>({offset,totalBytes:total,base64:chunk.toString('base64'),sha256:offset===0?sha:null,epoch:'e',revision:0,documentKey:'audit'}),fence:async()=>true,
 sink:{write:async(bytes)=>{expect(bytes.length).toBeLessThanOrEqual(65536);received+=bytes.length},commit:async()=>{committed=true},abort:async()=>{throw Error('unexpected abort')}}})
 expect(received).toBe(total);expect(result.bytes).toBe(total);expect(committed).toBe(true)
})

it.each(['base64','empty','total','offset','digest-header'] as const)('rejects malformed %s framing before publish',async(kind)=>{
 const f=fixture(Buffer.from('x'.repeat(140000))),read=f.input.read
 f.input.read=async(offset)=>{const p=await read(offset);if(kind==='base64')p.base64='!!!';if(kind==='empty')p.base64='';if(kind==='total')p.totalBytes=1;if(kind==='offset')p.offset=3;if(kind==='digest-header')p.sha256='not-sha256';return p}
 await expect(streamVerifiedDocument(f.input)).rejects.toThrow();expect(f.state.committed).toBe(false);expect(f.state.aborted).toBe(true)
})
it('reports cleanup failure rather than implying provisional data was removed',async()=>{
 const f=fixture(Buffer.from('x'));f.input.read=async()=>{throw Error('read failure')};f.input.sink.abort=async()=>{throw Error('cleanup failure')}
 await expect(streamVerifiedDocument(f.input)).rejects.toThrow('DOCUMENT_STREAM_AND_CLEANUP_FAILED');expect(f.state.committed).toBe(false)
})

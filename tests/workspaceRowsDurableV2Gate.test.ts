import {afterEach,describe,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createManifest,groups,loadManifest,safeError,safeRpcSummary,selectGroup,sha,verifyManifest} from './sql/workspace-rows-durable-v2-source.mjs'

const commit='a'.repeat(40),tree='b'.repeat(40),prHeadSha='c'.repeat(40)
const scratch:string[]=[]
afterEach(()=>{for(const path of scratch.splice(0))rmSync(path,{recursive:true,force:true})})
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'ta-v2-source-contract-'));scratch.push(root)
 for(const path of ['gateway','src','supabase/migrations','tests/sql','tests/fixtures']){
  mkdirSync(join(root,path),{recursive:true});writeFileSync(join(root,path,'fixture.txt'),'synthetic source\n')
 }
 mkdirSync(join(root,'api'));writeFileSync(join(root,'api/workspace.ts'),'synthetic source\n')
 for(const path of ['package.json','package-lock.json','tsconfig.json','tsconfig.app.json','tsconfig.node.json'])writeFileSync(join(root,path),'{}\n')
 const options={root,commit,tree,prHeadSha}
 return{root,options,manifest:createManifest(options)}
}

describe('native recovery gate contract (no PostgreSQL)',()=>{
 it('has exactly 4 core, 17 uninterrupted safety, and 7 barrier labels with no overlap',()=>{
  expect(selectGroup('core')).toHaveLength(4)
  expect(selectGroup('safety')).toHaveLength(17)
  expect(selectGroup('barriers')).toHaveLength(7)
  const labels=Object.values(groups).flat()
  expect(labels).toHaveLength(28);expect(new Set(labels).size).toBe(28)
  expect(selectGroup('safety')).toContain('epoch-layout-mismatch-safe-refusal')
  expect(selectGroup('safety')).not.toContain('epoch-terminal')
  expect(selectGroup('core')).toEqual(['minute-api','minute-scoped','original-undo-api','original-undo-scoped'])
 })
 it.each(['tail','matrix','all','',undefined,'toString','__proto__'])('rejects unknown/hidden selector %s',selector=>{
  expect(()=>selectGroup(selector)).toThrow()
 })
 it('does not let callers alter the group contract',()=>{
  const labels=selectGroup('core');labels.pop()
  expect(selectGroup('core')).toHaveLength(4);expect(Object.isFrozen(groups.core)).toBe(true)
 })
 it('verifies a complete manifest without Git metadata or sibling paths',()=>{
  const {manifest,options,root}=fixture()
  expect(verifyManifest(manifest,options)).toEqual(manifest)
  expect(manifest.commit).toBe(commit);expect(manifest.prHeadSha).toBe(prHeadSha)
  expect(Object.keys(manifest.sha256).every(path=>!path.startsWith('/')&&!path.includes('..'))).toBe(true)
  mkdirSync(join(root,'tests/sql/node_modules'),{recursive:true});writeFileSync(join(root,'tests/sql/node_modules/not-source.txt'),'installed dependency')
  expect(verifyManifest(manifest,options)).toEqual(manifest)
 })
 it('fails byte tampering and missing/extra source files rather than silently reducing coverage',()=>{
  const {manifest,options,root}=fixture()
  writeFileSync(join(root,'api/workspace.ts'),'changed source')
  expect(()=>verifyManifest(manifest,options)).toThrow()
  writeFileSync(join(root,'api/workspace.ts'),'synthetic source\n')
  delete manifest.sha256['api/workspace.ts'];expect(()=>verifyManifest(manifest,options)).toThrow()
  const restored=createManifest(options)
  writeFileSync(join(root,'src/new-source.ts'),'export const value=1')
  expect(()=>verifyManifest(restored,options)).toThrow()
 })
 it.each(['../outside','/tmp/outside','api/../outside','api//fixture.txt','api/./fixture.txt','api\\fixture.txt','private/fixture.txt','api/health.ts'])('rejects unsafe manifest path %s',path=>{
  const {manifest,options}=fixture()
  manifest.sha256[path]='a'.repeat(64)
  expect(()=>verifyManifest(manifest,options)).toThrow()
 })
 it.each(['','x','a'.repeat(63),'A'.repeat(64),null])('rejects malformed hash %s',digest=>{
  const {manifest,options}=fixture()
  manifest.sha256['api/workspace.ts']=digest
  expect(()=>verifyManifest(manifest,options)).toThrow()
 })
 it('rejects an empty manifest and wrong checkout or PR identity',()=>{
  const {manifest,options}=fixture()
  expect(()=>verifyManifest({...manifest,sha256:{}},options)).toThrow()
  expect(()=>verifyManifest(manifest,{...options,commit:'d'.repeat(40)})).toThrow()
  expect(()=>verifyManifest(manifest,{...options,tree:'d'.repeat(40)})).toThrow()
  expect(()=>verifyManifest(manifest,{...options,prHeadSha:null})).toThrow()
 })
 it('rejects escaping source symlinks both during generation and verification',()=>{
  const {manifest,options,root}=fixture()
  const outside=mkdtempSync(join(tmpdir(),'ta-v2-source-outside-'));scratch.push(outside)
  writeFileSync(join(outside,'fixture.txt'),'synthetic source\n')
  rmSync(join(root,'api/workspace.ts'));symlinkSync(join(outside,'fixture.txt'),join(root,'api/workspace.ts'))
  expect(()=>createManifest(options)).toThrow();expect(()=>verifyManifest(manifest,options)).toThrow()
 })
 it('pins manifest bytes before parsing, so replacing hashes or identity is not accepted',()=>{
  const {manifest,root}=fixture(),path=join(root,'source-manifest.json')
  writeFileSync(path,JSON.stringify(manifest));const digest=sha(readFileSync(path))
  expect(loadManifest(path,digest)).toEqual(manifest)
  writeFileSync(path,JSON.stringify({...manifest,commit:'d'.repeat(40)}))
  expect(()=>loadManifest(path,digest)).toThrow()
  expect(()=>loadManifest(path,'')).toThrow()
 })
 it('keeps only allowlisted error names and codes, never messages, stacks, payloads, or credentials',()=>{
  const error=Object.assign(new Error('password=private JWT private payload'),{code:'23505',stack:'private stack'})
  expect(safeError(error)).toEqual({name:'Error',code:'23505'})
  expect(safeError({name:'private payload',code:'password=private',message:'private'})).toEqual({name:'Error'})
  expect(JSON.stringify(safeError(error))).not.toMatch(/private|password|JWT|payload|stack/)
 })
 it('keeps only relative allowlisted error frames and numeric assertion values',()=>{
  const error={name:'AssertionError',code:'ERR_ASSERTION',actual:503,expected:200,message:'JWT private',stack:'private token\n at success (/private/checkout/tests/sql/workspace-rows-durable-v2-barriers.mjs:17:21)\n at unknown (/private/payload.ts:1:2)'}
  expect(safeError(error)).toEqual({name:'AssertionError',code:'ERR_ASSERTION',actual:503,expected:200,locations:[{file:'workspace-rows-durable-v2-barriers.mjs',line:17,column:21}]})
  expect(JSON.stringify(safeError({...error,actual:'JWT private',expected:{payload:'private'}}))).not.toMatch(/private|JWT|payload|checkout/)
 })
 it('records RPC timings and generations without serializing bodies, tokens or query URLs',()=>{
  const calls=[{path:'/rpc/pjsdas_rows_v1_large_v2_append',receivedAt:100,endedAt:102,status:503,bytes:42,responseBytes:8,errorCode:'PT503',input:{attempt:{generation:2,deadlineAt:200,id:'private-id'},payload:'private'},output:{remainingMs:98,attempt:{generation:2,deadlineAt:200},message:'private'},headers:{authorization:'private'}},{path:'/rpc/pjsdas_rows_v1_read?payload=private',input:'private'},{path:'/private',input:'private'}]
  expect(safeRpcSummary(calls)).toEqual([{rpc:'pjsdas_rows_v1_large_v2_append',receivedAt:100,endedAt:102,status:503,bytes:42,responseBytes:8,sqlstate:'PT503',requestGeneration:2,requestDeadlineAt:200,responseGeneration:2,responseDeadlineAt:200,remainingMs:98}])
  expect(JSON.stringify(safeRpcSummary(calls))).not.toMatch(/private|payload|authorization|headers|message/)
 })

})

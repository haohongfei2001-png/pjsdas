/** Portable, fail-closed source identity for the synthetic native recovery gate. */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {lstatSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs'
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'

export const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
export const source=root
export const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex')
const directories=['gateway','src','supabase/migrations','tests/sql','tests/fixtures']
const files=['api/workspace.ts','package.json','package-lock.json','tsconfig.json','tsconfig.app.json','tsconfig.node.json']
const hex40=/^[a-f0-9]{40}$/
const hex64=/^[a-f0-9]{64}$/
const contract='ta-native-recovery-source-v1'
export const groups=Object.freeze({
 core:Object.freeze(['minute-api','minute-scoped','original-undo-api','original-undo-scoped']),
 safety:Object.freeze(['real-attempt-timeout-rollback','late-old-attempt-generation','concurrent-same-command','lost-ack-api','lost-ack-scoped','revoked-original-grant','replaced-original-grant','real-resource-expiry','cas-terminal','epoch-layout-mismatch-safe-refusal','explicit-intent-cancel','legacy-v1-expired','old-small-alternate-stage-v2','old-small-alternate-stage-terminal-v1','cancel-authority-and-committed-first','capacity-exhaustion-pre-admission','read-and-resource-fences']),
 barriers:Object.freeze(['head-held-new-attempt-waits-exitguard-rollback','finish-first-cancel-observes-original-commit','cancel-first-finalizer-permanently-fenced','repeat-page-exact-logical-accounting','eight-mib-fixed-exhaustion-terminal-no-reclaim','sixteen-mib-original-positive-no-expansion','temporary-global-capacity-stays-nonterminal']),
})
export function selectGroup(group){
 assert(Object.hasOwn(groups,group),'Unknown native recovery group')
 return [...groups[group]]
}

const allowed=path=>files.includes(path)||directories.some(dir=>path.startsWith(dir+'/'))
function checkedPath(base,path){
 assert.equal(typeof path,'string','Source path must be relative')
 assert(path.length>0&&!isAbsolute(path)&&!path.includes('\\'),'Source path must be relative')
 assert(path.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'),'Noncanonical source path')
 assert(allowed(path),'Source path outside allowlist')
 const canonical=realpathSync(base),target=resolve(canonical,path)
 assert(relative(canonical,target)!=='..'&&!relative(canonical,target).startsWith('..'+sep),'Source path escapes checkout')
 let current=canonical
 for(const part of path.split('/')){
  current=join(current,part)
  assert(!lstatSync(current).isSymbolicLink(),'Source symlinks are forbidden')
 }
 assert.equal(realpathSync(target),target,'Source path escapes checkout')
 assert(lstatSync(target).isFile(),'Source path must be a file')
 return target
}
export const sourceImport=path=>import(pathToFileURL(checkedPath(source,path)).href)

function sourceFiles(base){
 const result=[]
 const scan=path=>{
  const stat=lstatSync(join(base,path))
  assert(!stat.isSymbolicLink(),'Source symlinks are forbidden')
  if(stat.isDirectory()){
   for(const child of readdirSync(join(base,path)).sort()){
    if(child==='node_modules'||child==='.git')continue
    scan(path+'/'+child)
   }
  }else{
   checkedPath(base,path)
   result.push(path)
  }
 }
 for(const dir of directories){assert(lstatSync(join(base,dir)).isDirectory(),'Missing source directory');scan(dir)}
 for(const file of files){checkedPath(base,file);result.push(file)}
 return result.sort()
}
function identity(commit,tree,prHeadSha){
 assert(hex40.test(commit),'Exact checkout commit is required')
 assert(hex40.test(tree),'Exact checkout tree is required')
 assert(prHeadSha===null||hex40.test(prHeadSha),'PR head must be an exact commit or null')
}
export function createManifest({root:base=source,commit,tree,prHeadSha=null}){
 identity(commit,tree,prHeadSha)
 const sha256={}
 for(const path of sourceFiles(base))sha256[path]=sha(readFileSync(checkedPath(base,path)))
 return{contract,commit,tree,prHeadSha,sha256}
}
export function verifyManifest(manifest,{root:base=source,commit,tree,prHeadSha=null}={}){
 assert(manifest&&typeof manifest==='object'&&!Array.isArray(manifest),'Invalid manifest')
 assert.deepEqual(Object.keys(manifest).sort(),['contract','commit','tree','prHeadSha','sha256'].sort(),'Invalid manifest fields')
 assert.equal(manifest.contract,contract,'Invalid source manifest contract')
 identity(manifest.commit,manifest.tree,manifest.prHeadSha)
 identity(commit,tree,prHeadSha)
 assert.equal(manifest.commit,commit,'Checkout commit mismatch')
 assert.equal(manifest.tree,tree,'Checkout tree mismatch')
 assert.equal(manifest.prHeadSha,prHeadSha,'PR head mismatch')
 assert(manifest.sha256&&typeof manifest.sha256==='object'&&!Array.isArray(manifest.sha256),'Invalid manifest hashes')
 const entries=Object.entries(manifest.sha256)
 assert(entries.length>0,'Empty source manifest')
 for(const [path,digest]of entries){
  assert.equal(typeof digest,'string','Invalid source hash')
  assert(hex64.test(digest),'Invalid source hash')
  assert.equal(sha(readFileSync(checkedPath(base,path))),digest,'Source hash mismatch')
 }
 assert.deepEqual(entries.map(([path])=>path).sort(),sourceFiles(base),'Incomplete source manifest')
 return manifest
}
export function loadManifest(path,digest){
 assert.equal(typeof path,'string','Source manifest path is required')
 assert(path.length>0,'Source manifest path is required')
 assert.equal(typeof digest,'string','Manifest digest is required')
 assert(hex64.test(digest),'Invalid manifest digest')
 const raw=readFileSync(path)
 assert.equal(sha(raw),digest,'Source manifest changed')
 return JSON.parse(raw)
}

// Lazy loading keeps imports and contract tests independent of PG and CI state.
export let lock
export function verifySource(){
 const env=process.env
 const manifest=loadManifest(env.TA_V2_SOURCE_MANIFEST,env.TA_V2_SOURCE_MANIFEST_SHA256)
 verifyManifest(manifest,{commit:env.TA_V2_SOURCE_COMMIT,tree:env.TA_V2_SOURCE_TREE,prHeadSha:env.TA_V2_PR_HEAD_SHA||null})
 if(lock)assert.deepEqual(manifest,lock,'Source identity changed during execution')
 lock=manifest
 return lock
}
export function safeError(error){
 const names=['Error','AssertionError','AggregateError','TypeError','RangeError','SyntaxError']
 const result={name:names.includes(error?.name)?error.name:'Error'}
 const code=error?.code
 if(typeof code==='string'&&/^(?:ERR_[A-Z_]{1,40}|[0-9A-Z]{5}|E(?:ACCES|PERM|NOENT|CONNREFUSED|CONNRESET|PIPE|ADDRINUSE))$/.test(code))result.code=code
 const stack=typeof error?.stack==='string'?error.stack:''
 const frames=[...stack.matchAll(/(workspace-rows-durable-v2-(?:source|acceptance|fixture|cold-worker|barriers|resource-inventory)\.mjs):(\d+):(\d+)/g)].slice(0,3)
 if(frames.length)result.locations=frames.map(([,file,line,column])=>({file,line:Number(line),column:Number(column)}))
 for(const key of ['actual','expected'])if(Number.isFinite(error?.[key])||typeof error?.[key]==='boolean')result[key]=error[key]
 return result
}

/** Bounded RPC metadata only: no query, body, identity, headers or tokens. */
export function safeRpcSummary(calls){
 return calls.filter(c=>/^\/rpc\/pjsdas_rows_v1_[a-z0-9_]+$/.test(c?.path??'')).map(c=>{
  const item={rpc:c.path.slice('/rpc/'.length)}
  for(const key of ['receivedAt','endedAt','status','bytes','responseBytes'])if(Number.isFinite(c[key]))item[key]=c[key]
  if(typeof c.errorCode==='string'&&/^[0-9A-Z]{5}$/.test(c.errorCode))item.sqlstate=c.errorCode
  for(const [prefix,value]of [['request',c.input?.attempt],['response',c.output?.attempt]]){
   for(const key of ['generation','deadlineAt'])if(Number.isFinite(value?.[key]))item[prefix+key[0].toUpperCase()+key.slice(1)]=value[key]
  }
  if(Number.isFinite(c.output?.remainingMs))item.remainingMs=c.output.remainingMs
  return item
 })
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  assert.equal(process.argv.length,4,'Expected --manifest PATH')
  assert.equal(process.argv[2],'--manifest','Expected --manifest PATH')
  const manifest=createManifest({commit:process.env.TA_V2_SOURCE_COMMIT,tree:process.env.TA_V2_SOURCE_TREE,prHeadSha:process.env.TA_V2_PR_HEAD_SHA||null})
  const raw=JSON.stringify(manifest,null,2)+'\n'
  writeFileSync(process.argv[3],raw,{flag:'wx',mode:0o600})
  console.log(sha(raw))
 }catch(error){console.error(JSON.stringify(safeError(error)));process.exitCode=1}
}

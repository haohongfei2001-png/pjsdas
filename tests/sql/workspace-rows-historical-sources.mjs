/** Source-only historical dependency closures. No network, compilation, or runtime imports.
 * Provenance commits describe where bytes came from; materialization never creates or
 * impersonates a Git commit. Current-source references must match independent hashes. */
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve,relative,sep} from 'node:path'
import {fileURLToPath} from 'node:url'

export const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const fixtureRoot=join(repositoryRoot,'tests/fixtures/workspace-rows-history')
export const historicalSourceIds=Object.freeze(['r0p','historical103','reader','serial'])
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex')
const safePath=value=>{assert.equal(typeof value,'string');assert(!value.includes('\\'));assert(!value.split('/').some(part=>!part||part==='.'||part==='..'));assert(!value.startsWith('/'));return value}
export function historicalManifest(id){
 assert(historicalSourceIds.includes(id),'unknown historical source: '+id)
 const bytes=readFileSync(join(fixtureRoot,id+'.json')),manifest=JSON.parse(bytes)
 const catalogBytes=readFileSync(join(fixtureRoot,'file-records.json'))
 assert.equal(sha256(catalogBytes),manifest.fileCatalogSha256,'historical file catalog changed without review')
 const catalog=JSON.parse(catalogBytes)
 manifest.files=Object.fromEntries(Object.entries(manifest.files).map(([path,hash])=>{assert(catalog[hash],'missing historical file record');return[path,{...catalog[hash],sha256:hash}]}))
 assert.equal(manifest.format,'ta-historical-source-closure-v1');assert.equal(manifest.id,id)
 assert.match(manifest.provenance.sourceCommit,/^[a-f0-9]{40}$/)
 for(const[path,file]of Object.entries(manifest.files)){
  safePath(path);assert.match(file.sha256,/^[a-f0-9]{64}$/);assert(['repository','blob'].includes(file.storage))
  for(const dependency of file.imports??[])if(!dependency.external)assert(manifest.files[dependency.path],path+' has a dependency outside its frozen closure')
 }
 for(const entry of manifest.entrypoints)assert(manifest.files[entry],'entry outside closure')
 for(const directory of manifest.requiredDirectories??[])safePath(directory)
 return {manifest,manifestSha256:sha256(bytes)}
}
function assertSharedDependencyLock(manifest){
 const id=manifest.id
 // Bundles intentionally externalize npm packages to this checkout. A future
 // lockfile change must not silently run an old producer on different packages.
 for(const path of ['package.json','package-lock.json'])assert.equal(sha256(readFileSync(join(repositoryRoot,path))),manifest.files[path].sha256,id+': externalized historical dependencies require the identical reviewed root lockfile; use a separately reviewed install strategy if versions diverge')
}
export function verifyHistoricalInputs(id){
 const {manifest,manifestSha256}=historicalManifest(id)
 assertSharedDependencyLock(manifest)
 for(const[path,file]of Object.entries(manifest.files)){
  const input=file.storage==='repository'?join(repositoryRoot,path):join(fixtureRoot,'blobs',file.sha256+'.txt')
  const bytes=readFileSync(input)
  assert.equal(bytes.length,file.bytes,id+': byte length differs for '+path)
  assert.equal(sha256(bytes),file.sha256,id+': historical source differs for '+path+'; preserve the old bytes in a reviewed fixture, never silently substitute current code')
  assert.equal(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),file.gitBlob,id+': original Git blob identity differs for '+path)
 }
 return {manifest,manifestSha256}
}
function filesBelow(root,prefix=''){
 return readdirSync(join(root,prefix),{withFileTypes:true}).flatMap(entry=>{
  const relative=prefix?prefix+'/'+entry.name:entry.name
  assert(!entry.isSymbolicLink(),'historical fixture must not redirect source through a symlink: '+relative)
  return entry.isDirectory()?filesBelow(root,relative):[relative]
 }).sort()
}
export function assertHistoricalSource(id,directory,{gitCheckout=false}={}){
 const {manifest,manifestSha256}=historicalManifest(id),root=resolve(directory)
 assertSharedDependencyLock(manifest)
 if(gitCheckout){
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim()
  assert.equal(git('rev-parse','HEAD'),manifest.provenance.sourceCommit,id+' checkout provenance changed')
  assert.equal(git('status','--porcelain','--untracked-files=all'),'',id+' checkout is dirty or contains untracked sources')
 }else{
  const stat=lstatSync(root);assert(stat.isDirectory()&&!stat.isSymbolicLink(),'materialized historical root must not be a symlink')
  const marker=JSON.parse(readFileSync(join(root,'.historical-source.json'),'utf8'))
  assert.deepEqual(marker,{format:'ta-materialized-source-closure-v1',id,manifestSha256,sourceCommit:manifest.provenance.sourceCommit,notACompleteGitCommit:true})
  assert.deepEqual(filesBelow(root),[...Object.keys(manifest.files),'.historical-source.json'].sort(),'materialized closure must not gain replacement/untracked source files')
 }
 for(const directory of manifest.requiredDirectories??[]){const stat=lstatSync(join(root,directory));assert(stat.isDirectory()&&!stat.isSymbolicLink(),'historical worker resolveDir must exist as a real directory: '+directory)}
 for(const[path,file]of Object.entries(manifest.files)){
  const filename=join(root,path);assert(lstatSync(filename).isFile()&&!lstatSync(filename).isSymbolicLink(),'not a regular source file: '+path)
  assert.equal(sha256(readFileSync(filename)),file.sha256,id+': frozen file changed: '+path)
 }
 return {sourceKind:gitCheckout?'original-git-checkout':'materialized-source-closure',sourceCommit:manifest.provenance.sourceCommit,manifestSha256,embeddedReleaseIdentity:manifest.embeddedReleaseIdentity,files:Object.keys(manifest.files).length,contentVerified:true,notACompleteGitCommit:!gitCheckout}
}
function ensureCacheDirectory(cache){
 assert(cache.startsWith(repositoryRoot+sep),'materialized history cache must remain inside this checkout so frozen package dependencies resolve from its root node_modules')
 let current=repositoryRoot
 for(const part of relative(repositoryRoot,cache).split(sep)){
  current=join(current,part)
  let stat;try{stat=lstatSync(current)}catch(error){if(error.code!=='ENOENT')throw error;mkdirSync(current);stat=lstatSync(current)}
  assert(stat.isDirectory()&&!stat.isSymbolicLink(),'historical cache ancestor must not be a symlink: '+current)
 }
 assert.equal(realpathSync(cache),join(realpathSync(repositoryRoot),relative(repositoryRoot,cache)),'historical cache redirected outside checkout')
}
export function resolveHistoricalSource(id,{checkout}={}){
 const envKey='TA_HISTORY_'+id.toUpperCase()+'_CHECKOUT',override=checkout??process.env[envKey]
 if(override){const root=resolve(override);return {root,...assertHistoricalSource(id,root,{gitCheckout:true}),gitCheckout:true}}
 const {manifest,manifestSha256}=verifyHistoricalInputs(id)
 const cache=resolve(process.env.TA_HISTORY_CACHE_DIR??join(repositoryRoot,'.ta-validation/history'))
 ensureCacheDirectory(cache)
 const root=join(cache,id+'-'+manifestSha256)
 if(!existsSync(root)){
  mkdirSync(cache,{recursive:true});const temporary=join(cache,'.'+id+'-'+randomUUID());mkdirSync(temporary)
  try{
   // esbuild resolves the shared stdin worker from tests/sql. Some minimal
   // closures have no file there, but the directory must still really exist.
   for(const directory of manifest.requiredDirectories??[])mkdirSync(join(temporary,directory),{recursive:true})
   for(const[path,file]of Object.entries(manifest.files)){
    const input=file.storage==='repository'?join(repositoryRoot,path):join(fixtureRoot,'blobs',file.sha256+'.txt')
    mkdirSync(dirname(join(temporary,path)),{recursive:true});writeFileSync(join(temporary,path),readFileSync(input),{flag:'wx'})
   }
   writeFileSync(join(temporary,'.historical-source.json'),JSON.stringify({format:'ta-materialized-source-closure-v1',id,manifestSha256,sourceCommit:manifest.provenance.sourceCommit,notACompleteGitCommit:true})+'\n',{flag:'wx'})
   assertHistoricalSource(id,temporary);renameSync(temporary,root)
  }finally{rmSync(temporary,{recursive:true,force:true})}
 }
 return {root,...assertHistoricalSource(id,root),gitCheckout:false}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode='verify',id]=process.argv.slice(2)
 assert(['verify','materialize','path'].includes(mode),'use verify, materialize, or path')
 const ids=id?[id]:historicalSourceIds
 if(mode==='path')assert.equal(ids.length,1,'path requires one source id')
 for(const name of ids){
  if(mode==='verify'){const{manifest,manifestSha256}=verifyHistoricalInputs(name);console.log(JSON.stringify({id:name,manifestSha256,sourceCommit:manifest.provenance.sourceCommit,files:Object.keys(manifest.files).length,status:'PASS_SOURCE_BYTES_ONLY',runtimeTested:false}))}
  else{const result=resolveHistoricalSource(name);console.log(mode==='path'?result.root:JSON.stringify({id:name,...result,runtimeTested:false}))}
 }
}

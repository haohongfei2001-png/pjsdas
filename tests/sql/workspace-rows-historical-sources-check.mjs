/** Pure filesystem/source assertions only. Does not import historical runtime,
 * start services, compile TypeScript, fetch/install packages, or execute Git. */
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,lstatSync,readdirSync,renameSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {historicalSourceIds,historicalManifest,verifyHistoricalInputs,resolveHistoricalSource,assertHistoricalSource,repositoryRoot,sha256} from './workspace-rows-historical-sources.mjs'

mkdirSync(join(repositoryRoot,'.ta-validation'),{recursive:true})
const temporary=mkdtempSync(join(repositoryRoot,'.ta-validation/source-self-check-'))
const before={cache:process.env.TA_HISTORY_CACHE_DIR,overrides:Object.fromEntries(historicalSourceIds.map(id=>{const key='TA_HISTORY_'+id.toUpperCase()+'_CHECKOUT';return[key,process.env[key]]}))}
try{
 process.env.TA_HISTORY_CACHE_DIR=temporary
 for(const key of Object.keys(before.overrides))delete process.env[key]
 for(const id of historicalSourceIds){
  const {manifest}=verifyHistoricalInputs(id)
  const imports=new Set(Object.values(manifest.files).flatMap(file=>(file.imports??[]).filter(x=>x.external).map(x=>x.specifier)))
  assert.deepEqual([...imports].sort(),manifest.externalImports,'external dependency closure changed')
  assert.equal(manifest.embeddedReleaseIdentity,'e53bb5ad7bcfa6c4ecd23f930a630d24209e81ff')
  const source=resolveHistoricalSource(id)
  assert.equal(source.sourceKind,'materialized-source-closure');assert.equal(source.notACompleteGitCommit,true)
  assert.equal(resolveHistoricalSource(id).root,source.root,'verified closure is reused without replacement')
  for(const directory of manifest.requiredDirectories??[])assert(lstatSync(join(source.root,directory)).isDirectory(),'stdin worker resolveDir must exist even without an entry file')
  const entry=join(source.root,manifest.entrypoints[0]),original=readFileSync(entry)
  try{
   writeFileSync(entry,Buffer.concat([original,Buffer.from('\n// tampered source\n')]))
   assert.throws(()=>assertHistoricalSource(id,source.root),/frozen file changed/)
   assert.throws(()=>resolveHistoricalSource(id),/frozen file changed/,'do not silently repair/replace tampered cached source')
  }finally{writeFileSync(entry,original)}
  const injected=join(source.root,'unexpected.js')
  try{writeFileSync(injected,'throw Error("untracked replacement")\n');assert.throws(()=>assertHistoricalSource(id,source.root),/replacement\/untracked/)}finally{rmSync(injected,{force:true})}
  try{unlinkSync(entry);symlinkSync(join(repositoryRoot,manifest.entrypoints[0]),entry);assert.throws(()=>assertHistoricalSource(id,source.root),/symlink/)}finally{rmSync(entry,{force:true});writeFileSync(entry,original)}
  assertHistoricalSource(id,source.root)
  console.log(JSON.stringify({id,files:source.files,manifestSha256:source.manifestSha256,byteVerification:'PASS',tamperRefusal:'PASS',untrackedSourceRefusal:'PASS',symlinkRefusal:'PASS',runtimeTested:false}))
 }
 const outside=mkdtempSync(join(tmpdir(),'ta-history-cache-negative-')),cacheLink=join(temporary,'redirected-cache')
 try{
  symlinkSync(outside,cacheLink);process.env.TA_HISTORY_CACHE_DIR=cacheLink
  assert.throws(()=>resolveHistoricalSource('r0p'),/cache ancestor must not be a symlink/)
  assert.deepEqual(readdirSync(outside),[],'cache symlink refusal must occur before any outside write')
 }finally{process.env.TA_HISTORY_CACHE_DIR=temporary;rmSync(cacheLink,{force:true});rmSync(outside,{recursive:true,force:true})}
 const r0p=resolveHistoricalSource('r0p'),legacy=resolveHistoricalSource('historical103')
 const moved=r0p.root+'-root-symlink-negative'
 try{renameSync(r0p.root,moved);symlinkSync(moved,r0p.root);assert.throws(()=>resolveHistoricalSource('r0p'),/root must not be a symlink/)}finally{rmSync(r0p.root,{force:true});renameSync(moved,r0p.root)}
 assert(readFileSync(join(r0p.root,'gateway/workspaceRowsReleaseProfile.ts'),'utf8').includes("'compatible-fragments-v1'"))
 assert(!readFileSync(join(r0p.root,'gateway/workspaceRowsReleaseProfile.ts'),'utf8').includes("'compatible-pages-v1'"),'preserve the original R0p admission profile')
 assert(!historicalManifest('historical103').manifest.files['gateway/workspaceRowsReleaseProfile.ts'],'old producer must not gain a new release profile')
 for(const source of [r0p,legacy])for(const path of ['gateway/workspaceRowsDurableIntent.ts','gateway/workspaceRowsRuntime.ts','gateway/workspaceRowsStagedBridge.ts'])assert.notEqual(sha256(readFileSync(join(source.root,path))),sha256(readFileSync(join(repositoryRoot,path))),'old runtime must not alias current: '+path)
 console.log('PASS_HISTORICAL_SOURCE_ONLY; no runtime, compilation, database, HTTP or installation executed')
}finally{
 if(before.cache===undefined)delete process.env.TA_HISTORY_CACHE_DIR;else process.env.TA_HISTORY_CACHE_DIR=before.cache
 for(const[key,value]of Object.entries(before.overrides))if(value===undefined)delete process.env[key];else process.env[key]=value
 rmSync(temporary,{recursive:true,force:true})
}

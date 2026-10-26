/** Runtime source fence for the independent integrated-candidate / complete R0p pair.
 * No dependency installation, child-tree edits, or test invocation on import. */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {existsSync,statSync} from 'node:fs'
import {dirname,isAbsolute,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {resolveHistoricalSource,assertHistoricalSource} from './workspace-rows-historical-sources.mjs'
export const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const historical={a:resolveHistoricalSource('r0p'),legacy:resolveHistoricalSource('historical103')}
export const sourceTrees={a:historical.a.root,b:repositoryRoot,legacy:historical.legacy.root}
// A/legacy values are byte provenance, NOT synthetic materialized Git HEADs.
export const source={a:historical.a.sourceCommit,b:process.env.TA_INTEGRATED_SOURCE_SHA,legacy:historical.legacy.sourceCommit}
assert.match(source.b??'',/^[a-f0-9]{40}$/,'TA_INTEGRATED_SOURCE_SHA must be the final frozen integrated candidate commit')
const suppliedReport=process.env.TA_INTEGRATED_PAIR_REPORT??process.env.TA_PAIR_REPORT
assert(suppliedReport&&isAbsolute(suppliedReport),'TA_INTEGRATED_PAIR_REPORT must be an absolute, run-exclusive JSON path')
assert(suppliedReport.endsWith('.json'),'pair report must end in .json')
export const reportFile=resolve(suppliedReport),reportDirectory=dirname(reportFile)
assert(existsSync(reportDirectory)&&statSync(reportDirectory).isDirectory(),'scheduler must create the exclusive report directory')
for(const file of [reportFile,...['cold-timeline.json','http-timeline.json','terminal-command-state.json','source-checks.json','runner-state.json'].map(name=>join(reportDirectory,name))])assert(!existsSync(file),'refuse to overwrite existing evidence: '+file)
export const sourceChecks=[]
export function assertFrozenSources(phase){
 const observed={phase,atUtc:new Date().toISOString(),trees:{}}
 for(const release of ['a','b','legacy']){
  const tree=sourceTrees[release]
  if(release!=='b'){
   const verified=assertHistoricalSource(release==='a'?'r0p':'historical103',tree,{gitCheckout:historical[release].gitCheckout})
   observed.trees[release]={path:tree,...verified,expected:source[release]}
   assert.equal(verified.sourceCommit,source[release],release+' provenance changed at '+phase)
  }else{
   const head=execFileSync('git',['-C',tree,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
   const trackedChanges=execFileSync('git',['-C',tree,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim()
   observed.trees[release]={path:tree,head,expected:source[release],trackedClean:trackedChanges===''}
   assert.equal(head,source[release],release+' frozen HEAD changed at '+phase)
   assert.equal(trackedChanges,'',release+' tracked source is dirty at '+phase)
  }
 }
 sourceChecks.push(observed)
 console.log('INTEGRATED_PAIR_SOURCE',JSON.stringify(observed))
 return observed
}

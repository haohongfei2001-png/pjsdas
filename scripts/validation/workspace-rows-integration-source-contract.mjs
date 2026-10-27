/** Read-only source composition proof. No PostgreSQL, HTTP, compilation, or old Git objects. */
import assert from 'node:assert/strict'
import {readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {historicalSourceIds,verifyHistoricalInputs} from '../../tests/sql/workspace-rows-historical-sources.mjs'
const root=fileURLToPath(new URL('../..',import.meta.url)),read=path=>readFileSync(resolve(root,path),'utf8')
const sha256=path=>createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex')
const contract=JSON.parse(read('tests/fixtures/workspace-rows-history/composition.json'))
assert.equal(contract.format,'ta-source-composition-v1')
const check=(path,expected,label)=>assert.equal(sha256(path),expected,label+': '+path+'; unexpected change requires explicit source-contract review, not a blanket exemption')
for(const[path,original]of Object.entries(contract.baselineFiles)){
 const evolution=contract.acceptedBaselineEvolutions[path]
 if(evolution)assert.equal(evolution.originalSha256,original,'wrong evolution preimage: '+path)
 check(path,evolution?.acceptedSha256??original,'original R1p source')
}
const entries=Object.entries(contract.resourceImports).map(([path,original])=>{
 const portability=contract.acceptedResourcePortabilityChanges[path],evolution=contract.acceptedResourceEvolutions?.[path]
 assert(!(portability&&evolution),'an algorithm evolution cannot be hidden as portability: '+path)
 const change=portability??evolution
 if(change)assert.equal(change.originalSha256,original,'wrong resource preimage: '+path)
 check(path,change?.acceptedSha256??original,'resource source')
 return {path,originalSha256:original,sha256:sha256(path),portabilityChange:portability?.reason??null,algorithmEvolution:evolution??null}
})
assert.equal(entries.length,12,'all twelve original resource imports retained')
for(const[path,evolution]of Object.entries(contract.acceptedResourceEvolutions??{})){
 assert.equal(evolution.originalSha256,contract.resourceImports[path],'resource evolution must name an existing exact source')
 assert.equal(evolution.sourceCommit,contract.reclamationIntegration?.sourceCommit,'resource evolution source must match the pinned integration')
 assert.equal(evolution.acceptedSha256,contract.reclamationIntegration.files[path].originalSha256,'resource implementation must be the exact reviewed upstream bytes')
}
if(contract.reclamationIntegration){
 assert.match(contract.reclamationIntegration.sourceCommit,/^[a-f0-9]{40}$/)
 for(const[path,file]of Object.entries(contract.reclamationIntegration.files)){
  check(path,file.acceptedSha256,'frozen reclamation source or explicit runner-only integration')
  if(file.originalSha256!==file.acceptedSha256){
   assert(['tests/sql/reclamation/native-acceptance.mjs','tests/sql/reclamation/native-fixture.mjs'].includes(path),'only the two explicit runner integration paths may differ from upstream reclamation source')
   assert(file.reason.startsWith('Runner-only portability:'),'reclamation source changes require an explicit reviewed integration category')
  }
 }
}
const runnerAdditions=contract.reclamationIntegration?.runnerAdditions
if(runnerAdditions){
 assert.deepEqual(Object.keys(runnerAdditions).sort(),['tests/sql/reclamation/finish-run.mjs','tests/sql/reclamation/fixture-lifecycle.mjs','tests/workspaceRowsReclamationRunner.test.ts'].sort(),'only explicitly reviewed reclamation runner additions')
 for(const[path,file]of Object.entries(runnerAdditions))check(path,file.sha256,'reclamation runner lifecycle/evidence source')
}
for(const[path,expected]of Object.entries(contract.originalSql)){
 assert.equal(contract.baselineFiles[path],expected,'original SQL preimage mismatch')
 check(path,expected,'unchanged original SQL')
}
const catalog={...contract.resourceCatalog,...contract.acceptedAdditionalCatalog}
assert.deepEqual(readdirSync(resolve(root,'tests/sql/candidates')).sort(),Object.keys(catalog).map(path=>path.slice('tests/sql/candidates/'.length)).sort(),'new/removed catalog input requires review')
for(const[path,expected]of Object.entries(catalog))check(path,expected,'catalog patch input')
for(const[path,expected]of Object.entries(contract.preservedPairSources))check(path,expected,'unchanged original full-pair assertions')
const copied=read('tests/sql/workspace-rows-resource-rpc-native.mjs')
const normalized=copied.replace(/^\/\*\* Exact baseline harness[\s\S]*?\*\/\n/,'')
 .replace(",'workspace-rows-resource-reservations.sql','workspace-rows-resource-rpc.sql'",'')
 .replace(/ const \{ runResourceRpcProof \} = await import\('\.\/workspace-rows-resource-rpc-proof\.mjs'\)\n await runResourceRpcProof\([^\n]+\)\n/,'')
assert.equal(normalized,read('tests/sql/workspace-rows-staged-documents-prototype.mjs'),'all original baseline assertions retained exactly')
assert(copied.includes("'cold recovery cannot admit a replacement intent'"))
assert(read('tests/sql/workspace-rows-audit-page-proof.mjs').includes("assert(!calls.slice(beforeResume).some(call=>call.path.endsWith('large_intent_admit')))"))
const historicalSources=historicalSourceIds.map(id=>{const{manifest,manifestSha256}=verifyHistoricalInputs(id);return{id,sourceCommit:manifest.provenance.sourceCommit,manifestSha256,files:Object.keys(manifest.files).length}})
const report={status:'PASS_STATIC_COMPOSITION_ONLY',provenance:contract.provenance,baselineFiles:Object.keys(contract.baselineFiles).length,explicitEvolutions:contract.acceptedBaselineEvolutions,importedFiles:entries,unchangedOriginalSqlFiles:Object.keys(contract.originalSql).length,originalHarnessNormalization:'PASS_EXACT',reclamationIntegration:contract.reclamationIntegration??null,historicalSources,runtimeTested:false,productionMigration:false,
 limitations:['Runtime and clean-checkout database/HTTP gates are NOT_RUN by this command','Original deadline, fixture sizes and earlier failing observations remain separate','Historical source closures are not full Git commits or deployed release evidence','No production ACL/preimages, physical capacity, filesystem lifecycle, or hosted rollout proof']}
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify(report,null,2))

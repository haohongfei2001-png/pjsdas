/** Pure source/filesystem checks; does not load application modules or run PG/HTTP. */
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {repositoryRoot} from '../workspace-rows-historical-sources.mjs'
import {resolveReclamationHistoricalSource,verifyReclamationHistoricalSource} from './historical-source.mjs'
const keys=['TA_R0P_SOURCE_ROOT','TA_HISTORY_RESOLVER_MODULE','TA_HISTORY_R0P_CHECKOUT','TA_HISTORY_CACHE_DIR']
const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]))
mkdirSync(join(repositoryRoot,'.ta-validation'),{recursive:true})
const temporary=mkdtempSync(join(repositoryRoot,'.ta-validation/reclamation-source-check-'))
try{
 for(const key of keys)delete process.env[key]
 process.env.TA_HISTORY_CACHE_DIR=temporary
 const source=resolveReclamationHistoricalSource()
 assert.equal(source.fixtureDependency,'same-checkout-source-closure')
 assert.equal(source.sourceCommit,'a8c13dade102691b6562170a4d3d55d3ef724109')
 assert.equal(source.manifestSha256,'ce189165d1571cabf5a6f17860281113a1562ec4f9cfe05f259a45dbd12b46b9')
 verifyReclamationHistoricalSource(source)
 process.env.TA_R0P_SOURCE_ROOT=source.root
 process.env.TA_HISTORY_RESOLVER_MODULE=fileURLToPath(new URL('../workspace-rows-historical-sources.mjs',import.meta.url))
 const explicit=resolveReclamationHistoricalSource();assert.equal(explicit.fixtureDependency,'explicit-materialized-closure');assert.equal(explicit.root,source.root)
 const fake=join(temporary,'unreviewed-resolver.mjs');writeFileSync(fake,'throw new Error("must never execute external code")\n')
 process.env.TA_HISTORY_RESOLVER_MODULE=fake
 assert.throws(()=>resolveReclamationHistoricalSource(),/external historical resolver must be byte-identical/)
 console.log(JSON.stringify({status:'PASS_SOURCE_ONLY',historicalSourceCommit:source.sourceCommit,manifestSha256:source.manifestSha256,sameCheckoutDefault:true,explicitSourceVerified:true,arbitraryExternalModuleRejected:true,runtimeExecuted:false}))
}finally{
 for(const[key,value]of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value
 rmSync(temporary,{recursive:true,force:true})
}

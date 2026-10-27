/** Source-only resolver for the reclamation historical gate. Default input is
 * this checkout's independently pinned R0p closure, not a sibling worktree. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {assertHistoricalSource,resolveHistoricalSource,sha256} from '../workspace-rows-historical-sources.mjs'
const resolverPath=fileURLToPath(new URL('../workspace-rows-historical-sources.mjs',import.meta.url))
export function resolveReclamationHistoricalSource(){
 const explicitRoot=process.env.TA_R0P_SOURCE_ROOT,explicitModule=process.env.TA_HISTORY_RESOLVER_MODULE
 // Retain the old explicit fixture interface without executing an arbitrary
 // external module. Verification always uses this checkout's fixed manifest.
 if(explicitModule){
  assert(explicitRoot,'TA_HISTORY_RESOLVER_MODULE requires TA_R0P_SOURCE_ROOT')
  assert.equal(sha256(readFileSync(explicitModule)),sha256(readFileSync(resolverPath)),'external historical resolver must be byte-identical to the reviewed local resolver')
 }
 const selected=explicitRoot?{root:resolve(explicitRoot),gitCheckout:false,...assertHistoricalSource('r0p',resolve(explicitRoot),{gitCheckout:false})}:resolveHistoricalSource('r0p')
 return {...selected,fixtureDependency:explicitRoot?'explicit-materialized-closure':process.env.TA_HISTORY_R0P_CHECKOUT?'explicit-original-git-checkout':'same-checkout-source-closure',resolverSha256:sha256(readFileSync(resolverPath))}
}
export function verifyReclamationHistoricalSource(selected){
 const verified=assertHistoricalSource('r0p',selected.root,{gitCheckout:selected.gitCheckout})
 assert.equal(verified.manifestSha256,selected.manifestSha256,'historical manifest changed during the gate')
 assert.equal(verified.sourceCommit,selected.sourceCommit,'historical source provenance changed during the gate')
 return verified
}

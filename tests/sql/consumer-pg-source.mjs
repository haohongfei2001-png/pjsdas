/** Browser inputs supplement, never replace, the original native source fence. */
import assert from 'node:assert/strict'
import {lstatSync,readFileSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {root,sha,verifySource} from './workspace-rows-durable-v2-source.mjs'

export const extraPaths=Object.freeze([
 'api/health.ts','api/automation-settings.ts','index.html','vite.config.ts','playwright.consumer-pg.config.mts',
 'e2e/consumerPostgresRecovery.consumer-pg.ts','e2e/fixtures/todayWorkspace.ts',
 'e2e/support/mockCloudTargets.ts','e2e/support/mockCloudIsolation.mts',
 'e2e/support/mockCloudProxySetup.mjs','e2e/support/mockApplicationRequests.ts',
 '.github/workflows/consumer-pg-browser.yml','scripts/verify-installed-runtime-lock.mjs',
])
export const consumerCases=Object.freeze(['offline-ui-done-undo-new-page-auto-recovery','lost-ack-new-page-auto-receipt','lost-ack-real-60s-automatic-receipt'])
export const consumerApiPaths=Object.freeze(['/api/health','/api/workspace','/api/automation-settings'])
/** Fixed metadata only: never serialize headers, tokens, bodies or query text. */
export function safeConsumerRequests(requests){
 return requests.map(request=>({path:consumerApiPaths.includes(request.path)?request.path:'unapproved',
  method:['GET','POST','OPTIONS'].includes(request.method)?request.method:'other',
  action:['read','command','receipt','undo'].includes(request.action)?request.action:'other',
  ...(Number.isSafeInteger(request.status)?{status:request.status}:{}),
  ...(typeof request.authorizationMatched==='boolean'?{authorizationMatched:request.authorizationMatched}:{}),
  ...(typeof request.expectedAncillaryDenial==='boolean'?{expectedAncillaryDenial:request.expectedAncillaryDenial}:{}),
  ...(typeof request.originMatched==='boolean'?{originMatched:request.originMatched}:{})}))
}
function extra(path,base=root){
 assert(extraPaths.includes(path),'Unlisted consumer source')
 let current=base
 for(const part of path.split('/')){current=join(current,part);assert(!lstatSync(current).isSymbolicLink(),'Consumer source symlinks forbidden')}
 assert(lstatSync(current).isFile(),'Consumer source must be a file')
 return current
}
export function createConsumerManifest(nativeManifestSha256,{base=root}={}){
 assert(/^[a-f0-9]{64}$/.test(nativeManifestSha256),'Native manifest digest required')
 return{contract:'consumer-pg-browser-source-v1',nativeManifestSha256,
  mode:'mock-cloud-ui-real-api-public-postgrest-owned-pg',
  sha256:Object.fromEntries(extraPaths.map(path=>[path,sha(readFileSync(extra(path,base)))]))}
}
export function verifyConsumerManifest(manifest,nativeManifestSha256,{base=root}={}){
 assert.deepEqual(manifest,createConsumerManifest(nativeManifestSha256,{base}),'Consumer source or contract changed')
 return manifest
}
export function verifyConsumerSource(){
 const native=verifySource(),env=process.env
 assert(env.TA_CONSUMER_SOURCE_MANIFEST,'Consumer manifest required')
 const raw=readFileSync(env.TA_CONSUMER_SOURCE_MANIFEST)
 assert.equal(sha(raw),env.TA_CONSUMER_SOURCE_MANIFEST_SHA256,'Consumer manifest changed')
 verifyConsumerManifest(JSON.parse(raw),env.TA_V2_SOURCE_MANIFEST_SHA256)
 return native
}
export function consumerSourceImport(path){verifyConsumerSource();return import(pathToFileURL(extra(path)).href)}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--manifest')
 verifySource()
 const raw=JSON.stringify(createConsumerManifest(process.env.TA_V2_SOURCE_MANIFEST_SHA256),null,2)+'\n'
 writeFileSync(process.argv[3],raw,{flag:'wx',mode:0o600});console.log(sha(raw))
}

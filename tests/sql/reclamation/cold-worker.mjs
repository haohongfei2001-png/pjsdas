/** Real existing production API/scoped entry; no injected store, reducer or grant resolver. */
import assert from 'node:assert/strict'
import {sourceImport} from './source.mjs'
const {PJSDAS_SUPABASE_URL}=await sourceImport('gateway/supabaseProject.ts')
const proxy=new URL(process.env.TA_INTENT_PROXY)
assert.equal(proxy.hostname,'127.0.0.1')
const nativeFetch=globalThis.fetch
// The sole allowed destination is redirected before runtime import. Everything
// else throws: no provider, arbitrary URL or production traffic is possible.
globalThis.fetch=(input,init)=>{const u=new URL(String(input));assert.equal(u.origin,PJSDAS_SUPABASE_URL,'nonlocal egress forbidden');return nativeFetch(proxy.origin+u.pathname+u.search,init)}
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk)
const input=JSON.parse(Buffer.concat(chunks).toString())
let result
if(input.mode==='scoped'){
 const {createOwnerScopedManagementRuntime}=await sourceImport('gateway/scopedManagementRuntime.ts')
 const runtime=createOwnerScopedManagementRuntime({supabaseUrl:PJSDAS_SUPABASE_URL,serviceRoleKey:process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY,enabled:'enabled',transactional:true,identity:{userId:input.userId,oauthClientId:input.clientId},audience:{allowed:true,mode:'allowlist',role:'owner'}})
 result=await runtime.opportunity.invoke(input.tool,input.body)
}else if(input.mode==='history'){
 const {createTransactionalWorkspaceStore}=await sourceImport('gateway/transactionalWorkspaceStore.ts')
 const store=createTransactionalWorkspaceStore({supabaseUrl:PJSDAS_SUPABASE_URL,serviceRoleKey:process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY,auditReadAuthorization:input.authorization})
 result=await store.readCommandsAfterRevision(input.userId,0)
}else{
 const {default:entry}=await sourceImport('api/workspace.ts')
 const response=await entry.fetch(new Request('https://synthetic.invalid/api/workspace',{method:'POST',headers:input.headers,body:JSON.stringify(input.body)}))
 result={status:response.status,body:await response.json()}
}
process.stdout.write(JSON.stringify(result))
process.stderr.write(JSON.stringify({kind:'cold-worker-finished',pid:process.pid,at:new Date().toISOString(),cpu:process.cpuUsage()})+'\n')

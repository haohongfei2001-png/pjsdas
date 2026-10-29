if(process.env.TA_ROW_AUDIT_MEASURE==='1')process.once('beforeExit',()=>process.stderr.write('AUDIT_COLD_RESOURCE '+JSON.stringify(process.resourceUsage())+'\n'))
/** Fresh-process actual API/scoped-factory client, loopback synthetic only. */
import { PJSDAS_SUPABASE_URL } from '../../gateway/supabaseProject.ts'
const proxy = new URL(process.env.TA_INTENT_PROXY)
if (proxy.hostname !== '127.0.0.1') throw Error('remote proxy forbidden')
const nativeFetch = globalThis.fetch
// No adapter/grant resolver injection. Same production entry with only its
// existing network destination redirected to this owned loopback fixture.
globalThis.fetch = (input, init) => {
 const u = new URL(String(input)); if (u.origin !== PJSDAS_SUPABASE_URL) throw Error('nonlocal egress forbidden')
 return nativeFetch(proxy.origin + u.pathname + u.search, init)
}
const chunks=[];for await (const chunk of process.stdin) chunks.push(chunk)
const input=JSON.parse(Buffer.concat(chunks).toString())
if(input.mode==='history'||input.mode==='read'){
 const {createTransactionalWorkspaceStore}=await import('../../gateway/transactionalWorkspaceStore.ts')
 const store=createTransactionalWorkspaceStore({supabaseUrl:PJSDAS_SUPABASE_URL,serviceRoleKey:process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY,auditReadAuthorization:input.authorization})
 process.stdout.write(JSON.stringify(input.mode==='history'?await store.readCommandsAfterRevision(input.userId,input.afterRevision??0):await store.readForUser(input.userId)))
}else if(input.mode==='scoped'){
 const { createOwnerScopedManagementRuntime }=await import('../../gateway/scopedManagementRuntime.ts')
 const runtime=createOwnerScopedManagementRuntime({supabaseUrl:PJSDAS_SUPABASE_URL,serviceRoleKey:process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY,enabled:'enabled',transactional:true,
 identity:{userId:input.userId,oauthClientId:input.clientId},audience:{allowed:true,mode:'allowlist',role:'owner'}})
 process.stdout.write(JSON.stringify(await runtime.opportunity.invoke(input.tool,input.body)))
}else{
 const entry=(await import('../../api/workspace.ts')).default
 const result=await entry.fetch(new Request('https://synthetic.invalid/api/workspace',{method:'POST',headers:input.headers,body:JSON.stringify(input.body)}))
 process.stdout.write(JSON.stringify({status:result.status,body:await result.json()}))
}

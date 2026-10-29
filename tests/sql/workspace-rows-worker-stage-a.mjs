// Synthetic provider boundary only; all authority/lease/commit/finish calls use
// actual local PostgreSQL/PostgREST and the deployed application implementations.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { runControlledGmailExecutions } from '../../gateway/gmailControlledExecution.ts'
import { createWorkspaceRowsStoreBridge } from '../../gateway/workspaceRowsStoreBridge.ts'
import { encryptSecret } from '../../gateway/tokenCrypto.ts'
import { GMAIL_READONLY_SCOPE } from '../../gateway/automationConnectionStore.ts'
import { PJSDAS_SUPABASE_URL } from '../../gateway/supabaseProject.ts'

export async function testControlledRowWorker({db,origin,token,userId,revision,rpcTransport,runtime=false}) {
 const key=randomBytes(32).toString('base64url'),cipher=await encryptSecret('synthetic-refresh-token',key)
 await db.query("insert into public.google_drive_connections(user_id,google_subject,google_email,refresh_token_ciphertext,granted_scopes,gmail_automation_enabled,gmail_intake_consent_version,gmail_history_id) values($1,'synthetic-worker-subject','worker@example.invalid',$2,$3,true,'uu06-v1','100')",[userId,cipher,[GMAIL_READONLY_SCOPE]])
 let at=new Date(),messageAt=at,ids=['synthetic-worker-mail-a','synthetic-worker-mail-b'],nextHistoryId='200',fault=null
 const calls=[]
 const json=value=>Response.json(value)
 const rawFetch=async(input,init={})=>{
  const url=new URL(String(input));calls.push(url.pathname)
  if(url.origin===origin || url.origin===PJSDAS_SUPABASE_URL) {
   assert(init.signal,'controlled database fetch must retain budget signal')
   const local=new URL(url.pathname+url.search,origin),headers=new Headers(init.headers)
   if(local.pathname.startsWith('/rest/v1/')) { local.pathname=local.pathname.replace('/rest/v1/','/');headers.set('accept-profile','public');headers.set('content-profile','public') }
   if(fault==='finish' && local.pathname.endsWith('/pjsdas_finish_gmail_execution') && JSON.parse(init.body).state_patch.historyId) { fault=null;throw new Error('Synthetic finish transport failure before execution') }
   const result=await fetch(local,{...init,headers})
   if(fault==='commit' && local.pathname.endsWith('commit_rows') && result.ok) { fault=null;await result.text();throw new Error('Synthetic lost successful commit response') }
   return result
  }
  if(url.href==='https://oauth2.googleapis.com/token')return json({access_token:'synthetic-access-token',expires_in:3600})
  if(url.hostname==='gmail.googleapis.com') {
   if(url.pathname.endsWith('/profile'))return json({historyId:nextHistoryId})
   if(url.pathname.endsWith('/history'))return json({historyId:nextHistoryId,history:[{messagesAdded:ids.map(id=>({message:{id}}))}]})
   if(url.pathname.endsWith('/messages'))return json({messages:ids.map(id=>({id}))})
   const id=url.pathname.split('/').at(-1)
   if(ids.includes(id))return json({id,threadId:'synthetic-thread-'+id,internalDate:String(messageAt.getTime()),snippet:'Synthetic unrelated newsletter',payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'Synthetic unrelated newsletter'},{name:'From',value:'newsletter@example.invalid'}],body:{data:Buffer.from('Synthetic unrelated newsletter. No recruiting facts.').toString('base64url')}}})
  }
  throw new Error('Unexpected external fixture request')
 }
 const config={supabaseUrl:origin,supabasePublishableKey:'synthetic-publishable',supabaseServiceRoleKey:token,tokenEncryptionKey:key,googleClientId:'synthetic-client',googleClientSecret:'synthetic-secret',fetchImpl:rawFetch,now:()=>at,
  rowLayoutFactory:runtime?undefined:budgetFetch=>createWorkspaceRowsStoreBridge({supabaseUrl:origin,serviceRoleKey:token,readsEnabled:true,writesEnabled:true,rpcTransport,fetchImpl:budgetFetch})}
 const envNames=['PJSDAS_CONNECTED_AUTHORITY','PJSDAS_SUPABASE_SERVICE_ROLE_KEY','PJSDAS_GMAIL_EMPTY_CHECKPOINTS','PJSDAS_GMAIL_EMPTY_CHECKPOINT_READS'],previous=Object.fromEntries(envNames.map(k=>[k,process.env[k]]))
 try {
  process.env.PJSDAS_CONNECTED_AUTHORITY='transactional';process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY=token
  process.env.PJSDAS_GMAIL_EMPTY_CHECKPOINTS='1';process.env.PJSDAS_GMAIL_EMPTY_CHECKPOINT_READS='1'
  const result=await runControlledGmailExecutions(config,'fixture-only-gmail-worker',userId)
  assert.equal(result.successfulUsers,1,JSON.stringify(result));assert.equal(result.failedUsers,0)
  const binding=(await db.query('select gmail_history_id,gmail_last_success_at from public.google_drive_connections where user_id=$1',[userId])).rows[0]
  const execution=(await db.query('select lease_token,completed_runs,failed_runs,last_metrics from public.gmail_automation_execution_state where user_id=$1',[userId])).rows[0]
  assert.equal(binding.gmail_history_id,'200');assert(binding.gmail_last_success_at);assert.equal(execution.lease_token,null);assert.equal(Number(execution.completed_runs),1);assert.equal(Number(execution.failed_runs),0)
  assert.equal(execution.last_metrics.receivedCount,2);assert.equal(execution.last_metrics.accountedCount,2)
  assert(calls.some(p=>p.endsWith('/pjsdas_assert_gmail_execution')));assert(calls.some(p=>p.endsWith('/pjsdas_finish_gmail_execution')));assert(calls.some(p=>p.endsWith('commit_rows')))
  assert(!calls.some(p=>/pjsdas_commit_workspace_v[1-4]$/.test(p)))
  const actual=(await db.query('select revision from pjsdas_rows_candidate.head where user_id=$1',[userId])).rows[0]
  assert.equal(Number(actual.revision),revision+1)
  assert.equal((await db.query('select revision from public.pjsdas_workspaces where user_id=$1',[userId])).rows[0].revision,'0')
  for(const [index,kind] of ['commit','finish'].entries()) {
   ids=['synthetic-worker-recovery-'+kind];nextHistoryId=String(300+index*100)
   at=new Date(at.getTime()+1000);messageAt=at;fault=kind
   const before=Number((await db.query('select revision from pjsdas_rows_candidate.head where user_id=$1',[userId])).rows[0].revision)
   const failed=await runControlledGmailExecutions(config,'fixture-only-gmail-worker',userId)
   assert.equal(failed.failedUsers,1,JSON.stringify(failed));assert.equal(fault,null,'intended fault reached')
   assert.equal((await db.query('select gmail_history_id from public.google_drive_connections where user_id=$1',[userId])).rows[0].gmail_history_id,String(200+index*100),'uncertain commit/finish cannot advance cursor')
   assert.equal(Number((await db.query('select revision from pjsdas_rows_candidate.head where user_id=$1',[userId])).rows[0].revision),before+1,'business commit really succeeded before lost response/finalization')
   // A new run identity re-reads actual persisted receipts. The same messages
   // are not applied again just because finalization did not move the cursor.
   at=new Date(at.getTime()+1000)
   const recovered=await runControlledGmailExecutions(config,'fixture-only-gmail-worker',userId)
   assert.equal(recovered.successfulUsers,1,JSON.stringify(recovered))
   assert.equal((await db.query('select gmail_history_id from public.google_drive_connections where user_id=$1',[userId])).rows[0].gmail_history_id,nextHistoryId)
   assert.equal(Number((await db.query('select revision from pjsdas_rows_candidate.head where user_id=$1',[userId])).rows[0].revision),before+1,'new-run retry must not duplicate data/audit commit')
  }
  console.log('PASS real worker lost commit response and failed finish preserve cursor; new-run source receipt recovery finalizes without duplicate row commit')
  console.log('PASS real controlled Gmail worker HTTP: synthetic nonempty provider batch, original lease/binding/assert/commit-first/finish cursor, all row requests budget-bound, no legacy save')
 } finally { for(const key of envNames)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key] }
}

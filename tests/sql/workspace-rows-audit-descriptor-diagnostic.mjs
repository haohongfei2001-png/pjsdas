/** Bounded diagnostic for the retained genuine descriptor statement timeout.
 * Same original audit and public history function; no timeout/cap changes,
 * no inference of capacity from a successful repetition. Instrumented local
 * samples are kept separate from the frozen end-to-end performance matrix. */
import assert from 'node:assert/strict'
import pg from 'pg'
import {readFileSync,writeFileSync} from 'node:fs'
export async function runAuditDescriptorDiagnostic(h){
 const {db,rpc,x,record,connectionString}=h,observer=new pg.Client({connectionString});await observer.connect()
 const proof={userId:x.vIds.userId,principal:'first_party_web'},query={mode:'command',commandId:x.vf.commandId,auditProtocol:'workspace-audit-bytes-v1',auditPageProtocol:'workspace-audit-page-v1',auditAuthorization:proof}
 const params=[x.vIds.userId,x.vIds.epoch,2,query],cases=[],report={localOnly:true,scope:'unchanged original2106241-byte V5 audit, descriptor/history only',notCapacityProof:true,statementTimeoutMs:10000,controlledCalls:120,cases}
 const pgState=async()=>{await observer.query('select pg_stat_clear_snapshot()');return(await observer.query('select pid,state,wait_event_type,wait_event,query_start from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()')).rows.map(row=>{try{const p=readFileSync('/proc/'+row.pid+'/stat','utf8').split(') ')[1].split(' ');return{...row,cpuTicks:Number(p[11])+Number(p[12]),rssPages:Number(p[21])}}catch{return row}})}
 const persist=()=>{if(process.env.TA_DESCRIPTOR_REPORT)writeFileSync(process.env.TA_DESCRIPTOR_REPORT,JSON.stringify(report,null,2))}
 async function sample(label,call){
  const before=await pgState(),start=performance.now(),startedAtUtc=new Date().toISOString(),observations=[];let stop=false,timer,pending=Promise.resolve()
  const poll=()=>{if(stop)return;pending=pgState().then(state=>observations.push({elapsedMs:performance.now()-start,state})).finally(()=>{if(!stop)timer=setTimeout(poll,250)})};timer=setTimeout(poll,250)
  let value,error,requestElapsedMs
  try{value=await call();if(value.status!==undefined){if(value.status!==200)error=value;else value=value.body}if(!error){assert.equal(value.auditProtocol,'workspace-audit-bytes-v1');assert.equal(value.rows[0].auditDocument.totalBytes,2106241);assert.equal(value.rows[0].command_id,record.command_id)}}catch(e){error={code:e.code,message:e.message}}
  finally{requestElapsedMs=performance.now()-start;stop=true;clearTimeout(timer);await pending;const elapsedMs=performance.now()-start,after=await pgState();cases.push({label,startedAtUtc,elapsedMs,requestElapsedMs,error,before,after,observations});persist();console.log('DESCRIPTOR_DIAGNOSTIC',JSON.stringify({label,elapsedMs,requestElapsedMs,error,slowObservations:observations.length}))}
 }
 try{
  await db.query("set statement_timeout='10s'")
  const settings=(await db.query("select name,setting,unit from pg_settings where name in ('statement_timeout','work_mem','plan_cache_mode','jit','shared_preload_libraries','session_preload_libraries') order by name")).rows;report.settings=settings
  // Same pooled public HTTP path where the timeout was observed. Forty-eight
  // calls cross SQL/PLpgSQL prepared-plan reuse thresholds on both backends.
  for(let i=0;i<48;i++)await sample('actual-public-http-history-'+i,()=>rpc('pjsdas_rows_v1_read_history',{target_user_id:params[0],target_epoch:params[1],target_revision:params[2],query}))
  for(const mode of ['auto','force_custom_plan','force_generic_plan']){
   await db.query('set plan_cache_mode='+mode);await db.query('set role service_role')
   try{for(let i=0;i<24;i++)await sample('actual-public-sql-'+mode+'-'+i,async()=> (await db.query({name:'descriptor-diagnostic-history',text:'select public.pjsdas_rows_v1_read_history($1,$2,$3,$4) value',values:params})).rows[0].value)}finally{await db.query('reset role;reset plan_cache_mode')}
  }
  report.functionStatistics=(await db.query("select schemaname,funcname,calls,total_time,self_time from pg_stat_user_functions where funcname in ('audit_descriptor','audit_reference','read_history','read_audit_page','pack_audit_page') order by 1,2")).rows
  report.databaseStatistics=(await db.query('select temp_files,temp_bytes,blk_read_time,blk_write_time from pg_stat_database where datname=current_database()')).rows[0]
  report.directSqlTimeoutVerified=settings.find(x=>x.name==='statement_timeout').setting==='10000';assert(report.directSqlTimeoutVerified);report.completed=true;report.failures=cases.filter(c=>c.error).length
 }finally{persist();await observer.end()}
 console.log('AUDIT_DESCRIPTOR_DIAGNOSTIC_TERMINAL',JSON.stringify({cases:cases.length,failures:report.failures,notCapacityProof:true,priorTimeoutStillRetained:true}))
}

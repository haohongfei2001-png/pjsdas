/** Local synthetic diagnostic only. Does not alter runtime, SQL or budgets.
 * PostgreSQL CPU is sampled from Linux per-process CPU counters (10ms ticks);
 * these include every backend of this isolated database, not arbitrary hosts.
 * temp bytes/blocks and function counts are cumulative statistics and can lag
 * until the backend flushes; they are never called exact per-request counts. */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const phases=[],coldMetrics=[]
export function recordAuditColdMetrics(value){coldMetrics.push(value)}
const ticks=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}).trim())
export function createAuditMeasure(db,calls) {
 const enabled=process.env.TA_ROW_AUDIT_MEASURE==='1'
 async function sample(){
  await db.query('select pg_stat_clear_snapshot()')
  const pids=(await db.query('select pid from pg_stat_activity where datname=current_database()')).rows.map(x=>x.pid)
  let pgCpuMs=0
  for(const pid of pids){try{const s=readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ');pgCpuMs+=(Number(s[11])+Number(s[12]))/ticks*1000}catch{}}
  const database=(await db.query('select temp_files,temp_bytes,blk_read_time,blk_write_time from pg_stat_database where datname=current_database()')).rows[0]
  const functions=(await db.query("select schemaname,funcname,calls,total_time,self_time from pg_stat_user_functions where schemaname like 'pjsdas_rows_%' order by schemaname,funcname")).rows
  const relationState=(await db.query("select n.nspname schema,c.relname,c.reltuples,c.relpages,c.reloptions from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('pjsdas_rows_candidate','pjsdas_rows_internal','public') and c.relkind='r' order by 1,2")).rows
  const statistics=(await db.query("select schemaname,tablename,attname,null_frac,avg_width,n_distinct,most_common_freqs from pg_stats where schemaname in ('pjsdas_rows_candidate','public') and attname in ('user_id','workspace_id','stage_id','command_id','collection','id','ordinal','revision','resulting_revision') order by 1,2,3")).rows
  const counts=(await db.query('select (select count(*)::int from pjsdas_rows_candidate.head) owners,(select count(*)::int from pjsdas_rows_candidate.item) items,(select count(*)::int from pjsdas_rows_candidate.ledger) row_history,(select count(*)::int from public.pjsdas_command_ledger) retained_history,(select count(*)::int from pjsdas_rows_candidate.large_stage) stages,(select count(*)::int from pjsdas_rows_candidate.large_effect) effects')).rows[0]
  return {pgCpuMs,pids,database,functions,relationState,statistics,counts,nodeCpu:process.cpuUsage(),nodeMemory:process.memoryUsage()}
 }
 return {
  async start(label){if(!enabled)return;if(process.env.TA_AUDIT_PROFILE_ONLY==='1')await db.query('analyze');const before=await sample();return{label,startedAtUtc:new Date().toISOString(),offset:calls.length,coldOffset:coldMetrics.length,before,start:performance.now()}},
  async end(token){if(!token)return;const elapsedMs=performance.now()-token.start,endedAtUtc=new Date().toISOString(),after=await sample(),requests=calls.slice(token.offset),groups=Object.groupBy(requests,x=>x.path.split('/').at(-1))
   const byRpc=Object.fromEntries(Object.entries(groups).map(([key,rows])=>[key,{requests:rows.length,requestBytes:rows.reduce((n,x)=>n+x.bytes,0),responseBytes:rows.reduce((n,x)=>n+x.responseBytes,0),httpMs:rows.reduce((n,x)=>n+x.ms,0),requestMs:rows.map(x=>x.ms)}]))
   const result={label:token.label,startedAtUtc:token.startedAtUtc,endedAtUtc,loopbackOnly:true,productionBudgetProof:false,elapsedMs,peakProvisionalDiskBytes:Math.max(0,...requests.map(x=>x.provisionalDiskBytes??0)),pgCpuMs:after.pgCpuMs-token.before.pgCpuMs,nodeHarnessCpuMs:(after.nodeCpu.user+after.nodeCpu.system-token.before.nodeCpu.user-token.before.nodeCpu.system)/1000,coldWorkerResources:coldMetrics.slice(token.coldOffset),coldWorkerCpuMs:coldMetrics.slice(token.coldOffset).reduce((sum,x)=>sum+x.userCPUTime+x.systemCPUTime,0)/1000,byRpc,before:token.before,after}
   phases.push(result);console.log('AUDIT_PHASE_MEASURE',JSON.stringify(result));if(process.env.TA_AUDIT_MEASURE_REPORT)writeFileSync(process.env.TA_AUDIT_MEASURE_REPORT,JSON.stringify({clockTicks:ticks,statFlushCanLag:true,phases},null,2))
  },
 }
}

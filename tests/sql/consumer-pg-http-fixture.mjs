/** Only the transport is bridged. Every business response is the real API's. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {performance} from 'node:perf_hooks'
import {fixture} from './workspace-rows-durable-v2-fixture.mjs'
import {sourceImport,sha,safeError} from './workspace-rows-durable-v2-source.mjs'
import {verifyConsumerSource,consumerApiPaths,safeConsumerRequests} from './consumer-pg-source.mjs'
verifyConsumerSource()
const {consumerPostgresWorkspace}=await sourceImport('tests/fixtures/consumerPostgresWorkspace.ts')

export async function consumerHttpFixture(evidence,browserOrigin){
 const browser=new URL(browserOrigin)
 assert.equal(browser.hostname,'127.0.0.1');assert.equal(browser.protocol,'http:');assert.equal(browser.origin,browserOrigin)
 const h=await fixture(evidence)
 try{
 const snapshot=consumerPostgresWorkspace(),owner=await h.consumer(snapshot)
 const requests=[],errors=[],inflight=new Set()
 let dropNext=false,receiptUnavailable=false,lostAck,receiptFailures=0,closed=false
 const server=createServer((req,res)=>{
  let stage='request-path'
  const task=(async()=>{
   assert(consumerApiPaths.includes(req.url),'Unexpected consumer API route')
   stage='request-body'
   const chunks=[];for await(const chunk of req)chunks.push(chunk)
   const rawBody=Buffer.concat(chunks).toString(),body=rawBody?JSON.parse(rawBody):undefined
   const headers=Object.fromEntries(Object.entries(req.headers).filter(([,v])=>typeof v==='string'))
   const entry={path:req.url,method:req.method,action:body?.action,commandId:body?.commandId,
    requestSha256:sha(rawBody),receivedAt:performance.now()};requests.push(entry)
   if(req.url!=='/api/health'&&req.method==='POST'){
    stage='request-authorization';entry.authorizationMatched=headers.authorization==='Bearer '+owner.accessToken
    assert(entry.authorizationMatched,'Original browser authorization must reach the API')
    stage='request-origin';entry.originMatched=headers.origin===browserOrigin
    assert(entry.originMatched,'Original browser origin must reach the API')
   }
   if(req.url==='/api/workspace'&&body?.action==='receipt'&&receiptUnavailable){receiptFailures++;entry.transportRefused=true;res.destroy();return}
   stage='read-only-bootstrap'
   if(req.url==='/api/automation-settings'&&req.method!=='OPTIONS')assert(req.method==='POST'&&body?.action==='read'&&Object.keys(body).length===1,'Only the actual passive automation status read is allowed')
   stage='original-api'
   const response=(await h.cold({path:req.url,method:req.method,rawBody,headers},{
    PJSDAS_CONNECTED_AUTHORITY:'transactional',PJSDAS_ALLOWED_WEB_ORIGINS:browserOrigin,
    PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION:'0',
   },'consumer-http')).result
   Object.assign(entry,{status:response.status,responseSha256:sha(response.rawBody),finishedAt:performance.now()})
   if(req.url==='/api/automation-settings'&&req.method==='POST'){
    stage='ancillary-automation-denial'
    // The original native fixture deliberately grants no authenticated read
    // ACL on Google bindings. Preserve its real denial; do not fabricate a
    // healthy provider or widen ACL/RLS for this workspace-recovery gate.
    assert.equal(response.status,401)
    assert(JSON.parse(response.rawBody).code==='AUTH_INVALID','Expected actual ancillary automation ACL denial')
    entry.expectedAncillaryDenial=true
   }
   if(dropNext&&body?.action==='command'){
    stage='committed-ack-proof'
    dropNext=false
    assert.equal(response.status,200,'Lost ACK requires actual API success')
    const result=JSON.parse(response.rawBody),ledger=await h.ledger(owner),current=await h.current(owner)
    assert.equal(result.outcome,'COMMITTED');assert.equal(ledger.filter(row=>row.command_id===body.commandId).length,1)
    assert.equal(current.revision,result.revision)
    lostAck={commandId:body.commandId,commandIdSha256:sha(body.commandId),revision:result.revision,
     confirmedBeforeDisconnect:true,at:performance.now()}
    receiptUnavailable=true;entry.committedAckDropped=true;res.destroy();return
   }
   res.writeHead(response.status,response.headers);res.end(response.rawBody)
  })().catch(error=>{errors.push({stage,...safeError(error)});res.destroy()})
  inflight.add(task);void task.finally(()=>inflight.delete(task))
 })
 await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok)})
 return{origin:'http://127.0.0.1:'+server.address().port,account:owner.ids.userId,accessToken:owner.accessToken,
  requests,errors,snapshot,
  safeRequests:()=>safeConsumerRequests(requests),
  armLostAck(){assert(!dropNext&&!lostAck);dropNext=true},
  get lostAck(){return lostAck},get receiptFailures(){return receiptFailures},
  restoreReceiptTransport(){assert(lostAck&&receiptFailures>0);receiptUnavailable=false},
  ledger:()=>h.ledger(owner),current:()=>h.current(owner),
  async assertNoLargeIntent(){assert.equal(Number((await h.scalar('select count(*) n from pjsdas_rows_candidate.large_command_intent where user_id=$1',[owner.ids.userId])).n),0)},
  async close(){
   if(closed)return;closed=true
   const failures=[]
   const attempt=async action=>{try{await action()}catch(error){failures.push(error)}}
   await attempt(async()=>{server.closeAllConnections();if(server.listening)await new Promise((ok,no)=>server.close(error=>error?no(error):ok()))})
   await attempt(async()=>{while(inflight.size)await Promise.allSettled([...inflight])})
   await attempt(()=>h.close())
   await attempt(()=>verifyConsumerSource())
   await attempt(()=>assert.deepEqual(errors,[],'Consumer transport fixture errors'))
   if(failures.length)throw new AggregateError(failures,'Consumer fixture cleanup failed')
  },
 }
 }catch(error){
  try{await h.close()}catch(cleanupError){throw new AggregateError([error,cleanupError],'Consumer setup and cleanup failed')}
  throw error
 }
}

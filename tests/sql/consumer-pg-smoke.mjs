/** Node-only bridge smoke. Explicitly not browser/UI/scheduler evidence. */
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {consumerHttpFixture} from './consumer-pg-http-fixture.mjs'
import {verifyConsumerSource} from './consumer-pg-source.mjs'
import {safeError,sha} from './workspace-rows-durable-v2-source.mjs'
const source=verifyConsumerSource(),directory=process.env.TA_CONSUMER_EVIDENCE
const report={contract:'consumer-pg-node-bridge-smoke-v1',sourceCommit:source.commit,sourceTree:source.tree,status:'RUNNING',actualBrowser:false,uiCreatedCommand:false}
let h,failure
try{
 h=await consumerHttpFixture(directory,'http://127.0.0.1:4176')
 const headers={origin:'http://127.0.0.1:4176',authorization:'Bearer '+h.accessToken,'content-type':'application/json'}
 const send=body=>fetch(h.origin+'/api/workspace',{method:'POST',headers,body:JSON.stringify(body)})
 const health=await fetch(h.origin+'/api/health',{headers:{origin:headers.origin}})
 assert.equal(health.status,200);assert.equal((await health.json()).workspaceAuthority,'transactional')
 const initial=await send({action:'read'});assert.equal(initial.status,200);assert.equal((await initial.json()).revision,0)
 const id='node-smoke-'+randomUUID(),input={action:'command',projection:'delta-v1',commandId:id,baseRevision:0,
  command:{type:'domain',value:{commandId:id,kind:'set_action_status',actionId:'consumer-task',status:'done'}}}
 h.armLostAck();await assert.rejects(send(input));assert(h.lostAck?.confirmedBeforeDisconnect)
 assert.equal(h.lostAck.commandId,id);assert.equal((await h.ledger()).length,1)
 assert.equal(h.requests.find(r=>r.commandId===id).requestSha256,sha(JSON.stringify(input)))
 await assert.rejects(send({action:'receipt',commandId:id,projection:'delta-v1'}));assert.equal(h.receiptFailures,1)
 h.restoreReceiptTransport()
 const recovered=await send({action:'receipt',commandId:id,projection:'delta-v1'})
 assert.equal(recovered.status,200);assert.equal((await recovered.json()).found,true)
 const undo='node-smoke-undo-'+randomUUID(),reversed=await send({action:'undo',commandId:undo,targetCommandId:id,projection:'delta-v1'})
 assert.equal(reversed.status,200);assert.equal((await reversed.json()).outcome,'COMMITTED')
 assert.deepEqual((await h.ledger()).map(row=>row.command_id),[id,undo])
 assert.equal((await h.current()).snapshot.data.actions.find(action=>action.id==='consumer-task').status,'todo')
 await h.assertNoLargeIntent()
 report.status='PASS';report.originalRequestHashMatched=true;report.committedBeforeAckLoss=true;report.ledgerEntries=2
}catch(error){failure=error;report.status='FAIL';report.error=safeError(error)}
finally{
 try{if(h)await h.close();verifyConsumerSource()}catch(error){failure??=error;report.status='FAIL';report.cleanupError=safeError(error)}
 writeFileSync(join(directory,'smoke-result.json'),JSON.stringify(report,null,2)+'\n')
}
console.log(JSON.stringify(report))
if(failure)process.exitCode=1

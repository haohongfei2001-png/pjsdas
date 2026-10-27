import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {consumerCases,verifyConsumerSource} from './consumer-pg-source.mjs'
import {safeError} from './workspace-rows-durable-v2-source.mjs'
export function verifyConsumerResults(directory,source){
 return consumerCases.map(label=>{
  const result=JSON.parse(readFileSync(join(directory,label,'result.json'))),cleanup=JSON.parse(readFileSync(join(directory,label,'cleanup.json')))
  assert.equal(result.contract,'consumer-ui-real-pg-recovery-v1');assert.equal(result.label,label);assert.equal(result.status,'PASS')
  assert.equal(result.browserName,'chromium')
  assert.equal(result.sourceCommit,source.commit);assert.equal(result.sourceTree,source.tree);assert.equal(result.prHead,source.prHeadSha)
  for(const key of ['uiCreatedCommands','mountedConsumer','httpBridgeClosed'])assert.equal(result[key],true,key)
  assert.equal(result.clockMocked,false);assert.equal(result.explicitRecoveryCalls,0);assert.equal(result.durableV2Admission,false)
  assert.equal(cleanup.contract,'ta-native-owned-cleanup-v1');assert.equal(cleanup.status,'PASS');assert.equal(cleanup.databaseCreated,true);assert.equal(cleanup.authenticatorCreated,true)
  if(label==='lost-ack-real-60s-automatic-receipt'){
   assert.equal(result.automaticIntervalCertified,true);assert(Number.isFinite(result.observedRecoveryElapsedMs)&&result.observedRecoveryElapsedMs>=50000)
  }else assert.equal(result.newPageAutomaticRecovery,true)
  if(label.startsWith('lost-ack'))assert.equal(result.commitProvenBeforeAckLoss,true)
  return{label,status:'PASS',cleanup:'PASS'}
 })
}
export function verifyConsumerRun(directory,source,browserExitCode){
 assert.equal(browserExitCode,'0','The complete browser runner, including global teardown, must pass')
 return verifyConsumerResults(directory,source)
}
if(process.argv[1]?.endsWith('/consumer-pg-results.mjs')){
 const directory=process.env.TA_CONSUMER_EVIDENCE,runner=process.env.TA_CONSUMER_BROWSER_EXIT_CODE
 let status='FAIL',cases=[],error
 try{cases=verifyConsumerRun(directory,verifyConsumerSource(),runner);status='PASS'}catch(caught){error=safeError(caught);process.exitCode=1}
 writeFileSync(join(directory,'gate-state.json'),JSON.stringify({contract:'consumer-pg-browser-gate-v1',status,cases,error,
  browserExitCode:/^\d{1,3}$/.test(runner??'')?Number(runner):null,hostedReady:false,durableV2Admission:false},null,2)+'\n')
}

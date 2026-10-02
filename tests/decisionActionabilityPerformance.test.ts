import { describe, expect, it } from 'vitest'
import { actionableDecision, partitionDecisions, type DecisionContext } from '../src/decisionActionability.js'
import { denseDecision, denseDecisionWorkspace, DENSE_NOW } from './fixtures/denseDecisionWorkspace.js'
import type { DecisionRequest } from '../src/model.js'
function countedContext(){
 const s=denseDecisionWorkspace();let opportunities=0,nodes=0
 const context:DecisionContext={get opportunities(){opportunities++;return s.data.opportunities},get scheduleNodes(){nodes++;return s.data.scheduleNodes},now:DENSE_NOW}
 return{context,counts:()=>({opportunities,nodes}),snapshot:s}
}
function valid(id:string):DecisionRequest{
 const base=denseDecision(1)
 return{...base,id,reason:'low_confidence',payloadBinding:{...base.payloadBinding,source:{...base.payloadBinding.source,kind:'mcp'},candidate:{id:'candidate',kind:'manual_action',title:'Explicit task',objectConfidence:'high',eventConfidence:'high',target:{opportunityId:'dense-job-0'},evidenceRefs:[],sourceVersionRefs:[]}}}as DecisionRequest
}
describe('bounded decision context indexing',()=>{
 it('rejects all358 missing-target decisions without scanning opportunity or schedule arrays',()=>{
  const f=countedContext(),requests=Array.from({length:358},(_,i)=>denseDecision(i));const result=partitionDecisions(requests,f.context)
  expect(result.actionable).toEqual([]);expect(result.dataQuality).toEqual(requests);expect(f.counts()).toEqual({opportunities:0,nodes:0})
 })
 it('shares exactly one context index per batch of actionable decisions',()=>{
  const f=countedContext(),requests=Array.from({length:358},(_,i)=>valid(`real-${i}`));const result=partitionDecisions(requests,f.context)
  expect(result.actionable).toEqual(requests);expect(result.dataQuality).toEqual([]);expect(f.counts()).toEqual({opportunities:1,nodes:1})
 })
 it('agrees with independent single-decision evaluation and never carries indexes across changed inputs',()=>{
  const f=countedContext(),requests=[denseDecision(1),valid('valid'),{...valid('expired'),expiresAt:'2020-01-01T00:00:00Z'}]
  const expected=requests.filter(r=>actionableDecision(r,f.context));expect(partitionDecisions(requests,f.context).actionable).toEqual(expected)
  const request=valid('target-only');(request.payloadBinding.candidate as any).kind='application_submitted';delete(request.payloadBinding.candidate as any).title
  expect(partitionDecisions([request],f.context).actionable).toHaveLength(1)
  for(const o of f.snapshot.data.opportunities)o.processStage='closed'
  expect(partitionDecisions([request],f.context).actionable).toHaveLength(0)
 })
})

it('matches the pre-optimization baseline across target, lifecycle, source-age/version and statement cases',async()=>{
 const {partitionDecisions:baseline}=await import('./fixtures/decisionActionabilityBaseline.js')
 const f=countedContext()
 for(const stage of ['not_applied','unknown','closed']as const)for(const nodeState of ['scheduled','in_progress','elapsed_unresolved','completed','cancelled','superseded']as const){
  const snapshot=structuredClone(f.snapshot);snapshot.data.opportunities[0].processStage=stage;snapshot.data.scheduleNodes![0].state=nodeState
  const context={opportunities:snapshot.data.opportunities,scheduleNodes:snapshot.data.scheduleNodes,reminderIntents:snapshot.data.reminderIntents,now:DENSE_NOW}
  const requests:DecisionRequest[]=[]
  for(const source of ['mcp','recent-gmail','old-gmail','old-future-gmail','source-version-changed'])for(const mode of ['assertion','current_intent','quote','question']){
   const r=valid(`${stage}:${nodeState}:${source}:${mode}`);r.reason='business_tradeoff' as any;r.payloadBinding.statementMode=mode as any
   const candidate=r.payloadBinding.candidate as any;candidate.kind='process_event';candidate.eventType='interview_invite';candidate.temporalConfidence='high';candidate.target={occurrenceId:snapshot.data.scheduleNodes![0].occurrenceId};delete candidate.title
   if(source!=='mcp')r.payloadBinding.source={...r.payloadBinding.source,kind:'gmail',observedAt:source==='recent-gmail'?'2026-09-28T00:00:00Z':'2020-01-01T00:00:00Z',sourceVersion:source==='source-version-changed'?'new-revision':'original-revision'}
   if(source==='old-future-gmail')candidate.dueAt='2026-10-15T00:00:00Z'
   requests.push(r)
  }
  const expected=baseline(requests,context);const actual=partitionDecisions(requests,context)
  expect(actual).toEqual(expected)
 }
})

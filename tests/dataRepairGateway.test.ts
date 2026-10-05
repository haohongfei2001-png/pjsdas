import { describe, expect, it } from 'vitest'
import { invokeApplyUserCommand, applyUserCommandSchema } from '../gateway/userCommands.js'
import { invokeWorkspaceIntegrity } from '../gateway/workspaceIntegrityTool.js'
import { invokeSemanticUndo } from '../gateway/semanticIntake.js'
import { createSnapshot } from '../src/snapshot.js'
import type { WorkspaceSource, WorkspaceWriteInput } from '../gateway/workspaceSource.js'
import type { DecisionRequest } from '../src/model.js'
const now = new Date('2026-10-05T12:00:00Z')
function fixture() {
  let version='txn:7'
  let snapshot=createSnapshot({opportunities:[],processes:[],processEvents:[{id:'synthetic-orphan',opportunityId:'synthetic-missing',company:'Example',role:'Analyst',type:'rejection',source:'email',occurredAt:now.toISOString(),createdAt:now.toISOString(),updatedAt:now.toISOString()}],actions:[],prep:[],applicationGroups:[]},now.toISOString())
  const writes:WorkspaceWriteInput[]=[]
  const source:WorkspaceSource={read:async()=>({snapshot,context:{workspaceVersion:version,now}}),write:async input=>{writes.push(input);snapshot=input.snapshot;version='txn:8';return {snapshot,context:{workspaceVersion:version,now}}}}
  return {source,writes,get snapshot(){return snapshot},setVersion:(value:string)=>{version=value}}
}
async function legacy(f:ReturnType<typeof fixture>) {
  const result=await invokeWorkspaceIntegrity(f.source,{review:{kind:'legacy_process_event',eventId:'synthetic-orphan'}})
  const review=(result.structuredContent as any).repairReview
  return {commandId:'synthetic-repair-command',kind:'invalidate_legacy_process_event',expectedWorkspaceVersion:'txn:7',eventId:'synthetic-orphan',expectedEventFingerprint:review.expectedEventFingerprint,sourceRefs:review.sourceRefs,reason:'Synthetic reviewed duplicate',evidenceRefs:['synthetic:verified']}
}
describe('bounded repair gateway',()=>{
  it('returns exact reviewed evidence and persists one audited CAS write',async()=>{
    const f=fixture(), command=await legacy(f)
    const result=await invokeApplyUserCommand(f.source,command)
    expect(result.isError).not.toBe(true);expect(f.writes).toHaveLength(1)
    expect(f.writes[0]).toMatchObject({expectedWorkspaceVersion:'txn:7',command:{commandId:command.commandId,operation:command.kind,payload:command}})
    expect((await invokeApplyUserCommand(f.source,command)).structuredContent).toMatchObject({alreadyApplied:true})
    expect(f.writes).toHaveLength(1)
  })
  it('requires explicit reviewed revision and rejects stale review before any write',async()=>{
    const f=fixture(), command=await legacy(f)
    const {expectedWorkspaceVersion:_,...missing}=command
    expect(applyUserCommandSchema.safeParse(missing).success).toBe(false)
    f.setVersion('txn:9')
    const result=await invokeApplyUserCommand(f.source,command)
    expect(result.structuredContent).toMatchObject({code:'CONFLICT'});expect(f.writes).toHaveLength(0)
    expect(f.snapshot.data.processEvents[0].invalidation).toBeUndefined()
  })
  it('cannot use repairs through a read-only workspace source',async()=>{
    const f=fixture(), command=await legacy(f)
    const result=await invokeApplyUserCommand({read:f.source.read},command)
    expect(result.isError).toBe(true);expect(f.writes).toHaveLength(0)
  })
  it('dismisses an invalid question without applying any offered target and undoes through the ledger',async()=>{
    const f=fixture()
    const request:DecisionRequest={id:'synthetic-decision',reason:'ambiguous_target',affectedObjects:[],question:'Which role?',choices:[{id:'one',label:'One',consequence:'Record one',resolution:{opportunityId:'one'}},{id:'two',label:'Two',consequence:'Record two',resolution:{opportunityId:'two'}}],evidenceRefs:['synthetic:source'],payloadBinding:{contractVersion:1,inputId:'synthetic-input',candidateId:'candidate',source:{kind:'gmail',sourceId:'gmail:synthetic',sourceRecordId:'synthetic-message',observedAt:now.toISOString(),timezone:'UTC'},statementMode:'assertion',candidate:{id:'candidate',kind:'process_event',eventType:'rejection',objectConfidence:'low',eventConfidence:'high',evidenceRefs:['synthetic:source'],sourceVersionRefs:[]}},state:'open',createdAt:now.toISOString(),updatedAt:now.toISOString()}
    f.snapshot.data.decisionRequests!.push(request)
    const review=(await invokeWorkspaceIntegrity(f.source,{review:{kind:'decision_request',requestId:request.id}})).structuredContent as any
    const result=await invokeApplyUserCommand(f.source,{commandId:'synthetic-dismiss-command',kind:'dismiss_semantic_decision',expectedWorkspaceVersion:'txn:7',requestId:request.id,expectedRequestUpdatedAt:review.repairReview.expectedRequestUpdatedAt,expectedFingerprint:review.repairReview.expectedFingerprint,reason:'No valid candidate',evidenceRefs:['synthetic:review']})
    expect(result.isError).not.toBe(true);expect(f.snapshot.data.decisionRequests![0].state).toBe('dismissed');expect(f.snapshot.data.processEvents).toHaveLength(1)
    f.source.prepareUndo=async()=>({outcome:'READY',snapshot:f.snapshot,expectedWorkspaceVersion:'txn:8',compensation:f.writes[0].command!.compensation!})
    const undone=await invokeSemanticUndo(f.source,{targetCommandId:'synthetic-dismiss-command'})
    expect(undone.isError).not.toBe(true);expect(f.snapshot.data.decisionRequests![0].state).toBe('open')
  })
})

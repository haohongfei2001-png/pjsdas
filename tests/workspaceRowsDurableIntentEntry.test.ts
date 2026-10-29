import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { largeAbandonFixture } from './fixtures/workspaceRowsLargeCommand.js'
import { upgradeSnapshotToLatest } from '../src/snapshot.js'
import * as core from '../src/domainCommands.js'
import { WorkspaceSourceError } from '../gateway/workspaceSource.js'
const userId='11111111-1111-4111-8111-111111111111',workspaceId='22222222-2222-4222-8222-222222222222',epoch='33333333-3333-4333-8333-333333333333'
afterEach(()=>vi.restoreAllMocks())
function setup(undo=false){
 const f=largeAbandonFixture(),snapshot=JSON.parse(JSON.stringify(upgradeSnapshotToLatest(undo?f.result.snapshot:f.before))),revision=undo?1:0
 const before={userId,workspaceId,epoch,revision,snapshot},receipt={commandId:undo?'synthetic-cold-undo':f.command.commandId,operation:undo?'undo_command':'domain:abandon_opportunity',status:'COMMITTED',revision:revision+1,contractVersion:5,result:{original:true}}
 const commit=vi.fn(),resumePrepared=vi.fn(async()=>({outcome:'COMMITTED' as const,workspaceId,revision:revision+1,snapshot:undo?f.undo:f.result.snapshot,receipt}))
 const history=vi.fn(async(_u,_e,q)=>({userId,workspaceId,epoch,revision,rows:undo&&q.commandId===f.command.commandId?[{command_id:f.command.commandId,operation:'domain:abandon_opportunity',payload_hash:'a'.repeat(64),resulting_revision:1,status:'COMMITTED',receipt:{operation:'domain:abandon_opportunity',status:'COMMITTED'},compensation:f.result.compensation}]:[]}))
 const executor=createAuthoritativeCommandExecutor({supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',fetchImpl:vi.fn(async()=>Response.json([{id:workspaceId,user_id:userId,row_candidate_epoch:epoch}])),
  rowLayoutReader:{read:vi.fn(async()=>before),readIdentity:vi.fn(async()=>({...before,schemaVersion:4})),readHistory:history},rowLayoutWriter:{commit,resumePrepared}})
 return {f,executor,commit,resumePrepared,receipt,history}
}
describe('durable entry does not re-evaluate original command',()=>{
 it('resumes before any domain reducer or changed-clock draft exists',async()=>{
  const h=setup(),apply=vi.spyOn(core,'applyUserDomainCommand').mockImplementation(()=>{throw Error('CORE_MUST_NOT_RUN')})
  const result=await h.executor.execute({kind:'first_party_web',userId},{commandId:h.f.command.commandId,baseRevision:0,command:{type:'domain',value:h.f.command}})
  expect(result.receipt).toEqual(h.receipt);expect(apply).not.toHaveBeenCalled();expect(h.commit).not.toHaveBeenCalled();expect(h.resumePrepared).toHaveBeenCalledTimes(1)
 })
 it('resumes original Undo before compensation reducer',async()=>{
  const h=setup(true),apply=vi.spyOn(core,'applyDomainCompensation').mockImplementation(()=>{throw Error('UNDO_CORE_MUST_NOT_RUN')})
  const result=await h.executor.undo({kind:'first_party_web',userId},{commandId:'synthetic-cold-undo',targetCommandId:h.f.command.commandId})
  expect(result.receipt).toEqual(h.receipt);expect(apply).not.toHaveBeenCalled();expect(h.commit).not.toHaveBeenCalled();expect(h.resumePrepared).toHaveBeenCalledTimes(1)
 })
 it('does not convert an expired or uncertain original intent into another reducer/admission attempt',async()=>{
  const h=setup(),apply=vi.spyOn(core,'applyUserDomainCommand').mockImplementation(()=>{throw Error('CORE_MUST_NOT_RUN')})
  h.resumePrepared.mockRejectedValue(new WorkspaceSourceError('WORKSPACE_UNAVAILABLE','Original absolute deadline expired',true))
  await expect(h.executor.execute({kind:'first_party_web',userId},{commandId:h.f.command.commandId,baseRevision:0,command:{type:'domain',value:h.f.command}})).rejects.toMatchObject({code:'WORKSPACE_UNAVAILABLE'})
  expect(apply).not.toHaveBeenCalled();expect(h.commit).not.toHaveBeenCalled();expect(h.resumePrepared).toHaveBeenCalledTimes(1)
 })
})

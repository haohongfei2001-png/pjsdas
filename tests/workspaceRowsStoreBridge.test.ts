import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceRowsStoreBridge } from '../gateway/workspaceRowsStoreBridge'
import { createSnapshot } from '../src/snapshot'
const userId='11111111-1111-4111-8111-111111111111',workspaceId='22222222-2222-4222-8222-222222222222',rowEpoch='33333333-3333-4333-8333-333333333333',grantId='44444444-4444-4444-8444-444444444444'
const snapshot=createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[]},'2030-01-01T00:00:00Z')
const before={userId,workspaceId,rowEpoch,revision:0,schemaVersion:4,snapshot}
describe('isolated central row writer dispatch',()=>{
 it.each([[2,'business_management','commit_management_v2'],[3,'opportunity_management','commit_opportunity'],[4,'planning_management','commit_planning'],[5,'discovery_profile_management','commit_discovery_profile'],[6,'private_reminder_management','commit_private_reminder'],[7,'business_management','commit_business']] as const)('keeps original consent %s on its own SQL endpoint',async(consentVersion,operation,rpc)=>{
  const fetchImpl=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
   const body=JSON.parse(init!.body as string)
   expect(body.target_grant_id).toBe(grantId);expect(body.req).not.toHaveProperty('rowPreimage');expect(body.req).not.toHaveProperty('managementAuthorization')
   return new Response(JSON.stringify({outcome:'COMMITTED',revision:1,receipt:{commandId:'synthetic',operation,status:'COMMITTED',revision:1,managementAuthorization:{grantId,grantRevision:1,consentVersion}}}))
  })
  const bridge=createWorkspaceRowsStoreBridge({supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',readsEnabled:true,writesEnabled:true,fetchImpl})
  const result=await bridge.rowLayoutWriter!.commit(before,{userId,commandId:'synthetic',operation,payloadHash:'a'.repeat(64),expectedRevision:0,snapshot,schemaVersion:4,principalKind:'delegated_mcp',clientId:userId,receiptContext:{},managementAuthorization:{grantId,grantRevision:1,consentVersion}})
  expect(result.outcome).toBe('COMMITTED');expect(String(fetchImpl.mock.calls[0][0])).toBe('https://synthetic.invalid/rpc/'+rpc)
 })
 it('keeps an original stale expected revision and no-op effects for replay-before-CAS',async()=>{
  const fetchImpl=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
   const req=JSON.parse(init!.body as string).req
   expect(req.expectedRevision).toBe(0);expect(req.changes).toEqual([]);expect(req.afterEnvelope).toEqual(req.beforeEnvelope)
   return new Response(JSON.stringify({outcome:'ALREADY_APPLIED',revision:1,receipt:{commandId:'synthetic',operation:'SnapshotWrite',status:'COMMITTED',revision:1}}))
  })
  const bridge=createWorkspaceRowsStoreBridge({supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',readsEnabled:true,writesEnabled:true,fetchImpl})
  expect((await bridge.rowLayoutWriter!.commit({...before,revision:5},{userId,commandId:'synthetic',operation:'SnapshotWrite',payloadHash:'a'.repeat(64),expectedRevision:0,snapshot:{...snapshot,exportedAt:'2031-01-01'},schemaVersion:4,principalKind:'first_party_web',receiptContext:{}})).outcome).toBe('ALREADY_APPLIED')
 })
 it('stays off without switches and never treats a denied guard as a base-write fallback',async()=>{
  const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({code:'42501'}),{status:403}))
  const input={userId,commandId:'synthetic',operation:'SnapshotWrite',payloadHash:'a'.repeat(64),expectedRevision:0,snapshot,schemaVersion:4,principalKind:'first_party_web' as const,receiptContext:{}}
  const off=createWorkspaceRowsStoreBridge({supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',fetchImpl})
  await expect(off.rowLayoutWriter!.commit(before,input)).rejects.toMatchObject({code:'WORKSPACE_CONFLICT',retryable:false});expect(fetchImpl).not.toHaveBeenCalled()
  const active=createWorkspaceRowsStoreBridge({supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',readsEnabled:true,writesEnabled:true,fetchImpl})
  await expect(active.rowLayoutWriter!.commit(before,input)).rejects.toMatchObject({code:'AUTH_FORBIDDEN',retryable:false});expect(fetchImpl).toHaveBeenCalledTimes(1)
 })
})

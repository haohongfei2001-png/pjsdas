import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDiscoveryAutomationForBinding, discoverSourceRun } from '../gateway/discoveryAutomationWorker.js'
import { applyDiscoveryProfileManagement, getDiscoveryProfileManagementRead } from '../src/discoveryProfileManagement.js'
import { buildDiscoveryAutomationPlan } from '../src/discoveryAutomation.js'
import { buildContinuousDiscoverySummary } from '../src/continuousDiscovery.js'
import { effectiveSourceRegistry } from '../src/sourceRegistry.js'
import { unknownDeadlineWorkspace } from './fixtures/unknownDeadlineWorkspace.js'
import { syntheticDiscoveryBudget, syntheticReserveDiscoverySpend } from './fixtures/discoveryBudget.js'
const owner='00000000-0000-4000-8000-000000000001'
const now=new Date('2026-10-02T21:00:00Z')
afterEach(()=>vi.unstubAllEnvs())
async function configured(){const snapshot=unknownDeadlineWorkspace(1);delete snapshot.data.discoveryProfile;return (await applyDiscoveryProfileManagement(snapshot,{kind:'patch_discovery_profile',expectedFingerprint:(await getDiscoveryProfileManagementRead(snapshot)).fingerprint,patch:{targetRoleQueries:['Explicit role'],preferredLocations:['Explicit city'],notes:'Explicit note',strengths:['Explicit strength'],maxReviewCandidates:4}},'worker-profile-command',now)).snapshot}
function options(snapshot:any,generateTextImpl:any){
 vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY','transactional');vi.stubEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY','fixture-only')
 const fetchImpl=vi.fn<typeof fetch>(async(input,init)=>{expect(init?.method??'GET').toBe('GET');expect(new URL(String(input)).pathname).toMatch(/pjsdas_workspaces$/);return Response.json([{id:owner,user_id:owner,snapshot,revision:1,schema_version:snapshot.version}])})
 return {binding:{userId:owner,refreshTokenCiphertext:'fixture-unused'},tokenEncryptionKey:'fixture-unused',googleClientId:'fixture-unused',googleClientSecret:'fixture-unused',fetchImpl,generateTextImpl,now:()=>now}
}
describe('discovery-profile changes do not authorize paid searches',()=>{
 it('reset causes a subsequent actual worker run to stop before model/provider or workspace writes',async()=>{
  const snapshot=await configured();const reset=await applyDiscoveryProfileManagement(snapshot,{kind:'reset_discovery_profile',expectedFingerprint:(await getDiscoveryProfileManagementRead(snapshot)).fingerprint},'reset-worker-profile',now)
  const generate=vi.fn(async()=>{throw new Error('Must not run')});const input=options(reset.snapshot,generate)
  const result=await runDiscoveryAutomationForBinding(input)
  expect(result).toMatchObject({state:'not_configured',configured:false,completedSourceCount:0});expect(generate).not.toHaveBeenCalled();expect(input.fetchImpl).toHaveBeenCalledTimes(1)
 })
 it.each([false,true])('configured normal/forced=%s worker still requires independent spend reservation',async force=>{
  const generate=vi.fn(async()=>{throw new Error('Must not run')})
  await expect(runDiscoveryAutomationForBinding({...options(await configured(),generate),force})).rejects.toMatchObject({code:'DISCOVERY_BUDGET_APPROVAL_REQUIRED'})
  expect(generate).not.toHaveBeenCalled()
 })
 it('explicit role/location/result allowance change future plans, retaining source cadence and provider boundary',async()=>{
  const snapshot=await configured();const summary=buildContinuousDiscoverySummary({changeSets:[],opportunities:snapshot.data.opportunities,inbox:[],now});const sources=effectiveSourceRegistry(snapshot.data.timeline)
  const plan=buildDiscoveryAutomationPlan({profile:snapshot.data.discoveryProfile,continuousDiscovery:summary,sources})
  const source=plan.sourceRuns.find(item=>item.sourceId==='monitor:urgent-campus')!
  expect(source.queryHints.join(' ')).toContain('Explicit role Explicit city');expect(source.maxObservations).toBe(12)
  expect(source.cadenceMinutes).toBe(sources.find(item=>item.sourceId===source.sourceId)!.cadenceMinutes)
  const generate=vi.fn(async()=>({text:'{"observations":[]}'}))
  await discoverSourceRun(snapshot,source,{executionRules:[],now,ai:{...syntheticDiscoveryBudget,generateTextImpl:generate},fetchImpl:async()=>{throw new Error('No source observations need verification')}})
  expect(generate).toHaveBeenCalledTimes(1);const prompt=generate.mock.calls[0][0] as any
  expect(prompt.prompt).toContain('Explicit note');expect(prompt.prompt).toContain('Explicit strength');expect(prompt.maxRetries).toBe(0)
 })
})

it.each(['reset','patch'])('skips already-running old-profile ingestion after %s without another search',async mode=>{
 const initial=await configured();let current=initial;let generated=0;let writes=0
 const input=options(initial,async()=>{generated++;current=mode==='reset'?{...initial,data:{...initial.data,discoveryProfile:undefined}}:{...initial,data:{...initial.data,discoveryProfile:{...initial.data.discoveryProfile!,notes:'New instruction'}}};return {text:'{"observations":[]}'}})
 const fetchImpl:typeof fetch=async(input,init)=>{if(init?.method==='POST'){writes++;throw new Error('Obsolete results must never commit')}expect(new URL(String(input)).pathname).toMatch(/pjsdas_workspaces$/);return Response.json([{id:owner,user_id:owner,snapshot:current,revision:current===initial?1:2,schema_version:current.version}])}
 const result=await runDiscoveryAutomationForBinding({...input,fetchImpl,reserveSpend:syntheticReserveDiscoverySpend,force:true})
 expect(result.dueSourceCount).toBeGreaterThan(0);expect(generated).toBe(result.dueSourceCount);expect(writes).toBe(0)
 expect(result).toMatchObject({state:'verified_not_committed',completedSourceCount:0,skippedSourceCount:result.dueSourceCount})
})

it('rechecks profile after an ingestion CAS conflict and skips without repeating model work',async()=>{
 const initial=await configured();let current=initial;let generated=0;let attempts=0
 const input=options(initial,async()=>{generated++;return {text:'{"observations":[]}'}})
 const fetchImpl:typeof fetch=async(input,init)=>{
  if(init?.method==='POST'){
   attempts++;expect(attempts).toBe(1)
   expect(new URL(String(input)).pathname).toBe('/rest/v1/rpc/pjsdas_commit_workspace_v2')
   current={...initial,data:{...initial.data,discoveryProfile:{...initial.data.discoveryProfile!,notes:'Changed during CAS'}}}
   return Response.json([{outcome:'CONFLICT',workspace_id:owner,revision:2,snapshot:current,receipt:{}}])
  }
  return Response.json([{id:owner,user_id:owner,snapshot:current,revision:current===initial?1:2,schema_version:current.version}])
 }
 const result=await runDiscoveryAutomationForBinding({...input,fetchImpl,reserveSpend:syntheticReserveDiscoverySpend,force:true})
 expect(attempts).toBe(1);expect(generated).toBe(result.dueSourceCount);expect(result.skippedSourceCount).toBe(result.dueSourceCount);expect(result.completedSourceCount).toBe(0)
 expect(current.data.discoveryProfile!.notes).toBe('Changed during CAS')
})

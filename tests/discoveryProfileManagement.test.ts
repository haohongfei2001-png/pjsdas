import { describe, expect, it } from 'vitest'
import { applyDiscoveryProfileManagement as apply, discoveryProfileManagementSchema as schema, getDiscoveryProfileManagementRead as read, restoreDiscoveryProfileManagement as restore, discoveryProfileManagementFingerprint as fingerprint } from '../src/discoveryProfileManagement.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { unknownDeadlineWorkspace } from './fixtures/unknownDeadlineWorkspace.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'
const NOW = new Date('2026-10-02T21:00:00Z')
function fixture(): PJSDASSnapshot { const s = upgradeSnapshotToLatest(unknownDeadlineWorkspace(1)); delete s.data.discoveryProfile; return s }
async function patch(s: PJSDASSnapshot, value: any, id = 'profile-command') { return apply(s, { kind: 'patch_discovery_profile', expectedFingerprint: (await read(s)).fingerprint, patch: value }, id, NOW) }
const fields = [
  ['targetRoleQueries', ['Product manager']], ['preferredLocations', ['Shanghai']], ['locationNotes', 'Only with transit'],
  ['mustHave', ['Growth']], ['mustNotHave', ['Night shifts']], ['strengths', ['Analysis']], ['notes', 'Explicit user preference'],
  ['minimumAnnualCompensationWan', 30], ['preferredRoleTypes', ['core', 'backup']], ['locationPolicy', 'strict'],
  ['maxReviewCandidates', 8],
] as const
const optional = ['minimumAnnualCompensationWan', 'preferredRoleTypes', 'locationPolicy', 'maxReviewCandidates']
function protectedData(s: PJSDASSnapshot) { return Object.fromEntries(Object.entries(s.data).filter(([key]) => !['discoveryProfile', 'timeline'].includes(key))) }
describe('raw-preserving discovery profile management v5', () => {
  it.each(['minimumFitScore', 'minimumOpportunityValue'])('rejects retired %s edits and preserves historical storage', async key => {
    const current = fixture(); current.data.discoveryProfile = { ...createDefaultDiscoveryProfile(), minimumFitScore: 70, minimumOpportunityValue: 80 }
    const before = structuredClone(current)
    await expect(patch(current, { [key]: 99 })).rejects.toMatchObject({ code: 'SCORING_RETIRED' })
    await expect(patch(current, { [key]: null })).rejects.toMatchObject({ code: 'SCORING_RETIRED' })
    const result = await patch(current, { notes: 'New factual preference' })
    expect(result.snapshot.data.discoveryProfile).toMatchObject({ minimumFitScore: 70, minimumOpportunityValue: 80 })
    expect(restore(result.snapshot, result.compensation!, NOW).data.discoveryProfile).toEqual(before.data.discoveryProfile)
    expect(current).toEqual(before)
  })
  it('reads absent raw state, effective defaults, fingerprint and not-configured truth', async () => {
    const s=fixture(); const before=structuredClone(s); const v=await read(s)
    expect(v).toMatchObject({raw:null,configured:false,effective:{maxReviewCandidates:6,locationPolicy:'prefer'}})
    expect(v.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(s).toEqual(before)
  })
  it.each(fields)('patches %s and restores exact absence', async (key, value) => {
    const s=fixture(); const before=structuredClone(s); const result=await patch(s,{[key]:value})
    expect(result.status).toBe('APPLIED'); expect(result.snapshot.data.discoveryProfile![key]).toEqual(value)
    expect(result.objects).toEqual([{type:'discovery_profile',id:'current'}]);expect(result.compensationFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(protectedData(result.snapshot)).toEqual(protectedData(s));expect(s).toEqual(before)
    const undone=restore(result.snapshot,result.compensation!,NOW);expect(undone.data.discoveryProfile).toBeUndefined();expect(protectedData(undone)).toEqual(protectedData(s))
    expect(undone.data.timeline).toEqual(result.snapshot.data.timeline)
  })
  it.each(optional)('clears optional %s explicitly and preserves absent fields', async key => {
    const s=fixture();s.data.discoveryProfile=Object.assign(createDefaultDiscoveryProfile('2026-10-01T00:00:00Z'),Object.fromEntries(fields))
    const result=await patch(s,{[key]:null});expect(result.snapshot.data.discoveryProfile).not.toHaveProperty(key)
    expect(restore(result.snapshot,result.compensation!,NOW).data.discoveryProfile).toEqual(s.data.discoveryProfile)
  })
  it.each(optional)('does not manufacture a default row when clearing absent %s', async key => {
    const s=fixture();const result=await patch(s,{[key]:null});expect(result.status).toBe('ALREADY_APPLIED');expect(result.snapshot).toBe(s)
  })
  it.each([['targetRoleQueries',[]],['preferredLocations',[]],['locationNotes',''],['mustHave',[]],['mustNotHave',[]],['strengths',[]],['notes','']])('clears required %s with its empty value', async (key,value) => {
    const s=fixture();s.data.discoveryProfile=Object.assign(createDefaultDiscoveryProfile('2026-10-01T00:00:00Z'),Object.fromEntries(fields))
    const result=await patch(s,{[String(key)]:value});expect(result.snapshot.data.discoveryProfile![key as keyof typeof s.data.discoveryProfile]).toEqual(value)
  })
  it('preserves untouched whitespace, duplicates, absent optionals and future metadata through patch/restore', async () => {
    const s=fixture();s.data.discoveryProfile={key:'current',version:1,targetRoleQueries:[' Raw Role ','Raw Role'],preferredLocations:[' City '],locationNotes:' raw ',mustHave:[],mustNotHave:[],strengths:[],notes:' old ',updatedAt:'2026-10-01T00:00:00Z',future:{nested:['retain']}} as any
    const result=await patch(s,{notes:'New explicit text'});const expected={...s.data.discoveryProfile,notes:'New explicit text',updatedAt:NOW.toISOString()}
    expect(result.snapshot.data.discoveryProfile).toEqual(expected);expect(result.snapshot.data.discoveryProfile).not.toHaveProperty('maxReviewCandidates')
    expect(restore(result.snapshot,result.compensation!,NOW).data.discoveryProfile).toEqual(s.data.discoveryProfile)
  })
  it('reset removes raw row; restore keeps new unrelated data and append-only audit', async () => {
    const s=fixture();s.data.discoveryProfile=Object.assign(createDefaultDiscoveryProfile('2026-10-01T00:00:00Z'),{notes:'Keep this exact profile'})
    const result=await apply(s,{kind:'reset_discovery_profile',expectedFingerprint:(await read(s)).fingerprint},'profile-reset',NOW)
    expect((await read(result.snapshot)).configured).toBe(false)
    result.snapshot.data.opportunities[0].company='New unrelated company'
    const restored=restore(result.snapshot,result.compensation!,NOW);expect(restored.data.discoveryProfile).toEqual(s.data.discoveryProfile)
    expect(restored.data.opportunities[0].company).toBe('New unrelated company');expect(restored.data.timeline).toEqual(result.snapshot.data.timeline)
  })
  it('no-op patch/reset preserve exact row, timestamps and history', async () => {
    const s=fixture();const reset=await apply(s,{kind:'reset_discovery_profile',expectedFingerprint:(await read(s)).fingerprint},'no-op-reset',NOW)
    expect(reset.snapshot).toBe(s);expect(reset.compensation).toBeUndefined()
    s.data.discoveryProfile=createDefaultDiscoveryProfile('2026-10-01T00:00:00Z');const result=await patch(s,{notes:''})
    expect(result.snapshot).toBe(s);expect(result.status).toBe('ALREADY_APPLIED')
  })
  it('rejects stale profile and restore after a newer profile edit',async()=>{
    const s=fixture();await expect(apply(s,{kind:'reset_discovery_profile',expectedFingerprint:'f'.repeat(64)},'stale-command',NOW)).rejects.toThrow(/changed/)
    const first=await patch(s,{notes:'first'});const second=await patch(first.snapshot,{notes:'second'},'second-command')
    expect(()=>restore(second.snapshot,first.compensation!,NOW)).toThrow(/newer data/)
  })
  it.each([{},{kind:'patch_discovery_profile',patch:{}},{notes:'x',ownerId:'foreign'}])('rejects malformed command %#',bad=>{expect(schema.safeParse(bad).success).toBe(false)})
  it.each(['key','version','updatedAt','provider','apiKey','budget','grant','accountId','clientId','__proto__'])('rejects writable metadata/security key %s',async key=>{
    const value=JSON.parse(`{"${key}":"injected"}`);await expect(patch(fixture(),value)).rejects.toThrow()
  })
  it.each([{notes:null},{targetRoleQueries:null},{targetRoleQueries:['']},{targetRoleQueries:['x'.repeat(161)]},{targetRoleQueries:Array(31).fill('a')},{notes:'x'.repeat(2401)},{locationNotes:'x'.repeat(1201)},{minimumAnnualCompensationWan:-1},{minimumAnnualCompensationWan:1001},{minimumFitScore:101},{minimumOpportunityValue:-1},{maxReviewCandidates:0},{maxReviewCandidates:13},{maxReviewCandidates:1.5},{preferredRoleTypes:['arbitrary']},{locationPolicy:'nearby'},{notes:undefined},{}])('rejects invalid field patch %#',async value=>{await expect(patch(fixture(),value)).rejects.toThrow()})
  it('rejects malformed stored row and missing raw collections without hidden repair',async()=>{
    const s=fixture();s.data.discoveryProfile={...createDefaultDiscoveryProfile(),notes:null} as any
    await expect(read(s)).rejects.toThrow();delete s.data.discoveryProfile;delete s.data.reminderIntents
    await expect(read(s)).rejects.toThrow(/migration/)
  })
  it('retains legacy dates and cancelled nodes without upgrading unrelated semantics',async()=>{
    const s=unknownDeadlineWorkspace(1);s.data.actions[0].dueAt='2026-08-27T15:59:59Z';s.data.actions[0].timingMode='deadline'
    const result=await patch(s,{notes:'New note'});expect(protectedData(result.snapshot)).toEqual(protectedData(s))
    expect(protectedData(restore(result.snapshot,result.compensation!,NOW))).toEqual(protectedData(s))
  })
  it('refuses malformed compensation, no-op evidence and oversize or non-JSON fingerprints',async()=>{
    const s=fixture();const result=await patch(s,{notes:'New'})
    for(const value of [null,{}, {...result.compensation,payload:{...result.compensation!.payload,ownerId:'foreign'}}, {...result.compensation,payload:{before:null,after:null}}, {...result.compensation,operation:'business_management_restore'}]) expect(()=>restore(result.snapshot,value as any,NOW)).toThrow(/invalid/)
    await expect(fingerprint({x:Infinity})).rejects.toThrow(/finite JSON/)
    await expect(fingerprint('x'.repeat(1048577))).rejects.toThrow(/limit/)
  })
})

describe('profile evidence preserves accepted raw metadata limits',()=>{
  it.each(['deep','wide'])('patch/reset/restore accepted %s metadata without a smaller compensation budget',async kind=>{
    const s=fixture();let metadata: any=0;if(kind==='deep')for(let i=0;i<30;i++)metadata={child:metadata};else metadata=Array(34000).fill(0)
    s.data.discoveryProfile={...createDefaultDiscoveryProfile('2026-10-01T00:00:00Z'),metadata} as any
    await read(s)
    const changed=await patch(s,{notes:'Changed'})
    expect(changed.compensationFingerprint).toBe(await fingerprint(changed.compensation))
    expect(restore(changed.snapshot,changed.compensation!,NOW).data.discoveryProfile).toEqual(s.data.discoveryProfile)
    const reset=await apply(s,{kind:'reset_discovery_profile',expectedFingerprint:(await read(s)).fingerprint},'bounded-reset',NOW)
    expect(restore(reset.snapshot,reset.compensation!,NOW).data.discoveryProfile).toEqual(s.data.discoveryProfile)
  })
})

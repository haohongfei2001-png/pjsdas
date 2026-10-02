import { describe, expect, it } from 'vitest'
import { applyBusinessManagement, businessManagementSchema, restoreBusinessManagement, readBusinessManagement } from '../src/businessManagement.js'
import { assertBusinessManagementGrant, type BusinessManagementGrant } from '../gateway/businessManagementAccess.js'
import { createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
const now = new Date('2026-10-02T12:00:00Z')
function snapshot(): PJSDASSnapshot { return { schema:'pjsdas-local-snapshot',version:4,exportedAt:now.toISOString(),data:{opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[],scheduleNodes:[]} } }
const createPrep = {kind:'create_prep',value:{title:'Synthetic preparation',estimatedMinutes:30}}
function apply(operations: unknown[], initial = snapshot(), commandId='synthetic-command-1') { return applyBusinessManagement(initial,{operations},commandId,now) }

describe('consumer business management foundation',()=>{
  it('creates existing prep, manual action and group entities with server-owned IDs',()=>{
    const result=apply([createPrep,{kind:'create_manual_action',value:{title:'Sample task',estimatedMinutes:20}},{kind:'create_application_group',value:{company:'Synthetic Co',total:2}}])
    expect(result.snapshot.data.prep[0]).toMatchObject({id:'managed:prep:synthetic-command-1:0',title:'Synthetic preparation'})
    expect(result.snapshot.data.actions[0]).toMatchObject({kind:'manual',status:'todo',leverage:50})
    expect(result.snapshot.data.applicationGroups[0]).toMatchObject({company:'Synthetic Co',total:2})
    expect(result.compensation?.payload.changes).toHaveLength(3)
    expect(result.snapshot.data.timeline).toHaveLength(1)
  })
  it('reads exact own-workspace objects and paginates without mutating them',()=>{
    const first=apply([createPrep,createPrep,createPrep])
    const page=readBusinessManagement(first.snapshot,{type:'prep',limit:2})
    expect(page.items).toHaveLength(2)
    expect(readBusinessManagement(first.snapshot,{type:'prep',afterId:page.nextAfterId}).items).toHaveLength(1)
    expect(readBusinessManagement(first.snapshot,{type:'prep',ids:['foreign-or-missing']}).items).toEqual([])
    ;(page.items[0] as {title:string}).title='Mutated response'
    expect(first.snapshot.data.prep[0].title).toBe('Synthetic preparation')
  })
  it('rejects injected owner, arbitrary scores, timestamps and permanent deletion',()=>{
    for(const operation of [
      {...createPrep,value:{...createPrep.value,ownerId:'another-account'}},
      {kind:'update_prep',id:'a',patch:{updatedAt:now.toISOString()}},
      {kind:'update_manual_action',id:'a',patch:{status:'done'}},
      {kind:'update_application_group',id:'a',patch:{used:4}},
      {kind:'purge_prep',id:'a'},
    ]) expect(businessManagementSchema.safeParse({operations:[operation]}).success).toBe(false)
  })
  it('rejects empty changes, unknown domain and oversized batches',()=>{
    for(const operations of [[],Array(51).fill(createPrep),[{kind:'update_prep',id:'a',patch:{}}],[{kind:'create_material',value:{title:'a'}}]]) expect(businessManagementSchema.safeParse({operations}).success).toBe(false)
  })
  it('patches and clears optional fields without changing input snapshots',()=>{
    const first=apply([{...createPrep,value:{...createPrep.value,minimumOutput:'sample'}}])
    const before=structuredClone(first.snapshot)
    const result=apply([{kind:'update_prep',id:first.objects[0].id,patch:{minimumOutput:null,title:'Updated'}}],first.snapshot,'synthetic-command-2')
    expect(result.snapshot.data.prep[0].minimumOutput).toBeUndefined()
    expect(result.snapshot.data.prep[0].title).toBe('Updated')
    expect(first.snapshot).toEqual(before)
  })
  it('archives retain the whole object in compensation and restore safely',()=>{
    const first=apply([createPrep])
    const removed=apply([{kind:'archive_prep',id:first.objects[0].id}],first.snapshot,'synthetic-command-2')
    expect(removed.snapshot.data.prep).toEqual([])
    expect(removed.compensation?.payload.changes[0].before).toEqual(first.snapshot.data.prep[0])
    const restored=restoreBusinessManagement(removed.snapshot,removed.compensation!,now)
    expect(restored.data.prep).toEqual(first.snapshot.data.prep)
    expect(restored.data.timeline).toHaveLength(2)
  })
  it('restoration refuses collision instead of clobbering a newer object',()=>{
    const first=apply([createPrep])
    const removed=apply([{kind:'archive_prep',id:first.objects[0].id}],first.snapshot,'synthetic-command-2')
    removed.snapshot.data.prep.push({...first.snapshot.data.prep[0],title:'Newer'})
    expect(()=>restoreBusinessManagement(removed.snapshot,removed.compensation!,now)).toThrow(/newer data/)
  })
  it('undo of update preserves unrelated later objects and detects target edits',()=>{
    const first=apply([createPrep])
    const updated=apply([{kind:'update_prep',id:first.objects[0].id,patch:{title:'Updated'}}],first.snapshot,'synthetic-command-2')
    const later=apply([createPrep],updated.snapshot,'synthetic-command-3')
    const restored=restoreBusinessManagement(later.snapshot,updated.compensation!,now)
    expect(restored.data.prep.find(item=>item.id===first.objects[0].id)?.title).toBe('Synthetic preparation')
    expect(restored.data.prep).toHaveLength(2)
    later.snapshot.data.prep[0].title='Subsequent target edit'
    expect(()=>restoreBusinessManagement(later.snapshot,updated.compensation!,now)).toThrow(/newer data/)
  })
  it('atomic batch leaves the original untouched when the last item is missing',()=>{
    const original=snapshot()
    expect(()=>apply([createPrep,{kind:'archive_prep',id:'missing'}],original)).toThrow(/not found/)
    expect(original.data.prep).toEqual([])
    expect(original.data.timeline).toEqual([])
  })
  it('refuses deleting prep referenced by an action',()=>{
    const first=apply([createPrep,{kind:'create_manual_action',value:{title:'Task',estimatedMinutes:20}}])
    first.snapshot.data.actions[0].prepId=first.objects[0].id
    expect(()=>apply([{kind:'archive_prep',id:first.objects[0].id}],first.snapshot)).toThrow(/referenced/)
  })
  it('refuses leaving dependent prep action metadata stale',()=>{
    const first=apply([createPrep,{kind:'create_manual_action',value:{title:'Old task',estimatedMinutes:20}}])
    first.snapshot.data.actions[0].kind='prep'; first.snapshot.data.actions[0].prepId=first.objects[0].id
    expect(()=>apply([{kind:'update_prep',id:first.objects[0].id,patch:{title:'New title',estimatedMinutes:50}}],first.snapshot,'synthetic-command-2')).toThrow(/dependent actions/)
    expect(first.snapshot.data.actions[0].title).toBe('Old task')
    expect(first.snapshot.data.prep[0].title).toBe('Synthetic preparation')
  })
  it('refuses editing derived or scheduled actions through generic management',()=>{
    const first=apply([{kind:'create_manual_action',value:{title:'Task',estimatedMinutes:20}}])
    first.snapshot.data.actions[0].kind='prep'
    expect(()=>apply([{kind:'update_manual_action',id:first.objects[0].id,patch:{title:'bad'}}],first.snapshot)).toThrow(/governed/)
    first.snapshot.data.actions[0].kind='manual'; first.snapshot.data.actions[0].dueAt='2026-10-10T10:00:00Z'
    expect(()=>apply([{kind:'archive_manual_action',id:first.objects[0].id}],first.snapshot)).toThrow(/governed/)
  })
  it('rejects shrinking group capacity below recorded use',()=>{
    const first=apply([{kind:'create_application_group',value:{company:'Synthetic',total:3}}])
    first.snapshot.data.applicationGroups[0].used=2
    expect(()=>apply([{kind:'update_application_group',id:first.objects[0].id,patch:{total:1}}],first.snapshot)).toThrow(/capacity/)
  })
  it('preserves original ordering when restoring an archived middle object',()=>{
    const first=apply([createPrep,createPrep,createPrep])
    const removed=apply([{kind:'archive_prep',id:first.objects[1].id}],first.snapshot,'synthetic-command-2')
    expect(restoreBusinessManagement(removed.snapshot,removed.compensation!,now).data.prep).toEqual(first.snapshot.data.prep)
  })
  it('does not record a new write for an unchanged patch',()=>{
    const first=apply([createPrep])
    const same=applyBusinessManagement(first.snapshot,{operations:[{kind:'update_prep',id:first.objects[0].id,patch:{title:'Synthetic preparation'}}]},'synthetic-command-2',new Date('2026-10-03T00:00:00Z'))
    expect(same.status).toBe('ALREADY_APPLIED')
    expect(same.snapshot.data.timeline).toHaveLength(1)
  })
  it('rejects forged compensation object identities',()=>{
    const first=apply([createPrep]); const comp=structuredClone(first.compensation!)
    comp.payload.changes[0].after!.id='another-id'
    expect(()=>restoreBusinessManagement(first.snapshot,comp,now)).toThrow(/invalid/)
  })
  it('compensation cannot remove a newly referenced created object',()=>{
    const first=apply([createPrep])
    const later=apply([{kind:'create_manual_action',value:{title:'Task',estimatedMinutes:20}}],first.snapshot,'synthetic-command-2')
    later.snapshot.data.actions[0].prepId=first.objects[0].id
    expect(()=>restoreBusinessManagement(later.snapshot,first.compensation!,now)).toThrow(/referenced/)
  })
})

describe('management consent gate',()=>{
 const principal={kind:'delegated_mcp' as const,userId:'synthetic-a',clientId:'synthetic-client'}
 const grant:BusinessManagementGrant={id:'00000000-0000-4000-8000-000000000001',revision:1,userId:'synthetic-a',clientId:'synthetic-client',consentVersion:2,capability:'workspace.manage',grantedAt:'2026-10-01T00:00:00Z'}
 it('accepts only matching explicit v2 grant',()=>{
   expect(()=>assertBusinessManagementGrant(principal,grant)).not.toThrow()
   for(const value of [undefined,{...grant,userId:'synthetic-b'},{...grant,clientId:'other'},{...grant,revokedAt:now.toISOString()},{...grant,consentVersion:1},{...grant,capability:'workspace.read'},{...grant,grantedAt:'invalid'}]) expect(()=>assertBusinessManagementGrant(principal,value as BusinessManagementGrant)).toThrow(/authorization/)
 })
 it('default-denies management before any database fetch',async()=>{
   let reads=0
   const executor=createAuthoritativeCommandExecutor({supabaseUrl:'https://example.invalid',serviceRoleKey:'synthetic',fetchImpl:async()=>{reads++;throw new Error('No network expected')}})
   await expect(executor.execute(principal,{commandId:'synthetic-command-1',baseRevision:0,command:{type:'business_management',value:{operations:[createPrep]}}})).rejects.toThrow(/authorization/)
   expect(reads).toBe(0)
 })
})

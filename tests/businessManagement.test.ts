import { describe, expect, it } from 'vitest'
import { applyBusinessManagement, businessManagementSchema, restoreBusinessManagement, readBusinessManagement } from '../src/businessManagement.js'
import { assertBusinessManagementGrant, type BusinessManagementGrant } from '../gateway/businessManagementAccess.js'
import { createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
const now = new Date('2026-10-02T12:00:00Z')
function snapshot(): PJSDASSnapshot { return { schema:'pjsdas-local-snapshot',version:4,exportedAt:now.toISOString(),data:{opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[],scheduleNodes:[],decisionRequests:[],semanticReceipts:[],reminderIntents:[],reminderOutbox:[]} } }
const createGroup = {kind:'create_application_group',value:{company:'Synthetic group',total:2}}
function apply(operations: unknown[], initial = snapshot(), commandId='synthetic-command-1') { return applyBusinessManagement(initial,{operations},commandId,now) }

describe('active business management and retained Undo',()=>{
  it('creates manual actions and groups with server-owned IDs',()=>{
    const result=apply([createGroup,{kind:'create_manual_action',value:{title:'Sample task',estimatedMinutes:20}}])
    expect(result.snapshot.data.applicationGroups[0]).toMatchObject({id:'managed:application_group:synthetic-command-1:0',company:'Synthetic group',total:2})
    expect(result.snapshot.data.actions[0]).toMatchObject({kind:'manual',status:'todo',leverage:0})
    expect(result.compensation?.payload.changes).toHaveLength(2)
    expect(result.snapshot.data.timeline).toHaveLength(1)
  })
  it('reads exact objects and paginates without mutating them',()=>{
    const first=apply([createGroup,createGroup,createGroup])
    const page=readBusinessManagement(first.snapshot,{type:'application_group',limit:2})
    expect(page.items).toHaveLength(2)
    expect(readBusinessManagement(first.snapshot,{type:'application_group',afterId:page.nextAfterId}).items).toHaveLength(1)
    expect(readBusinessManagement(first.snapshot,{type:'application_group',ids:['foreign-or-missing']}).items).toEqual([])
    ;(page.items[0] as {company:string}).company='Mutated response'
    expect(first.snapshot.data.applicationGroups[0].company).toBe('Synthetic group')
  })
  it('rejects injected owners, timestamps, arbitrary scores and permanent deletion',()=>{
    for(const operation of [
      {...createGroup,value:{...createGroup.value,ownerId:'another-account'}},
      {kind:'update_manual_action',id:'a',patch:{updatedAt:now.toISOString()}},
      {kind:'update_manual_action',id:'a',patch:{status:'done'}},
      {kind:'update_application_group',id:'a',patch:{used:4}},
      {kind:'purge_prep',id:'a'},
    ]) expect(businessManagementSchema.safeParse({operations:[operation]}).success).toBe(false)
  })
  it('rejects empty changes, unknown domains and oversized batches',()=>{
    for(const operations of [[],Array(51).fill(createGroup),[{kind:'update_application_group',id:'a',patch:{}}],[{kind:'create_material',value:{title:'a'}}]]) expect(businessManagementSchema.safeParse({operations}).success).toBe(false)
  })
  it('patches and clears optional fields without changing input snapshots',()=>{
    const first=apply([{...createGroup,value:{...createGroup.value,notes:'sample'}}]),before=structuredClone(first.snapshot)
    const result=apply([{kind:'update_application_group',id:first.objects[0].id,patch:{notes:null,company:'Updated'}}],first.snapshot,'synthetic-command-2')
    expect(result.snapshot.data.applicationGroups[0].notes).toBeUndefined()
    expect(result.snapshot.data.applicationGroups[0].company).toBe('Updated')
    expect(first.snapshot).toEqual(before)
  })
  it('archive compensation restores the whole object and detects newer collisions',()=>{
    const first=apply([createGroup]),removed=apply([{kind:'archive_application_group',id:first.objects[0].id}],first.snapshot,'synthetic-command-2')
    expect(removed.snapshot.data.applicationGroups).toEqual([])
    expect(removed.compensation?.payload.changes[0].before).toEqual(first.snapshot.data.applicationGroups[0])
    expect(restoreBusinessManagement(removed.snapshot,removed.compensation!,now).data.applicationGroups).toEqual(first.snapshot.data.applicationGroups)
    removed.snapshot.data.applicationGroups.push({...first.snapshot.data.applicationGroups[0],company:'Newer'})
    expect(()=>restoreBusinessManagement(removed.snapshot,removed.compensation!,now)).toThrow(/newer data/)
  })
  it('Undo preserves unrelated later objects and detects target edits',()=>{
    const first=apply([createGroup])
    const updated=apply([{kind:'update_application_group',id:first.objects[0].id,patch:{company:'Updated'}}],first.snapshot,'synthetic-command-2')
    const later=apply([createGroup],updated.snapshot,'synthetic-command-3')
    const restored=restoreBusinessManagement(later.snapshot,updated.compensation!,now)
    expect(restored.data.applicationGroups.find(item=>item.id===first.objects[0].id)?.company).toBe('Synthetic group')
    expect(restored.data.applicationGroups).toHaveLength(2)
    later.snapshot.data.applicationGroups[0].company='Subsequent target edit'
    expect(()=>restoreBusinessManagement(later.snapshot,updated.compensation!,now)).toThrow(/newer data/)
  })
  it('an invalid last item leaves the whole atomic batch unchanged',()=>{
    const original=snapshot()
    expect(()=>apply([createGroup,{kind:'archive_application_group',id:'missing'}],original)).toThrow(/not found/)
    expect(original.data.applicationGroups).toEqual([]);expect(original.data.timeline).toEqual([])
  })
  it('refuses archiving a referenced group and unsafe compensation',()=>{
    const first=apply([createGroup,{kind:'create_manual_action',value:{title:'Task',estimatedMinutes:20}}])
    first.snapshot.data.actions[0].applicationGroupId=first.objects[0].id
    expect(()=>apply([{kind:'archive_application_group',id:first.objects[0].id}],first.snapshot)).toThrow(/referenced/)
    const created=apply([createGroup]);const later=apply([{kind:'create_manual_action',value:{title:'Task',estimatedMinutes:20}}],created.snapshot,'synthetic-command-2')
    later.snapshot.data.actions[0].applicationGroupId=created.objects[0].id
    expect(()=>restoreBusinessManagement(later.snapshot,created.compensation!,now)).toThrow(/referenced/)
  })
  it('refuses editing retired preparation or any derived/scheduled action',()=>{
    const first=apply([{kind:'create_manual_action',value:{title:'Task',estimatedMinutes:20}}])
    first.snapshot.data.actions[0].kind='prep'
    expect(()=>apply([{kind:'update_manual_action',id:first.objects[0].id,patch:{title:'bad'}}],first.snapshot)).toThrow(/retired/)
    first.snapshot.data.actions[0].kind='manual';first.snapshot.data.actions[0].dueAt='2026-10-10T10:00:00Z'
    expect(()=>apply([{kind:'archive_manual_action',id:first.objects[0].id}],first.snapshot)).toThrow(/governed/)
  })
  it('refuses shrinking group capacity below recorded use',()=>{
    const first=apply([{kind:'create_application_group',value:{company:'Synthetic',total:3}}]);first.snapshot.data.applicationGroups[0].used=2
    expect(()=>apply([{kind:'update_application_group',id:first.objects[0].id,patch:{total:1}}],first.snapshot)).toThrow(/capacity/)
  })
  it('restores an archived middle object in its original order',()=>{
    const first=apply([createGroup,createGroup,createGroup]),removed=apply([{kind:'archive_application_group',id:first.objects[1].id}],first.snapshot,'synthetic-command-2')
    expect(restoreBusinessManagement(removed.snapshot,removed.compensation!,now).data.applicationGroups).toEqual(first.snapshot.data.applicationGroups)
  })
  it('does not write an unchanged patch',()=>{
    const first=apply([createGroup]),same=apply([{kind:'update_application_group',id:first.objects[0].id,patch:{company:'Synthetic group'}}],first.snapshot,'synthetic-command-2')
    expect(same.status).toBe('ALREADY_APPLIED');expect(same.snapshot.data.timeline).toHaveLength(1)
  })
  it('rejects forged compensation object identities',()=>{
    const first=apply([createGroup]),comp=structuredClone(first.compensation!);comp.payload.changes[0].after!.id='another-id'
    expect(()=>restoreBusinessManagement(first.snapshot,comp,now)).toThrow(/invalid/)
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
   await expect(executor.execute(principal,{commandId:'synthetic-command-1',baseRevision:0,command:{type:'business_management',value:{operations:[createGroup]}}})).rejects.toThrow(/authorization/)
   expect(reads).toBe(0)
 })
})

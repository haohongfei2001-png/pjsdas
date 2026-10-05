import { expect, test } from '@playwright/test'

test('canonical aliases survive IndexedDB upgrade, cloud hydration, local writes and reload', async ({ page }) => {
  // Keep app startup writers out of this native IndexedDB contract test.
  await page.route('**/pjsdas/alias-contract', route => route.fulfill({contentType:'text/html',body:'<!doctype html><title>Alias persistence contract</title>'}))
  await page.goto('/pjsdas/alias-contract')
  const result = await page.evaluate(async () => {
    await new Promise<void>((resolve,reject)=>{
      const request=indexedDB.open('pjsdas',13)
      request.onupgradeneeded=()=>request.result.createObjectStore('opportunities',{keyPath:'id'})
      request.onsuccess=()=>{request.result.close();resolve()};request.onerror=()=>reject(request.error)
    })
    const db=await import('/pjsdas/src/db.ts')
    const {createSnapshot}=await import('/pjsdas/src/snapshot.ts')
    const {applyOpportunityMerge,readOpportunityMerge}=await import('/pjsdas/src/opportunityMerge.ts')
    const timestamp='2026-10-05T12:00:00.000Z', source='https://careers.example/jobs/synthetic-role'
    const opportunity={id:'canonical',company:'Synthetic Company',role:'Research Analyst',processStage:'not_applied' as const,currentStageLabel:'待投',roleType:'core' as const,early:false,opportunityValue:70,fitScore:70,importedAt:timestamp,detail:{discovery:{sourceUrl:source,sourceTitle:'Synthetic role',rationale:'Synthetic evidence',discoveredAt:timestamp,fitConfidence:'high' as const,opportunityValueConfidence:'high' as const}}}
    const before=createSnapshot({opportunities:[opportunity,{...structuredClone(opportunity),id:'duplicate'}],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[]},timestamp)
    const review=await readOpportunityMerge(before,'canonical','duplicate')
    const merged=await applyOpportunityMerge(before,{canonicalOpportunityId:'canonical',duplicateOpportunityId:'duplicate',expectedFingerprint:review.fingerprint,dependencies:review.dependencies,reason:'Verified same synthetic posting',evidenceRefs:[source]},'synthetic-merge',new Date(timestamp))
    await db.replaceLocalSnapshotFromCloud(merged.snapshot)
    const installed=await db.exportLocalSnapshot()
    await db.addProcessEvent({id:'synthetic-local-event',opportunityId:'duplicate',company:opportunity.company,role:opportunity.role,type:'offer',source:'manual',occurredAt:timestamp,createdAt:timestamp,updatedAt:timestamp})
    await db.applyProgressUpdate([{id:'synthetic-local-progress',kind:'upsert_opportunity',opportunityId:'duplicate',company:opportunity.company,role:opportunity.role,mode:'planned',occurredAt:timestamp,confidence:'high',sourceText:'Synthetic explicitly reported progress'}])
    const after=await db.exportLocalSnapshot()
    return {version:(await db.dbPromise).version,aliases:installed.data.opportunityAliases,afterAliases:after.data.opportunityAliases,opportunityIds:after.data.opportunities.map(item=>item.id),eventOwner:after.data.processEvents.find(item=>item.id==='synthetic-local-event')?.opportunityId}
  })
  expect(result.version).toBe(14)
  expect(result.aliases).toHaveLength(1)
  expect(result.afterAliases).toEqual(result.aliases)
  expect(result.opportunityIds).toEqual(['canonical'])
  expect(result.eventOwner).toBe('canonical')
  await page.reload()
  const persisted=await page.evaluate(async()=>{
    const snapshot=await(await import('/pjsdas/src/db.ts')).exportLocalSnapshot()
    return {aliases:snapshot.data.opportunityAliases,opportunityIds:snapshot.data.opportunities.map(item=>item.id),owner:snapshot.data.processEvents[0]?.opportunityId}
  })
  expect(persisted.aliases).toEqual(result.aliases)
  expect(persisted.opportunityIds).toEqual(['canonical'])
  expect(persisted.owner).toBe('canonical')
})

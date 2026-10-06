import { expect, test } from '@playwright/test'

const now = '2026-10-07T08:00:00.000Z'

test('local legacy Inbox promotion preserves archival ratings without reviving ratings in the new job', async ({ page }) => {
  await page.clock.setFixedTime(new Date(now))
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  const result = await page.evaluate(async at => {
    const { dbPromise, exportLocalSnapshot } = await import('/pjsdas/src/db.ts')
    const { promoteDiscoveryInboxItem } = await import('/pjsdas/src/discoveryInboxStore.ts')
    const db = await dbPromise
    const item = { id: 'legacy-inbox', candidateOpportunityId: 'legacy-job', company: 'Synthetic company', role: 'Research', roleType: 'core' as const,
      sourceUrl: 'https://example.test/jobs/research', sourceTitle: 'Source facts', rationale: 'Retained source evidence',
      fitScore: 70, opportunityValue: 80, fitConfidence: 'high' as const, opportunityValueConfidence: 'high' as const,
      status: 'new' as const, discoveredAt: at, createdAt: at, updatedAt: at,
      assessment: { version: 1 as const, mode: 'component' as const, assessedAt: at,
        fit: { skills: { score: 70, confidence: 'high' as const, rationale: 'Historical assessment' } },
        opportunityValue: { companyQuality: { score: 80, confidence: 'high' as const, rationale: 'Historical assessment' } } } }
    await db.put('discoveryInbox', item)
    await promoteDiscoveryInboxItem(item.id)
    const snapshot = await exportLocalSnapshot()
    return { original: item, inbox: await db.get('discoveryInbox', item.id), job: await db.get('opportunities', item.candidateOpportunityId),
      changes: snapshot.data.changeSets, rules: await db.getAll('decisionRules') }
  }, now)
  expect(result.inbox).toMatchObject({ status: 'promoted', fitScore: 70, opportunityValue: 80, assessment: result.original.assessment })
  expect(result.job).toMatchObject({ fitScore: 0, opportunityValue: 0, company: result.original.company, role: result.original.role })
  expect(result.job?.detail?.assessment).toBeUndefined()
  expect(result.changes?.filter(item => item.status === 'pending')).toEqual([])
  expect(result.rules).toEqual([])
})

test('local read restore and cloud replacement preserve absent or sparse archived rules exactly', async ({ page }) => {
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  const result = await page.evaluate(async at => {
    const db = await import('/pjsdas/src/db.ts')
    const { createSnapshot } = await import('/pjsdas/src/snapshot.ts')
    const { createDefaultDecisionRules } = await import('/pjsdas/src/decisionRules.ts')
    const empty = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [] }, at)
    await db.restoreLocalSnapshot(empty)
    const absentRestore = (await db.exportLocalSnapshot()).data.decisionRules
    await db.replaceLocalSnapshotFromCloud(empty)
    const absentCloud = (await db.exportLocalSnapshot()).data.decisionRules
    const sparse = { ...createDefaultDecisionRules(at), legacyMarker: 'Keep exactly' }
    delete sparse.fitComponentWeights; delete sparse.opportunityValueComponentWeights; delete sparse.portfolioWeights; delete sparse.portfolioMinimumCandidateScore
    const historical = createSnapshot({ ...empty.data, decisionRules: sparse }, at)
    await db.restoreLocalSnapshot(historical)
    const afterRestore = (await db.exportLocalSnapshot()).data.decisionRules
    await db.replaceLocalSnapshotFromCloud(historical)
    const afterCloud = (await db.exportLocalSnapshot()).data.decisionRules
    return { absentRestore, absentCloud, sparse, afterRestore, afterCloud }
  }, now)
  expect(result.absentRestore).toBeUndefined()
  expect(result.absentCloud).toBeUndefined()
  expect(result.afterRestore).toEqual(result.sparse)
  expect(result.afterCloud).toEqual(result.sparse)
})

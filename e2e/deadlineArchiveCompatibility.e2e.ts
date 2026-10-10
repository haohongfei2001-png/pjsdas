import { expect, test } from '@playwright/test'
import { verifiedPostingFixture } from '../tests/fixtures/verifiedDiscovery.js'
import { unknownDeadlineWorkspace } from '../tests/fixtures/unknownDeadlineWorkspace.js'

const now = '2026-10-07T08:00:00.000Z'

test('verified local Inbox promotion preserves historical ratings and unrelated raw deadline data', async ({ page }) => {
  await page.clock.setFixedTime(new Date(now))
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  const result = await page.evaluate(async ({ at, baseline }) => {
    const { dbPromise, exportLocalSnapshot, restoreLocalSnapshot } = await import('/pjsdas/src/db.ts')
    const { promoteDiscoveryInboxItem } = await import('/pjsdas/src/discoveryInboxStore.ts')
    await restoreLocalSnapshot(baseline)
    const db = await dbPromise
    const originalHistorical = await db.get('opportunities', baseline.data.opportunities[0].id)
    if (!originalHistorical) throw new Error('Missing synthetic historical job')
    const historical = { ...originalHistorical, deadline: '2026-08-27T15:59:59Z' }
    await db.put('opportunities', historical)
    const item = { id: 'legacy-inbox', candidateOpportunityId: 'legacy-job', company: 'Synthetic company', role: 'Research', roleType: 'core' as const,
      sourceUrl: 'https://example.test/jobs/research', sourceTitle: 'Source facts', rationale: 'Retained source evidence',
      fitScore: 70, opportunityValue: 80, fitConfidence: 'high' as const, opportunityValueConfidence: 'high' as const,
      status: 'new' as const, discoveredAt: at, createdAt: at, updatedAt: at,
      assessment: { version: 1 as const, mode: 'component' as const, assessedAt: at,
        fit: { skills: { score: 70, confidence: 'high' as const, rationale: 'Historical assessment' } },
        opportunityValue: { companyQuality: { score: 80, confidence: 'high' as const, rationale: 'Historical assessment' } } } }
    await db.put('discoveryInbox', item)
    let unverifiedError = ''
    try { await promoteDiscoveryInboxItem(item.id) } catch (error) { unverifiedError = String(error) }
    const archivedBeforeVerification = await db.get('discoveryInbox', item.id)
    const { createJobPostingEvidence } = await import('/pjsdas/src/jobPosting.ts')
    const sourceProof = { version: 1 as const, authority: 'employer' as const, authorityUrl: 'https://example.test',
      requestedUrl: item.sourceUrl, finalUrl: item.sourceUrl, verifiedAt: at, documentSha256: 'a'.repeat(64), postingIdentity: 'synthetic:research',
      fields: (['company', 'role'] as const).map(field => ({ field, value: item[field], sourceUrl: item.sourceUrl, selector: `synthetic.${field}`, quote: item[field] })) }
    await db.put('discoveryInbox', { ...item, posting: createJobPostingEvidence({ ...item, sourceProof, observedAt: at }) })
    await promoteDiscoveryInboxItem(item.id)
    const snapshot = await exportLocalSnapshot()
    return { original: item, unverifiedError, archivedBeforeVerification, historical, retainedHistorical: await db.get('opportunities', historical.id), inbox: await db.get('discoveryInbox', item.id), job: await db.get('opportunities', item.candidateOpportunityId),
      changes: snapshot.data.changeSets, rules: await db.getAll('decisionRules') }
  }, { at: now, baseline: unknownDeadlineWorkspace(1) })
  expect(result.unverifiedError).toContain('DISCOVERY_VERIFICATION_REQUIRED')
  expect(result.archivedBeforeVerification).toEqual(result.original)
  expect(result.retainedHistorical).toEqual(result.historical)
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

test('local reviewed Discovery batch validates every source before committing any job, status or audit', async ({ page }) => {
  const observations = await Promise.all(['100001', '100002'].map(async id => ({ id, value: await verifiedPostingFixture({
    company: 'Same synthetic company', role: 'Product Manager', sourceUrl: `https://www.liepin.com/job/${id}.shtml`, sourceTitle: 'Synthetic recruiting page',
  }, now) })))
  await page.clock.setFixedTime(new Date(now))
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  const result = await page.evaluate(async ({ at, observations }) => {
    const { dbPromise, restoreLocalSnapshot, applyChangeSet, savePendingChangeSet } = await import('/pjsdas/src/db.ts')
    const { createSnapshot } = await import('/pjsdas/src/snapshot.ts')
    const { createMonitorOpportunity } = await import('/pjsdas/src/autonomousIngestion.ts')
    await restoreLocalSnapshot(createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [], changeSets: [] }, at))
    const db = await dbPromise
    const operations = observations.map(({ id, value }) => ({ id: `add:${id}`, kind: 'add_discovered_opportunity' as const, summary: 'Synthetic source facts',
      opportunity: { ...createMonitorOpportunity(value, at), id } }))
    const invalid = structuredClone(operations)
    invalid[1].opportunity.detail!.discovery!.posting!.sourceProof = undefined
    invalid[1].opportunity.detail!.discovery!.sourceProof = undefined
    const pending = { id: 'CS-B2-INVALID', version: 1 as const, source: 'mcp' as const, status: 'pending' as const,
      title: 'Synthetic reviewed batch', createdAt: at, updatedAt: at, operations: invalid }
    await savePendingChangeSet(pending)
    let failed = ''
    try { await applyChangeSet(pending.id) } catch (error) { failed = String(error) }
    const afterFailure = { jobs: await db.getAll('opportunities'), audit: (await db.getAll('timeline')).filter(row => row.kind === 'opportunity_added'),
      change: await db.get('changeSets', pending.id) }
    const valid = { ...pending, id: 'CS-B2-VALID', operations }
    await savePendingChangeSet(valid)
    await applyChangeSet(valid.id)
    const firstAudit = await db.getAll('timeline')
    await applyChangeSet(valid.id)
    return { failed, afterFailure, jobs: await db.getAll('opportunities'), actions: await db.getAll('actions'), schedule: await db.getAll('scheduleNodes'),
      change: await db.get('changeSets', valid.id), firstAudit, replayAudit: await db.getAll('timeline') }
  }, { at: now, observations })
  expect(result.failed).toContain('DISCOVERY_VERIFICATION_REQUIRED')
  expect(result.afterFailure.jobs).toEqual([])
  expect(result.afterFailure.audit).toEqual([])
  expect(result.afterFailure.change?.status).toBe('failed')
  expect(result.jobs.map(item => item.id).sort()).toEqual(['100001', '100002'])
  expect(result.change?.status).toBe('applied')
  expect(result.actions).toEqual([]); expect(result.schedule).toEqual([])
  expect(result.replayAudit).toEqual(result.firstAudit)
})

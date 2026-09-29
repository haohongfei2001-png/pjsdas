import { expect, test } from '@playwright/test'
import { denseDecisionWorkspace, DENSE_NOW } from '../tests/fixtures/denseDecisionWorkspace.js'
import { createSnapshot } from '../src/snapshot.js'
import { action, opportunity } from './fixtures/todayWorkspace.js'

// This fixture is the Shanghai calendar at midnight; CI host timezone must not change its day.
test.use({ timezoneId: 'Asia/Shanghai' })

test('dense persisted owner-like debt stays accessible outside Today without generic English diagnostics', async ({ page, context }) => {
  await page.clock.install({ time: DENSE_NOW })
  await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const snapshot = denseDecisionWorkspace()
  await page.evaluate(async (input) => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(input), snapshot)
  await page.goto('/pjsdas/today')
  const panel = page.locator('.tsui-task-panel')
  await expect(panel.locator('.tsui-task-row')).not.toHaveCount(0)
  expect(await panel.locator('.tsui-task-row').count()).toBeLessThan(20)
  await expect(page.getByText('Several opportunities match this input.', { exact: true })).toHaveCount(0)
  await expect(page.locator('.tsui-unresolved-link')).toContainText('98')
  const ordered = await page.locator('.tsui-node-panel').evaluate(node => {
    const list = node.querySelector('.tsui-node-scroll')!, history = node.querySelector('.tsui-unresolved-link')!
    return Boolean(list.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  expect(ordered).toBe(true)
  await expect(page.getByRole('button', { name: /查看全部待决定事项/ })).toHaveCount(0)
  await page.goto('/pjsdas/decisions')
  await expect(page.locator('.ultimate-decision-card')).toHaveCount(0)
  await expect(page.getByText('历史待核对 / 数据质量 · 358')).toBeVisible()
  await expect(page.getByText('Several opportunities match this input.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Commit the bounded internal update.', { exact: true })).toHaveCount(0)
  await page.reload(); await expect(page.locator('.ultimate-decision-card')).toHaveCount(0)
  const stored = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).dbPromise).getAll('decisionRequests'))
  expect(stored).toEqual([...snapshot.data.decisionRequests!].sort((a,b) => a.id.localeCompare(b.id)))
  const restarted = await context.newPage(); await restarted.goto('/pjsdas/today'); await page.close()
  await expect(restarted.getByRole('button', { name: /查看全部待决定事项/ })).toHaveCount(0)
  expect(await restarted.locator('.tsui-task-row').count()).toBeLessThan(20)
})

test('exact replay groups expose each preserved request and never group changed alternatives', async ({ page }) => {
  await page.clock.install({ time: DENSE_NOW }); await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const snapshot = denseDecisionWorkspace()
  const first = snapshot.data.decisionRequests![0]
  snapshot.data.opportunities[0].company = 'Shared'
  snapshot.data.opportunities[1].company = 'Shared'
  snapshot.data.opportunities[1].role = 'Analyst'
  snapshot.data.opportunities[2].company = 'Shared'
  snapshot.data.opportunities[2].role = 'Designer'
  first.payloadBinding.candidate.target = { company: 'Shared' }
  first.choices = snapshot.data.opportunities.slice(0, 3).map(job => ({
    id: `opportunity:${job.id}`, label: `${job.company}｜${job.role}`,
    consequence: 'Only this opportunity will be updated.', resolution: { opportunityId: job.id },
  }))
  const replay = structuredClone(first), changed = structuredClone(first)
  replay.id = 'replay'; replay.payloadBinding.inputId = 'new-input'; replay.payloadBinding.source.sourceVersion = 'new'; replay.payloadBinding.candidate.sourceVersionRefs = ['new']
  changed.id = 'changed'; changed.choices[0].consequence = 'A separately reviewed consequence.'
  snapshot.data.decisionRequests = [first, replay, changed]
  await page.evaluate(async (input) => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(input), snapshot)
  await page.goto('/pjsdas/decisions')
  await expect(page.locator('.ultimate-decision-card')).toHaveCount(2)
  await page.getByText('同一来源的重复记录（逐条保留）').click()
  await page.getByRole('link', { name: /replay/ }).click()
  await expect(page.locator('.ultimate-decision-card')).toHaveCount(1)
  expect(page.url()).toContain('/decisions/replay')
  expect(await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).dbPromise).count('decisionRequests'))).toBe(3)
})

test('Chinese decision cards preserve actual old-fact warning and distinct clarification instructions', async ({ page }) => {
  await page.clock.install({ time: DENSE_NOW }); await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  await page.evaluate(async (snapshot) => {
    const { applySemanticIntake } = await import('/pjsdas/src/semanticIntake.ts')
    snapshot.data.decisionRequests = []
    snapshot.data.opportunities[0].effectiveProcessEventAt = '2026-09-27T00:00:00Z'
    const observation = { contractVersion: 1 as const, inputId: 'old-browser', statementMode: 'assertion' as const,
      source: { kind: 'web' as const, sourceId: 'web', sourceRecordId: 'old-note', observedAt: '2026-09-28T18:00:00Z', assertedAt: '2026-09-20T00:00:00Z', timezone: 'Asia/Shanghai' },
      candidates: [{ id: 'fact', kind: 'application_submitted' as const, target: { opportunityId: snapshot.data.opportunities[0].id }, occurredAt: '2026-09-20T00:00:00Z', objectConfidence: 'high' as const, eventConfidence: 'high' as const, evidenceRefs: [], sourceVersionRefs: [] }] }
    const first = applySemanticIntake(snapshot, observation, { authorized: true })
    const second = applySemanticIntake(first.snapshot, { ...observation, inputId: 'missing-browser', source: { ...observation.source, sourceRecordId: 'missing-note' }, candidates: [{ ...observation.candidates[0], target: undefined }] }, { authorized: true })
    await (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(second.snapshot)
  }, denseDecisionWorkspace())
  await page.goto('/pjsdas/decisions')
  await expect(page.locator('.ultimate-decision-card')).toHaveCount(1)
  await expect(page.getByText('这条观察早于已记录的最新进展。只有你确实有意纠正最新进展时，才应确认。')).toBeVisible()
  await expect(page.getByText('历史待核对 / 数据质量 · 1')).toBeVisible()
  await expect(page.getByRole('button', { name: /暂不记录，补充岗位/ })).toHaveCount(0)
  await expect(page.getByText('This observation predates a newer process fact.', { exact: false })).toHaveCount(0)
})

test('one hard deadline risk has one actionable warning', async ({ page }) => {
  await page.clock.install({ time: DENSE_NOW })
  await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const job = opportunity('hard-job', 'Example', 'Engineer')
  const hard = { ...action('hard-task', 'Submit application', job.id), kind: 'apply' as const,
    dueAt: new Date(DENSE_NOW.getTime() + 36 * 60 * 60_000).toISOString(),
    duePrecision: 'datetime' as const, estimatedMinutes: 500 }
  const snapshot = createSnapshot({
    opportunities: [job], processes: [], processEvents: [], actions: [hard],
    prep: [], applicationGroups: [],
  }, DENSE_NOW.toISOString())
  await page.evaluate(async input => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(input), snapshot)
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-alert').filter({ hasText: '硬截止' })).toHaveCount(1)
  await expect(page.locator('.tsui-inline-notice')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '查看日程' })).toBeVisible()
})

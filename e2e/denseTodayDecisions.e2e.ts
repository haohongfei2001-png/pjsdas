import { expect, test } from '@playwright/test'
import { denseDecisionWorkspace, DENSE_NOW } from '../tests/fixtures/denseDecisionWorkspace.js'

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
  await page.getByRole('button', { name: /查看全部待决定事项/ }).click()
  await expect(page.locator('.ultimate-decision-card')).toHaveCount(358)
  await expect(page.locator('.ultimate-decision-card').first()).toContainText('对应岗位待确认')
  await expect(page.locator('.ultimate-decision-card').first()).toContainText('邮件 2026-09-20')
  await expect(page.getByText('Several opportunities match this input.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Commit the bounded internal update.', { exact: true })).toHaveCount(0)
  await page.reload(); await expect(page.locator('.ultimate-decision-card')).toHaveCount(358)
  const stored = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).dbPromise).getAll('decisionRequests'))
  expect(stored).toEqual([...snapshot.data.decisionRequests!].sort((a,b) => a.id.localeCompare(b.id)))
  const restarted = await context.newPage(); await restarted.goto('/pjsdas/today'); await page.close()
  await expect(restarted.getByRole('button', { name: /查看全部待决定事项/ })).toBeVisible()
  expect(await restarted.locator('.tsui-task-row').count()).toBeLessThan(20)
})

test('exact replay groups expose each preserved request and never group changed alternatives', async ({ page }) => {
  await page.clock.install({ time: DENSE_NOW }); await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const snapshot = denseDecisionWorkspace()
  const first = snapshot.data.decisionRequests![0], replay = structuredClone(first), changed = structuredClone(first)
  replay.id = 'replay'; replay.payloadBinding.inputId = 'new-input'; replay.payloadBinding.source.sourceVersion = 'new'; replay.payloadBinding.candidate.sourceVersionRefs = ['new']
  changed.id = 'changed'; changed.choices[0].resolution = { opportunityId: snapshot.data.opportunities[0].id }
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

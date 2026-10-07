import { expect, test } from '@playwright/test'
import { recordCorrectionWorkspace, RECORD_NOW } from '../tests/fixtures/recordCorrectionWorkspace.js'

test.use({ timezoneId: 'Asia/Shanghai' })
async function seed(page: import('@playwright/test').Page) {
  await page.clock.setFixedTime(RECORD_NOW)
  await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  await page.evaluate(async snapshot => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(snapshot), recordCorrectionWorkspace())
  await page.goto('/pjsdas/library')
}
const categories: Array<[string, string[]]> = [['全部', ['future', 'expired', 'undated', 'applied', 'exam', 'interview', 'offer', 'rejected', 'disputed']], ['待投递', ['future']], ['已投递', ['applied']], ['收到笔试', ['exam']], ['收到面试', ['interview']], ['流程结束', ['offer', 'rejected']], ['时间截止', ['expired']], ['无截止日期', ['undated']]]
for (const mobile of [false, true]) test(`eight exclusive categories and corrected audit remain truthful on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }, testInfo) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await seed(page)
  const filters = page.locator('.tsui-library-filters')
  await expect(filters.getByRole('button')).toHaveCount(8)
  for (const [label, ids] of categories) {
    await filters.getByRole('button', { name: label, exact: true }).click()
    await expect(page.locator('.tsui-job-row')).toHaveCount(ids.length)
    for (const id of ids) await expect(page.locator(`.tsui-job-row[data-opportunity-id="${id}"]`)).toBeVisible()
    await expect(page.locator('.tsui-job-row[data-opportunity-id="disputed"]')).toHaveCount(label === '全部' ? 1 : 0)
  }
  await filters.getByRole('button', { name: '全部', exact: true }).click()
  await expect(page.locator('.tsui-job-row[data-opportunity-id="disputed"]')).toContainText('阶段待核实')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('jobs-categories.png'), fullPage: true })
  await page.locator('.tsui-job-row[data-opportunity-id="disputed"] button').click()
  await expect(page.locator('.opportunity-detail-conclusion')).toContainText('阶段待核实')
  const history = page.locator('details').filter({ has: page.getByText('完整历史', { exact: true }) })
  await history.locator('summary').click()
  await expect(page.locator('.opportunity-detail-timeline')).toContainText('已失效')
  await page.reload()
  await expect(page.locator('.opportunity-detail-conclusion')).toContainText('阶段待核实')
  await page.goto('/pjsdas/schedule?view=no_deadline')
  await expect(page.locator('.tsui-schedule-row')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('schedule-excludes-job-facts.png'), fullPage: true })
  await page.goto('/pjsdas/schedule?view=history')
  await expect(page.locator('.tsui-schedule-row').filter({ hasText: '已失效的流程判断' })).toHaveCount(0)
  const stored = await page.evaluate(async () => (await import('/pjsdas/src/db.ts')).exportLocalSnapshot())
  expect(stored.data.opportunities).toHaveLength(9)
  expect(stored.data.processEvents).toHaveLength(1)
  expect(stored.data.processEvents[0].invalidation).toBeTruthy()
})

test('stale correction is atomic and keeps the old record visible after reload', async ({ page }, testInfo) => {
  await seed(page)
  const result = await page.evaluate(async () => {
    const { exportLocalSnapshot, replaceLocalSnapshotFromCloud } = await import('/pjsdas/src/db.ts')
    const { applyUserDomainCommand } = await import('/pjsdas/src/domainCommands.ts')
    const snapshot = await exportLocalSnapshot()
    const before = JSON.stringify(snapshot.data)
    try {
      const command = { commandId: 'synthetic-stale-correction', kind: 'correct_application_deadline', opportunityId: 'expired', expectedDeadlineFingerprint: 'stale', correction: { state: 'unknown', sourceUrl: 'https://careers.example.test/role', sourceAuthority: 'official_role', evidence: 'Synthetic source check.', checkedAt: '2026-10-02T08:00:00Z', postingStatus: 'open' } }
      await replaceLocalSnapshotFromCloud(applyUserDomainCommand(snapshot, command, new Date('2026-10-02T08:00:00Z')).snapshot)
      return { failed: false, unchanged: false }
    } catch (error) { return { failed: String(error).includes('changed'), unchanged: before === JSON.stringify((await exportLocalSnapshot()).data) } }
  })
  expect(result).toEqual({ failed: true, unchanged: true })
  await page.reload()
  await page.locator('.tsui-library-filters').getByRole('button', { name: '时间截止', exact: true }).click()
  await expect(page.locator('.tsui-job-row')).toHaveCount(1)
  await expect(page.locator('.tsui-job-row')).toContainText('过期科技')
  await page.screenshot({ path: testInfo.outputPath('stale-correction-preserved.png'), fullPage: true })
})

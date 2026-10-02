import { expect, test } from '@playwright/test'
import { UNKNOWN_DEADLINE_NOW, unknownDeadlineWorkspace } from '../tests/fixtures/unknownDeadlineWorkspace.js'

test.use({ timezoneId: 'Asia/Shanghai' })

for (const withRealDeadline of [false, true]) test(`withdrawn deadline history stays out of Today warnings after reload, real deadline ${withRealDeadline}`, async ({ page }, testInfo) => {
  await page.clock.setFixedTime(UNKNOWN_DEADLINE_NOW)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.locator('.tsui-primary-nav').waitFor()
  const snapshot = unknownDeadlineWorkspace(8, withRealDeadline)
  snapshot.data.actions[0]!.estimatedMinutes = 20
  snapshot.data.timePlanning = { version: 1, updatedAt: UNKNOWN_DEADLINE_NOW.toISOString(), defaultDailyMinutes: 480 }
  // IndexedDB exports in key order, not the fixture's insertion order.
  const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id))
  const history = byId(snapshot.data.scheduleNodes ?? [])
  const corrections = byId(snapshot.data.opportunities.map(item => ({ id: item.id, corrections: item.detail?.deadlineCorrections })))
  await page.evaluate(async value => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(value), snapshot)
  await page.goto('/pjsdas/today')
  for (let reload = 0; reload < 2; reload++) {
    await expect(page.locator('[data-action-id="apply:unknown-0"]')).toBeVisible()
    await expect(page.locator('[data-action-id="apply:unknown-0"]')).not.toContainText('8/27')
    await expect(page.locator('[data-deferred-action-id^="apply:unknown-"]')).toHaveCount(0)
    await expect(page.locator('.tsui-deadline-notice')).toHaveCount(withRealDeadline ? 1 : 0)
    if (withRealDeadline) {
      await expect(page.locator('[data-deferred-action-id="apply:real-deadline"]')).toBeVisible()
      await expect(page.locator('.tsui-deadline-notice')).not.toContainText('Synthetic Company')
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true)
    if (reload === 0) await page.reload()
  }
  await page.screenshot({ path: testInfo.outputPath('today-withdrawn-deadlines.png'), fullPage: true })
  await page.goto('/pjsdas/schedule?view=no_deadline')
  await expect(page.locator('.tsui-schedule-row')).toHaveCount(8)
  await expect(page.locator('.tsui-schedule-row').first()).toContainText('未公布可靠截止日期')
  await page.goBack()
  await expect(page.locator('[data-deferred-action-id^="apply:unknown-"]')).toHaveCount(0)
  const retained = await page.evaluate(async () => (await import('/pjsdas/src/db.ts')).exportLocalSnapshot())
  expect(byId(retained.data.scheduleNodes ?? [])).toEqual(history)
  expect(byId(retained.data.opportunities.map(item => ({ id: item.id, corrections: item.detail?.deadlineCorrections })))).toEqual(corrections)
  expect(retained.data.actions.filter(item => item.opportunityId?.startsWith('unknown-')).every(item => !item.dueAt)).toBe(true)
  expect(errors).toEqual([])
})

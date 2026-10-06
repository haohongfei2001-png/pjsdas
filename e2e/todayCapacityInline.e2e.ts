import { expect, test, type Page } from '@playwright/test'
import { setupInstantServer } from './fixtures/instantServer.js'
import { INSTANT_NOW } from '../tests/fixtures/instantDenseWorkspace.js'

test.use({ timezoneId: 'Asia/Shanghai' })
const summary = (page: Page) => page.locator('.tsui-capacity summary')
const input = (page: Page) => page.locator('.tsui-capacity input')
async function open(page: Page) {
  if (!(await input(page).isVisible())) await summary(page).click()
}
async function planning(page: Page) {
  return page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data.timePlanning ?? null)
}
async function localStart(page: Page) {
  await page.clock.setFixedTime(new Date('2026-10-06T14:00:00Z'))
  await page.goto('/pjsdas/today')
  await expect(summary(page)).toContainText('2 小时')
}
async function connectedStart(page: Page) {
  await page.clock.setFixedTime(INSTANT_NOW)
  await page.goto('/pjsdas/today')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['instant-owner']?.lastSyncedVersion)).toBe('txn:1204')
}

test('3h, 6h and custom hours share one row and valid typing saves without a Save button', async ({ page }, info) => {
  await localStart(page)
  for (const lang of ['zh', 'en']) {
    await page.evaluate(lang => localStorage.setItem('pjsdas-ui-language', lang), lang)
    await page.reload()
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await open(page)
      await expect(page.locator('.tsui-capacity button[type=submit]')).toHaveCount(0)
      await expect(page.locator('.tsui-capacity-note')).toHaveCount(0)
      const boxes = await page.locator('.tsui-capacity-options').evaluate(element => [...element.children].map(child => child.getBoundingClientRect().toJSON()))
      expect(Math.max(...boxes.map(box => box.y)) - Math.min(...boxes.map(box => box.y))).toBeLessThanOrEqual(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await info.attach(`inline-${lang}-${width}`, { body: await page.screenshot(), contentType: 'image/png' })
    }
    await input(page).fill('4.25')
    await expect.poll(async () => (await planning(page))?.dateOverrides?.['2026-10-06']).toBe(255)
    await expect(input(page)).toHaveValue('4.25')
    await expect(summary(page)).toContainText(lang === 'zh' ? '4 小时 15 分钟' : '4h 15m')
  }
  await page.reload()
  await expect(summary(page)).toContainText('4h 15m')
})

test('empty and invalid drafts do not silently save zero; an explicit zero does save', async ({ page }) => {
  await localStart(page); await open(page)
  await input(page).fill('3'); await input(page).press('Enter')
  await expect(summary(page)).toContainText('3 小时')
  await open(page); await input(page).fill(''); await input(page).blur()
  expect((await planning(page)).dateOverrides).toEqual({ '2026-10-06': 180 })
  await input(page).fill('25'); await input(page).blur()
  await expect(page.locator('.tsui-capacity [role=alert]')).toBeVisible()
  expect((await planning(page)).dateOverrides).toEqual({ '2026-10-06': 180 })
  await input(page).fill('0')
  await expect(summary(page)).toContainText('0 分钟')
  expect((await planning(page)).dateOverrides).toEqual({ '2026-10-06': 0 })
})

test('local save failure rolls back the custom display and the next valid edit can retry', async ({ page }) => {
  await localStart(page); await open(page)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    let armed = true
    IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
      if (armed && this.name === 'meta' && args[0]?.key === 'timePlanning') { armed = false; throw new Error('Synthetic availability save failure') }
      return put.apply(this, args)
    }
  })
  await input(page).fill('3')
  await expect(page.locator('.tsui-capacity [role=alert]')).toContainText('Synthetic availability save failure')
  await expect(summary(page)).toContainText('2 小时')
  expect(await planning(page)).toBeNull()
  await input(page).fill('6')
  await expect(summary(page)).toContainText('6 小时')
  await expect(page.locator('.tsui-capacity [role=alert]')).toHaveCount(0)
})

test('system timezone changes choose the correct local date without moving old overrides or planning settings', async ({ page }) => {
  await page.addInitScript(() => {
    const Native = Intl.DateTimeFormat
    ;(window as any).testDeviceZone = sessionStorage.getItem('test-device-zone') ?? 'Asia/Shanghai'
    Intl.DateTimeFormat = new Proxy(Native, {
      construct(target, args) { return Reflect.construct(target, [args[0], { ...args[1], timeZone: args[1]?.timeZone ?? (window as any).testDeviceZone }]) },
      apply(target, self, args) { return Reflect.apply(target, self, [args[0], { ...args[1], timeZone: args[1]?.timeZone ?? (window as any).testDeviceZone }]) },
    })
  })
  await page.clock.setFixedTime(new Date('2026-10-06T16:15:00Z'))
  await page.goto('/pjsdas/today')
  await page.evaluate(async () => {
    await (await import('/pjsdas/src/db.ts')).saveLocalTimePlanning({ version: 1, updatedAt: '2026-10-01T00:00:00Z', timezone: 'Europe/London',
      dateOverrides: { '2026-10-06': 360, '2026-10-07': 180 } })
    window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
  })
  await expect(summary(page)).toContainText('3 小时')
  await expect(page.locator('.tsui-page-heading > div > p')).toContainText('10月7日')
  await page.evaluate(() => { (window as any).testDeviceZone = 'America/Los_Angeles'; sessionStorage.setItem('test-device-zone', 'America/Los_Angeles'); window.dispatchEvent(new Event('focus')) })
  await expect(summary(page)).toContainText('6 小时')
  await expect(page.locator('.tsui-page-heading > div > p')).toContainText('10月6日')
  await open(page); await input(page).fill('2')
  await expect(summary(page)).toContainText('2 小时')
  expect(await planning(page)).toMatchObject({ timezone: 'Europe/London', dateOverrides: { '2026-10-06': 120, '2026-10-07': 180 } })
  await page.evaluate(() => localStorage.setItem('pjsdas-ui-language', 'en'))
  // Changing language alone does not select a different timezone or migrate values.
  await page.reload()
  await expect(summary(page)).toContainText('2h')
  expect((await planning(page)).dateOverrides).toEqual({ '2026-10-06': 120, '2026-10-07': 180 })
})

test('latest custom intent survives leaving and reopening Today while server confirmations are held', async ({ page, context }) => {
  const server = await setupInstantServer(context, 10); server.setDelay(50)
  const release = server.holdNextConfirmation()
  await connectedStart(page)
  await open(page); await input(page).fill('5'); await input(page).press('Enter')
  await expect(summary(page)).toContainText('5 小时')
  await open(page); await input(page).fill('4'); await input(page).press('Enter')
  await expect(summary(page)).toContainText('4 小时')
  await page.locator('.tsui-settings-button').click()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: '今天', exact: true }).click()
  await open(page); await input(page).fill('3'); await input(page).press('Enter')
  await expect(summary(page)).toContainText('3 小时')
  release()
  await expect.poll(() => server.snapshot.data.timePlanning?.dateOverrides?.['2026-10-01']).toBe(180)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]').length)).toBe(0)
  await page.reload(); await expect(summary(page)).toContainText('3 小时')
})

test('a previous successful save is not replayed over a newer authoritative value on remount', async ({ page, context }) => {
  const server = await setupInstantServer(context, 10); server.setDelay(50)
  await connectedStart(page); await open(page); await input(page).fill('3'); await input(page).press('Enter')
  await expect.poll(() => server.snapshot.data.timePlanning?.dateOverrides?.['2026-10-01']).toBe(180)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]').length)).toBe(0)
  await expect.poll(() => page.evaluate(async () => (await import('/pjsdas/src/cloud/interactionActivity.ts')).interactionIsRecent('instant-owner'))).toBe(false)
  server.backgroundCapacity(360, INSTANT_NOW)
  const reads = server.readCount
  await page.locator('.tsui-settings-button').click()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: '今天', exact: true }).click()
  await expect.poll(() => server.readCount).toBeGreaterThan(reads)
  await expect(summary(page)).toContainText('6 小时')
  await open(page); await expect(input(page)).toHaveValue('6')
})

test('the topbar keeps only the plus visible while retaining its label, 44px target and capture focus behavior', async ({ page }) => {
  await localStart(page)
  const button = page.locator('.tsui-topbar .tsui-tell-button')
  await expect(button).toHaveText('＋')
  await expect(button).toHaveAccessibleName('＋ 告诉 TodayAction')
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    const box = await button.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44)
    await button.focus(); await page.keyboard.press('Enter')
    await expect(page.getByRole('textbox', { name: '要告诉 TodayAction 的内容' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(button).toBeFocused()
  }
  await page.evaluate(() => localStorage.setItem('pjsdas-ui-language', 'en')); await page.reload()
  await expect(button).toHaveText('＋'); await expect(button).toHaveAccessibleName('＋ Tell TodayAction')
})

test('Settings no longer exposes a second time planner and visiting it preserves stored preferences', async ({ page }) => {
  await localStart(page)
  await page.evaluate(async () => {
    await (await import('/pjsdas/src/db.ts')).saveLocalTimePlanning({ version: 1, updatedAt: '2026-10-01T00:00:00Z', timezone: 'Europe/London', defaultDailyMinutes: 180,
      weeklyWindows: [{ weekday: 2, startMinute: 540, endMinute: 600 }], dateOverrides: { '2026-10-06': 360 } })
  })
  const before = await planning(page)
  await page.locator('.tsui-settings-button').click()
  await expect(page.locator('.settings-group > summary').filter({ hasText: '可用时间' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '保存时段', exact: true })).toHaveCount(0)
  expect(await planning(page)).toEqual(before)
})

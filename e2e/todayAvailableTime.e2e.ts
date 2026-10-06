import { expect, test, type Page } from '@playwright/test'

test.use({ timezoneId: 'Asia/Shanghai' })

async function planning(page: Page) {
  return page.evaluate(async () => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open('pjsdas')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('meta', 'readonly')
      const read = tx.objectStore('meta').get('timePlanning')
      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => { db.close(); resolve(read.result ?? null) }
    }
  }))
}

async function seedPlanning(page: Page, value: Record<string, unknown>) {
  await page.evaluate(async value => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('pjsdas')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('meta', 'readwrite')
      tx.objectStore('meta').put({ key: 'timePlanning', version: 1, updatedAt: '2026-10-06T00:00:00Z', ...value })
      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => { db.close(); resolve() }
    }
  }), value)
  await page.reload()
}

const summary = (page: Page) => page.locator('.tsui-capacity summary')
const editor = (page: Page) => page.locator('.tsui-capacity')

test('default tracks the local day on focus, visibility and pageshow without persisting or overwriting an edit', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-06T14:00:00Z'))
  await page.goto('/pjsdas/today')
  await expect(summary(page)).toContainText('2 小时')
  expect(await planning(page)).toBeNull()
  await summary(page).click()
  await expect(editor(page).getByRole('button', { name: '保存', exact: true })).toHaveCount(0)
  await test.info().attach('today-capacity-desktop', { body: await page.screenshot(), contentType: 'image/png' })
  await page.clock.setFixedTime(new Date('2026-10-06T14:15:00Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(summary(page)).toContainText('1 小时 45 分钟')
  await page.clock.setFixedTime(new Date('2026-10-06T15:59:59Z'))
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(summary(page)).toContainText('0 分钟')
  await page.clock.setFixedTime(new Date('2026-10-06T16:00:00Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))
  await expect(summary(page)).toContainText('24 小时')
  await expect(editor(page).locator('input')).toHaveValue('')
  expect(await planning(page)).toBeNull()
})

test('3h and 6h shortcuts persist exactly, survive reload and expire on the next local date', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-06T15:00:00Z'))
  await page.goto('/pjsdas/today')
  await summary(page).click()
  await editor(page).getByRole('button', { name: '3 小时', exact: true }).click()
  await expect(summary(page)).toContainText('3 小时')
  await expect(page.locator('.tsui-capacity-override')).toHaveCount(0)
  await page.reload()
  await expect(summary(page)).toContainText('3 小时')
  await summary(page).click()
  await editor(page).getByRole('button', { name: '6 小时', exact: true }).click()
  await expect(summary(page)).toContainText('6 小时')
  expect((await planning(page)).dateOverrides).toEqual({ '2026-10-06': 360 })
  await page.clock.setFixedTime(new Date('2026-10-06T15:55:00Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(summary(page)).toContainText('6 小时')
  await page.clock.setFixedTime(new Date('2026-10-06T16:00:00Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))
  await expect(summary(page)).toContainText('24 小时')
  await expect(page.locator('.tsui-capacity-override')).toHaveCount(0)
  expect((await planning(page)).dateOverrides).toEqual({ '2026-10-06': 360 })
})

test('legacy preferences stay stored while Today follows the device timezone and custom minutes remain editable', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-06T14:30:00Z'))
  await page.goto('/pjsdas/today')
  await seedPlanning(page, { timezone: 'America/New_York', defaultDailyMinutes: 180 })
  await expect(summary(page)).toContainText('1 小时 30 分钟')
  await summary(page).click()
  await expect(editor(page)).not.toContainText('America/New_York')
  await editor(page).locator('input').fill('0.25')
  await editor(page).locator('input').press('Enter')
  await expect(summary(page)).toContainText('15 分钟')
  await page.reload()
  await expect(summary(page)).toContainText('15 分钟')
  expect(await planning(page)).toMatchObject({ timezone: 'America/New_York', defaultDailyMinutes: 180, dateOverrides: { '2026-10-06': 15 } })
})

test('a clock tick crosses midnight without a reload', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-06T15:59:59Z') })
  await page.clock.pauseAt(new Date('2026-10-06T15:59:59Z'))
  await page.goto('/pjsdas/today')
  await expect(summary(page)).toContainText('0 分钟')
  await page.clock.runFor(1000)
  await expect(summary(page)).toContainText('24 小时')
})

test('saving after a suspended clock crosses midnight targets the current date and honors zero', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-06T15:59:00Z'))
  await page.goto('/pjsdas/today')
  await summary(page).click()
  await editor(page).locator('input').fill('0')
  await page.clock.setFixedTime(new Date('2026-10-06T16:00:00Z'))
  await editor(page).locator('input').press('Enter')
  await expect(editor(page).getByRole('alert')).toContainText('日期、时区或账号已变化')
  expect(await planning(page)).toBeNull()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(summary(page)).toContainText('24 小时')
  await editor(page).locator('input').fill('0')
  await editor(page).locator('input').press('Enter')
  await expect(summary(page)).toContainText('0 分钟')
  expect((await planning(page)).dateOverrides).toEqual({ '2026-10-07': 0 })
  await page.reload()
  await expect(summary(page)).toContainText('0 分钟')
})


test('capacity editor remains usable at a mobile width without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.clock.setFixedTime(new Date('2026-10-06T14:00:00Z'))
  await page.goto('/pjsdas/today')
  await summary(page).click()
  const form = editor(page).locator('form')
  await expect(form).toBeVisible()
  const bounds = await form.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await test.info().attach('today-capacity-mobile', { body: await page.screenshot(), contentType: 'image/png' })
  await editor(page).getByRole('button', { name: '3 小时', exact: true }).click()
  await expect(summary(page)).toContainText('3 小时')
  await expect(form).not.toBeVisible()
})


test('capacity summary and editor wrap at 200 percent text on narrow screens', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-06T04:24:00Z'))
  await page.goto('/pjsdas/today')
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(summary(page)).toContainText('11 小时 36 分钟')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await summary(page).click()
    const form = editor(page).locator('form')
    await expect(form).toBeVisible()
    const bounds = await form.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await test.info().attach(`today-capacity-text200-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
    await summary(page).click()
  }
})


test('short manual summaries keep the editor on-screen across tablet and mobile widths', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-06T14:00:00Z'))
  await page.goto('/pjsdas/today')
  await summary(page).click()
  await editor(page).locator('input').fill('0')
  await editor(page).locator('input').press('Enter')
  await expect(summary(page)).toContainText('0 分钟')
  for (const width of [700, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await summary(page).click()
    const form = editor(page).locator('form')
    await expect(form).toBeVisible()
    const bounds = await form.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await summary(page).click()
  }
})

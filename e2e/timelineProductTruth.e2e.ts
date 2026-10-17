import { MOCK_TARGET_AUTH_ORIGIN } from './support/mockCloudTargets.js'
import { MOCK_TARGET_BACKEND } from './support/mockCloudTargets.js'
import { expect, test } from '@playwright/test'

for (const width of [1440, 390]) test(`Settings operation records preserve chronology, facts and navigation at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  // All data in this regression is synthetic and stays in this browser context.
  await page.route(`${MOCK_TARGET_AUTH_ORIGIN}/**`, route => route.abort())
  await page.route(`${MOCK_TARGET_BACKEND}/**`, route => route.fulfill({ status: 401, body: '{}' }))
  await page.goto('/pjsdas/history')
  await expect(page.getByRole('heading', { name: '操作记录', exact: true })).toBeVisible()
  const records = [
    { id: 'synthetic-import-a', kind: 'history_imported', category: 'note', source: 'excel', title: '合成导入记录 A', recordedAt: '2026-10-05T08:00:00Z', occurredAt: '2026-02-01T09:00:00Z', detail: '保留原始来源事实 A' },
    { id: 'synthetic-import-b', kind: 'history_imported', category: 'note', source: 'excel', title: '合成导入记录 B', recordedAt: '2026-10-05T08:00:00Z', occurredAt: '2026-08-01T09:00:00Z', detail: '保留原始来源事实 B' },
    { id: 'synthetic-command', kind: 'action_status_changed', category: 'action', source: 'user_action', title: '合成撤销记录', recordedAt: '2026-10-06T08:00:00Z', occurredAt: '2026-10-06T08:00:00Z', commandId: `synthetic-command-${'long-id-'.repeat(20)}`, commandOperation: 'action.status.set', changes: { status: { before: 'done', after: 'todo' } } },
  ]
  await page.evaluate(async (items) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('timeline', 'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        for (const item of items) tx.objectStore('timeline').put(item)
      }
    })
  }, records)
  await page.reload()
  const entries = page.locator('.timeline-event[data-record-id^="synthetic-"]')
  await expect(entries).toHaveCount(3)
  await expect(entries.first()).toHaveAttribute('data-record-id', 'synthetic-command')
  const groups = page.locator('.timeline-day').filter({ has: page.locator('[data-record-id^="synthetic-"]') })
  await expect(groups).toHaveCount(2)
  await expect(groups.nth(1).locator('[data-record-id^="synthetic-"]')).toHaveCount(2)
  await expect(groups.first().locator('.timeline-day-label')).toContainText('2026年10月6日')
  await expect(groups.nth(1).locator('.timeline-day-label')).toContainText('2026年10月5日')
  await expect(page.locator('[data-record-id="synthetic-import-a"] .timeline-event-time')).toContainText('事件时间：2026年2月1日')
  await expect(page.locator('[data-record-id="synthetic-command"] .timeline-event-time')).toHaveCount(0)
  await expect(page.locator('[data-record-id="synthetic-command"] .timeline-changes')).toContainText('done → todo')
  await expect(page.locator('[data-record-id="synthetic-import-a"] .timeline-detail')).toHaveText('保留原始来源事实 A')
  await expect(page.locator('.timeline-recorded-time').first()).toContainText('记录于')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: info.outputPath(`operation-records-zh-${width}.png`), fullPage: true })

  await page.getByRole('textbox', { name: '搜索操作记录' }).fill('synthetic-command-')
  await expect(entries).toHaveCount(1)
  await page.getByRole('textbox', { name: '搜索操作记录' }).fill('no-synthetic-match')
  await expect(page.getByText('没有匹配的操作记录', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '搜索操作记录' }).clear()
  await page.getByRole('combobox', { name: '记录来源' }).selectOption('excel')
  await expect(entries).toHaveCount(2)
  await page.getByRole('combobox', { name: '记录来源' }).selectOption('all')
  await page.getByRole('combobox', { name: '记录类型' }).selectOption('action')
  await expect(entries).toHaveCount(1)
  await page.getByRole('combobox', { name: '记录类型' }).selectOption('all')

  await page.getByRole('button', { name: '返回设置' }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
  const interfaceGroup = page.locator('details.settings-group').filter({ has: page.locator('summary strong').filter({ hasText: '界面' }) })
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  const historyGroup = page.locator('details.settings-group').filter({ has: page.locator('summary strong').filter({ hasText: 'Operation records' }) })
  await historyGroup.locator('summary').click()
  await expect(historyGroup.getByRole('button', { name: 'Historical review / Data quality' })).toBeVisible()
  await historyGroup.getByRole('button', { name: 'Open operation records' }).click()
  await expect(page).toHaveURL(/\/history$/)
  await expect(page.getByRole('heading', { name: 'Operation records', exact: true })).toBeVisible()
  await expect(page.locator('.timeline-summary')).toContainText('All records')
  await expect(page.locator('.timeline-recorded-time').first()).toContainText('Recorded')
  await expect(page.locator('[data-record-id="synthetic-import-a"] .timeline-event-time')).toContainText('Event time:')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: info.outputPath(`operation-records-en-${width}.png`), fullPage: true })
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.goForward()
  await expect(page.getByRole('heading', { name: 'Operation records', exact: true })).toBeVisible()
  await page.reload()
  await expect(entries).toHaveCount(3)
  await page.getByRole('button', { name: 'Back to Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  const stored = await page.evaluate(async () => new Promise<unknown[]>((resolve, reject) => {
    const request = indexedDB.open('pjsdas')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('timeline', 'readonly'), read = tx.objectStore('timeline').getAll()
      read.onsuccess = () => resolve(read.result)
      tx.oncomplete = () => db.close()
      tx.onerror = () => reject(tx.error)
    }
  }))
  expect(stored).toEqual(expect.arrayContaining(records))
  expect(stored).toHaveLength(records.length)
})

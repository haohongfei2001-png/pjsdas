import { expect, test } from '@playwright/test'

test('Today capacity is a durable user choice and flexible overflow leaves the workspace intact', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-25T01:00:00.000Z'))
  await page.goto('/pjsdas/today')
  await page.evaluate(async () => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('pjsdas', 11)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('actions', 'readwrite')
      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => { db.close(); resolve() }
      for (let index = 0; index < 60; index += 1) tx.objectStore('actions').put({
        id: `zmc-task-${index}`, kind: 'manual', title: `可顺延的准备 ${index}`,
        status: 'todo', estimatedMinutes: 30, leverage: 70, delayCost: 40,
        dueAt: '2026-09-25', duePrecision: 'date', timingMode: 'deadline',
        createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
      })
    }
  }))
  await page.reload()
  await expect(page.locator('.tsui-task-row')).toHaveCount(1)
  await expect(page.getByText('今天的安排可能超出可用时间')).toHaveCount(0)
  await page.locator('.tsui-capacity summary').click()
  await page.locator('.tsui-capacity input').fill('2')
  await page.locator('.tsui-capacity button[type=submit]').click()
  await expect(page.locator('.tsui-task-row')).toHaveCount(4)
  await page.reload()
  await expect(page.locator('.tsui-capacity summary')).toContainText('2 小时')
  await expect(page.locator('.tsui-task-row')).toHaveCount(4)
  const persisted = await page.evaluate(async () => new Promise<{ minutes?: number; count: number }>((resolve, reject) => {
    const request = indexedDB.open('pjsdas', 11)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(['meta', 'actions'], 'readonly')
      const pref = tx.objectStore('meta').get('timePlanning')
      const count = tx.objectStore('actions').count()
      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => { db.close(); resolve({ minutes: pref.result?.dateOverrides?.['2026-09-25'], count: count.result }) }
    }
  }))
  expect(persisted).toEqual({ minutes: 120, count: 60 })
})

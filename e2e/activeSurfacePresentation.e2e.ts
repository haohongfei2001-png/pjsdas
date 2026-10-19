import { expect, test } from '@playwright/test'
import { freezeTodayFixture } from './support/consumerFixtureClock.js'

test.beforeEach(async ({ page }) => { await freezeTodayFixture(page) })

test('active Today localizes timing while retired preparation remains hidden and unchanged', async ({ page }) => {
  await page.goto('/')

  const seeded = await page.evaluate(async () => {
    const now = Date.now()
    const action = {
      id: 'active-presentation-action',
      kind: 'manual',
      title: 'Timed follow-up',
      dueAt: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
      duePrecision: 'datetime',
      timingMode: 'deadline',
      estimatedMinutes: 20,
      leverage: 90,
      delayCost: 90,
      status: 'todo', plannedDate: '2026-09-30',
      sourceLabel: 'E2E',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }
    const prepItems = [
      {
        id: 'prep:highest-english',
        title: 'Highest English',
        priorityLabel: 'Highest',
        sourceStatus: 'Waiting',
        estimatedMinutes: 30,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
      {
        id: 'prep:medium-high-chinese',
        title: 'Medium-high Chinese',
        priorityLabel: '中高',
        sourceStatus: '进行中',
        estimatedMinutes: 45,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    ]

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['actions', 'prep'], 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
        transaction.objectStore('actions').put(action)
        for (const item of prepItems) transaction.objectStore('prep').put(item)
      }
    })
    return { action, prepItems }
  })

  await page.reload()
  const primary = page.locator('.tsui-task-row').first()
  await expect(primary.getByRole('heading', { name: 'Timed follow-up' })).toBeVisible()
  await expect(primary.locator('.tsui-task-copy > span')).toContainText('截止')
  await expect(primary.locator('.tsui-task-copy')).toContainText('Timed follow-up')

  await page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group').filter({ has: page.locator('summary strong').filter({ hasText: /^(界面|Interface)$/ }) })
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /Today/ }).click()
  await expect(primary.locator('.tsui-task-copy > span')).toContainText('Due')
  await expect(primary.getByRole('heading', { name: 'Timed follow-up' })).toBeVisible()
  await expect(primary).not.toContainText('截止')

  await page.locator('.tsui-primary-nav').getByRole('button', { name: /Jobs/ }).click()
  await expect(page.getByRole('heading', { name: 'Job library', exact: true })).toBeVisible()
  await expect(page.locator('.tsui-library-secondary button').filter({ hasText: /准备|Preparation/ })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Preparation inventory' })).toHaveCount(0)
  await expect(page.locator('.surface-prep-grid, .prep-graph-dock-trigger, .prep-graph-dialog')).toHaveCount(0)
  for (const prep of seeded.prepItems) await expect(page.getByText(prep.title, { exact: true })).toHaveCount(0)

  await page.locator('.tsui-primary-nav').getByRole('button', { name: /Today/ }).click()
  await page.reload()
  await expect(primary.getByRole('heading', { name: 'Timed follow-up' })).toBeVisible()
  await expect(primary.locator('.tsui-task-copy > span')).toContainText('Due')
  await expect(primary).not.toContainText('截止')
  const persisted = await page.evaluate(async ({ action, prepItems }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('pjsdas')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction(['actions', 'prep'], 'readonly')
      const task = transaction.objectStore('actions').get(action.id)
      const items = prepItems.map(item => transaction.objectStore('prep').get(item.id))
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
      transaction.oncomplete = () => { db.close(); resolve({ action: task.result, prepItems: items.map(item => item.result) }) }
    }
  }), seeded)
  expect(persisted).toEqual(seeded)
})

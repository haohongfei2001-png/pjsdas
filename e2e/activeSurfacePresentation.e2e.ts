import { expect, test } from '@playwright/test'

test('active Today and Prepare surfaces localize presentation without changing stored facts', async ({ page }) => {
  await page.goto('/')

  await page.evaluate(async () => {
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
      status: 'todo',
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
      const request = indexedDB.open('pjsdas', 11)
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
  })

  await page.reload()
  const primary = page.locator('.tsui-task-row').first()
  await expect(primary.getByRole('heading', { name: 'Timed follow-up' })).toBeVisible()
  await expect(primary.locator('.tsui-task-copy > span')).toContainText('截止')
  await expect(primary.locator('.tsui-task-copy')).toContainText('Timed follow-up')

  await page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /Today/ }).click()
  await expect(primary.locator('.tsui-task-copy > span')).toContainText('Due')
  await expect(primary.getByRole('heading', { name: 'Timed follow-up' })).toBeVisible()
  await expect(primary).not.toContainText('截止')

  await page.locator('.tsui-primary-nav').getByRole('button', { name: /Jobs/ }).click()
  await page.locator('.surface-context-tabs button').filter({ hasText: 'Prepare' }).click()
  await expect(page.getByRole('heading', { name: 'Preparation inventory' })).toBeVisible()

  const cards = page.locator('.surface-prep-grid article')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0).getByRole('heading')).toHaveText('Highest English')
  await expect(cards.nth(0)).toContainText('Highest')
  await expect(cards.nth(0)).toContainText('Waiting')
  await expect(cards.nth(1).getByRole('heading')).toHaveText('Medium-high Chinese')
  await expect(cards.nth(1)).toContainText('Medium-high')
  await expect(cards.nth(1)).toContainText('Active')
  await expect(cards.nth(1)).not.toContainText('中高')
})

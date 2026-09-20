import { expect, test } from '@playwright/test'

test('active Today and Prepare surfaces localize system semantics without changing stored facts', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  await page.evaluate(async () => {
    const now = Date.now()
    const action = {
      id: 'active-presentation-action',
      kind: 'manual',
      title: 'Timed follow-up',
      dueAt: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
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
      const request = indexedDB.open('pjsdas', 8)
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
  const countdown = page.locator('.decision-hero .deadline-countdown')
  await expect(countdown.locator('strong')).toContainText('剩')
  await expect(countdown.locator('span')).toHaveText('高风险')

  await page.locator('.surface-nav').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.surface-nav').getByRole('button', { name: /Today/ }).click()
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
  await expect(countdown.locator('strong')).toHaveText(/\d+ hr(?: \d+ min)? left/)
  await expect(countdown.locator('span')).toHaveText('High risk')
  await expect(countdown).not.toContainText('剩')

  await page.locator('.surface-nav').getByRole('button', { name: /Opportunities/ }).click()
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
  await expect(cards.nth(1)).not.toContainText('进行中')
})

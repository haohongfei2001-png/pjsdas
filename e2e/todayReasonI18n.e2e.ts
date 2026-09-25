import { expect, test } from '@playwright/test'

const opportunity = {
  id: 'e2e-today-reason-job',
  company: 'Reason Labs',
  role: 'AI Product Manager',
  currentStageLabel: '待投递',
  processStage: 'not_applied',
  roleType: 'core',
  early: true,
  opportunityValue: 90,
  fitScore: 85,
  locallyManaged: true,
  importedAt: '2026-09-14T00:00:00.000Z',
}

const action = {
  id: 'e2e-today-reason-action',
  kind: 'apply',
  title: 'Prepare application',
  opportunityId: opportunity.id,
  processStage: 'not_applied',
  estimatedMinutes: 20,
  leverage: 80,
  delayCost: 80,
  status: 'todo',
  sourceLabel: 'E2E',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
}

test('Today keeps the same exact action identity while labels follow UI language', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async ({ opportunity, action }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'actions'], 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
        transaction.objectStore('opportunities').put(opportunity)
        transaction.objectStore('actions').put(action)
      }
    })
  }, { opportunity, action })
  await page.reload()

  const focus = page.locator('.tsui-task-row[data-action-id="e2e-today-reason-action"]')
  await expect(focus.getByRole('heading', { name: 'Prepare application' })).toBeVisible()
  await expect(focus.locator('.tsui-task-context')).toContainText('Reason Labs')
  await expect(focus.locator('.tsui-done-action')).toHaveText('我已投递')

  await page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /Today/ }).click()

  await expect(focus.getByRole('heading', { name: 'Prepare application' })).toBeVisible()
  await expect(focus.locator('.tsui-done-action')).toHaveText('I applied')
  await expect(page.getByText('核心机会', { exact: true })).toHaveCount(0)
})

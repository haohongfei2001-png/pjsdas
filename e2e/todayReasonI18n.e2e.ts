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

test('Today priority explanations follow UI language immediately without changing the ranked action', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await page.evaluate(async ({ opportunity, action }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 8)
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
  const focus = page.locator('.surface-focus-card')
  await expect(focus.getByRole('heading', { name: 'Prepare application' })).toBeVisible()
  await expect(focus.locator('p')).toHaveText('核心机会 · 早投有收益 · 现实成功率较高')

  await page.getByRole('button', { name: 'EN', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Only the next moves for today' })).toBeVisible()
  await expect(focus.getByRole('heading', { name: 'Prepare application' })).toBeVisible()
  await expect(focus.locator('p')).toHaveText('Core opportunity · Early-application advantage · Strong fit')
  await expect(page.getByText('核心机会', { exact: true })).toHaveCount(0)

  const row = page.locator('.surface-action-row').filter({ hasText: 'Prepare application' })
  await expect(row.locator('small')).toContainText('Core · Core opportunity · Early-application advantage · Strong fit')
})

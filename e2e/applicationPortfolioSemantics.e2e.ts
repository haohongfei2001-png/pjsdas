import { expect, test } from '@playwright/test'

const opportunity = {
  id: 'e2e-portfolio-pending',
  company: '组合测试科技',
  role: 'AI产品经理',
  currentStageLabel: '待投递',
  processStage: 'not_applied',
  roleType: 'core',
  early: false,
  applicationGroupId: 'E2E-PORTFOLIO-GROUP',
  prepEstimateMinutes: 30,
  opportunityValue: 94,
  fitScore: 91,
  locallyManaged: true,
  importedAt: '2026-09-14T00:00:00.000Z',
}

const group = {
  id: 'E2E-PORTFOLIO-GROUP',
  company: '组合测试科技',
  total: 1,
  used: 0,
  remaining: 1,
}

test('canonical pending state drives visible priority and portfolio selection regardless of stored label', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  await page.evaluate(async ({ opportunity, group }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 8)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'applicationGroups'], 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
        transaction.objectStore('opportunities').put(opportunity)
        transaction.objectStore('applicationGroups').put(group)
      }
    })
  }, { opportunity, group })

  await page.reload()
  await page.locator('.surface-nav').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.surface-nav').getByRole('button', { name: /Opportunities/ }).click()

  const row = page.locator('.surface-opportunity-row').filter({ hasText: opportunity.company })
  await expect(row).toBeVisible()
  await expect(row).toContainText('P2')
  await expect(row).not.toContainText('Pipeline')

  await page.getByRole('button', { name: 'Portfolio' }).click()
  const dialog = page.locator('.portfolio-dialog')
  await expect(dialog.getByRole('heading', { name: 'Application portfolio decisions' })).toBeVisible()
  await expect(dialog).toContainText('Recommended portfolio · 1')
  await expect(dialog).toContainText('High opportunity value')
  await expect(dialog).toContainText('Strong fit')
  await expect(dialog).toContainText('Core opportunity')
  await expect(dialog).not.toContainText('机会价值高')
  await expect(dialog).not.toContainText('V1.6')
})

import { expect, test } from '@playwright/test'

test('Prep Graph keeps source facts but localizes system status and link explanations', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  await page.evaluate(async () => {
    const opportunity = {
      id: 'prep-i18n-job',
      company: '示例科技',
      role: 'AI 产品经理',
      currentStageLabel: '待投递',
      processStage: 'not_applied',
      roleType: 'core',
      early: false,
      opportunityValue: 88,
      fitScore: 82,
      importedAt: '2026-09-14T00:00:00.000Z',
    }
    const prep = {
      id: 'prep-i18n-item',
      title: 'SQL readiness',
      triggeredBy: 'prep-i18n-job',
      estimatedMinutes: 45,
      sourceStatus: '等待触发',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
    }

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'prep'], 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
        transaction.objectStore('opportunities').put(opportunity)
        transaction.objectStore('prep').put(prep)
      }
    })
  })

  await page.reload()
  await page.locator('.surface-nav').getByRole('button', { name: /机会/ }).click()
  await page.locator('.opportunity-decision-filter select').selectOption('all')
  await page.locator('.opportunity-decision-row').filter({ hasText: '示例科技' }).click()
  const opportunityDetail = page.getByRole('dialog', { name: '岗位详情' })
  await opportunityDetail.getByText('准备与相关待办').click()
  await expect(opportunityDetail.locator('.opportunity-detail-related-prep')).toContainText('SQL readiness')
  await expect(opportunityDetail.locator('.opportunity-detail-related-prep')).toContainText('显式指向该岗位')
  await opportunityDetail.getByRole('button', { name: '关闭' }).click()
  await page.locator('.surface-context-tabs button').filter({ hasText: '准备' }).click()
  await page.locator('.ultimate-toolbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.surface-nav').getByRole('button', { name: /Opportunities/ }).click()
  await page.locator('.surface-context-tabs button').filter({ hasText: 'Prepare' }).click()
  await page.getByRole('button', { name: 'Prep Graph' }).click()

  const dialog = page.locator('.prep-graph-dialog')
  await expect(dialog.getByRole('heading', { name: 'Preparation leverage graph' })).toBeVisible()
  await expect(dialog.getByText('PREP GRAPH', { exact: true })).toBeVisible()
  await expect(dialog.getByText(/V1\.6/)).toHaveCount(0)
  await expect(dialog.getByText('Waiting', { exact: true })).toBeVisible()
  await expect(dialog.locator('.prep-graph-node-head').getByText('SQL readiness', { exact: true })).toBeVisible()

  await dialog.getByText('See 1 deterministic links', { exact: true }).click()
  await expect(dialog.getByText('This Prep explicitly names the opportunity or its application group as a trigger.', { exact: true })).toBeVisible()
})

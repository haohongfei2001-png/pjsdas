import { expect, test } from '@playwright/test'

test('retired preparation stays absent in both languages without changing source facts', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  const seeded = await page.evaluate(async () => {
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
      const request = indexedDB.open('pjsdas')
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
    return { opportunity, prep }
  })

  await page.reload()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /岗位库/ }).click()
  await page.locator('.opportunity-decision-row').filter({ hasText: '示例科技' }).click()
  const opportunityDetail = page.locator('.job-detail-page')
  await expect(opportunityDetail.locator('.opportunity-detail-related-prep')).toHaveCount(0)
  await expect(opportunityDetail.getByText('SQL readiness', { exact: true })).toHaveCount(0)
  await expect(opportunityDetail.getByRole('button', { name: /查看准备/ })).toHaveCount(0)
  await page.locator('.job-detail-back').click()
  await expect(page.locator('.tsui-library-secondary button').filter({ hasText: '准备' })).toHaveCount(0)
  await expect(page.locator('.prep-graph-dock-trigger, .prep-graph-dialog, .surface-prep-grid')).toHaveCount(0)
  await page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group').filter({ has: page.locator('summary strong').filter({ hasText: /^(界面|Interface)$/ }) })
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /Jobs/ }).click()
  await expect(page.getByRole('heading', { name: 'Job library', exact: true })).toBeVisible()
  await expect(page.locator('.tsui-library-secondary button').filter({ hasText: 'Preparation' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Prep Graph', exact: true })).toHaveCount(0)
  await page.locator('.opportunity-decision-row').filter({ hasText: seeded.opportunity.company }).click()
  await expect(page.locator('.job-detail-page')).toContainText(seeded.opportunity.company)
  await expect(page.locator('.job-detail-page')).toContainText(seeded.opportunity.role)
  await expect(page.locator('.opportunity-detail-related-prep, .prep-graph-dialog, .surface-prep-grid')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /View preparation/ })).toHaveCount(0)
  await expect(page.getByText('SQL readiness', { exact: true })).toHaveCount(0)

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('.job-detail-page')).toContainText(seeded.opportunity.company)
  await expect(page.locator('.opportunity-detail-related-prep, .prep-graph-dialog, .surface-prep-grid')).toHaveCount(0)
  const persisted = await page.evaluate(async ({ opportunity, prep }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('pjsdas')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction(['opportunities', 'prep'], 'readonly')
      const job = transaction.objectStore('opportunities').get(opportunity.id)
      const item = transaction.objectStore('prep').get(prep.id)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
      transaction.oncomplete = () => { db.close(); resolve({ opportunity: job.result, prep: item.result }) }
    }
  }), seeded)
  expect(persisted).toEqual(seeded)
})

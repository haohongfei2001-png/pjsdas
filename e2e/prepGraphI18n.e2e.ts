import { expect, test } from '@playwright/test'

test('Prep Graph keeps source facts but localizes system status and link explanations', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

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
      const request = indexedDB.open('pjsdas', 8)
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
  await page.getByRole('button', { name: '准备 练什么' }).click()
  await page.getByRole('button', { name: 'EN' }).first().click()
  await page.getByRole('button', { name: 'Prep Graph' }).click()

  await expect(page.getByRole('heading', { name: 'Preparation leverage graph' })).toBeVisible()
  await expect(page.getByText('PREP GRAPH', { exact: true })).toBeVisible()
  await expect(page.getByText(/V1\.6/)).toHaveCount(0)
  await expect(page.getByText('Waiting', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'SQL readiness' })).toBeVisible()

  await page.getByText('See 1 deterministic links', { exact: true }).click()
  await expect(page.getByText('This Prep explicitly names the opportunity or its application group as a trigger.', { exact: true })).toBeVisible()
})

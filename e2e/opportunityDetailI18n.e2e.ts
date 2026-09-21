import { expect, test } from '@playwright/test'

const opportunity = {
  id: 'e2e-i18n-opportunity',
  company: '阶段测试科技',
  role: 'AI产品经理',
  currentStageLabel: '待投递',
  processStage: 'not_applied',
  roleType: 'core',
  early: false,
  opportunityValue: 86,
  fitScore: 82,
  locallyManaged: true,
  importedAt: '2026-09-14T00:00:00.000Z',
}

const action = {
  id: 'e2e-i18n-action',
  kind: 'apply',
  title: '提交阶段测试科技 AI 产品经理申请',
  opportunityId: opportunity.id,
  estimatedMinutes: 30,
  leverage: 80,
  delayCost: 90,
  status: 'todo',
  processStage: 'not_applied',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
}

test('opportunity detail localizes canonical stage and action status without changing stored data', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  await page.evaluate(async ({ opportunity, action }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 10)
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
  await page.locator('.surface-nav').getByRole('button', { name: /机会/ }).click()
  await page.locator('.ultimate-toolbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.surface-nav').getByRole('button', { name: /Opportunities/ }).click()
  await page.getByRole('button', { name: /Worth Pursuing/ }).click()
  await page.locator('.opportunity-decision-row').filter({ hasText: opportunity.company }).click()

  const dialog = page.getByRole('dialog', { name: 'Opportunity details' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Not applied', { exact: true }).first()).toBeVisible()
  await expect(dialog.locator('.opportunity-detail-conclusion')).toContainText('Worth pursuing')
  await dialog.getByText('Preparation & related actions', { exact: true }).click()
  await expect(dialog.getByText('To do', { exact: true })).toBeVisible()
  await expect(dialog.getByText('待投递', { exact: true })).toHaveCount(0)
  await expect(dialog.getByText('todo', { exact: true })).toHaveCount(0)
  await expect(dialog.locator('.opportunity-detail-score-grid')).toHaveCount(0)

  const stored = await page.evaluate(async () => {
    return new Promise<{ stage?: string; status?: string }>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 10)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'actions'], 'readonly')
        const opportunityRequest = transaction.objectStore('opportunities').get('e2e-i18n-opportunity')
        const actionRequest = transaction.objectStore('actions').get('e2e-i18n-action')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          const stage = opportunityRequest.result?.currentStageLabel
          const status = actionRequest.result?.status
          db.close()
          resolve({ stage, status })
        }
      }
    })
  })
  expect(stored).toEqual({ stage: '待投递', status: 'todo' })
})

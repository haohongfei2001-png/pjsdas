import { expect, test } from '@playwright/test'

const opportunity = {
  id: 'e2e-pipeline-i18n-opportunity',
  company: '流程测试科技',
  role: 'AI产品经理',
  currentStageLabel: '筛选中',
  processStage: 'screening',
  roleType: 'core',
  early: false,
  opportunityValue: 86,
  fitScore: 82,
  locallyManaged: true,
  importedAt: '2026-09-14T00:00:00.000Z',
}

const process = {
  id: 'e2e-pipeline-i18n-process',
  opportunityId: opportunity.id,
  company: opportunity.company,
  role: opportunity.role,
  stage: 'screening',
  stageLabel: '筛选中',
  lastProgressAt: '2026-09-14T00:00:00.000Z',
  locallyManaged: true,
}

async function seed(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
  await page.evaluate(async ({ opportunity, process }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 9)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'processes'], 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
        transaction.objectStore('opportunities').put(opportunity)
        transaction.objectStore('processes').put(process)
      }
    })
  }, { opportunity, process })
  await page.reload()
}

test('Pipeline and mobile opportunity cards localize canonical stored stages without mutating them', async ({ page }) => {
  await seed(page)
  await page.locator('.surface-nav').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.surface-nav').getByRole('button', { name: /Opportunities/ }).click()
  await page.locator('.surface-context-tabs button').filter({ hasText: 'Opportunities' }).click()
  await page.locator('.surface-context-tabs button').filter({ hasText: 'Pipeline' }).click()

  await expect(page.locator('.surface-stage')).toHaveText('Screening')
  await expect(page.getByText('筛选中', { exact: true })).toHaveCount(0)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.surface-context-tabs button').filter({ hasText: 'Opportunities' }).click()
  const mobileCard = page.locator('.surface-opportunity-mobile-list button').filter({ hasText: opportunity.company })
  await expect(mobileCard).toBeVisible()
  await expect(mobileCard.locator('small')).toHaveText('Screening')

  const stored = await page.evaluate(async () => {
    return new Promise<{ opportunityStage?: string; processStage?: string }>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 9)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'processes'], 'readonly')
        const opportunityRequest = transaction.objectStore('opportunities').get('e2e-pipeline-i18n-opportunity')
        const processRequest = transaction.objectStore('processes').get('e2e-pipeline-i18n-process')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          const opportunityStage = opportunityRequest.result?.currentStageLabel
          const processStage = processRequest.result?.stageLabel
          db.close()
          resolve({ opportunityStage, processStage })
        }
      }
    })
  })
  expect(stored).toEqual({ opportunityStage: '筛选中', processStage: '筛选中' })
})

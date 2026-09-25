import { expect, test, type Page } from '@playwright/test'

const opportunity = {
  id: 'e2e-opportunity',
  company: '矩阵科技',
  role: 'AI产品经理',
  currentStageLabel: '待投递',
  processStage: 'not_applied',
  roleType: 'core',
  early: false,
  opportunityValue: 86,
  fitScore: 82,
  deadline: '2026-09-20T23:59:59.000Z',
  locallyManaged: true,
  importedAt: '2026-09-14T00:00:00.000Z',
}

const action = {
  id: 'e2e-action',
  kind: 'manual',
  title: '准备矩阵科技 AI 产品经理申请材料',
  opportunityId: 'e2e-opportunity',
  estimatedMinutes: 30,
  leverage: 80,
  delayCost: 90,
  dueAt: '2026-09-20T23:59:59.000Z',
  processStage: 'not_applied',
  status: 'todo',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
}

async function seedLocalWorkspace(page: Page) {
  // This fixture represents an open application window, independent of the runner's date.
  await page.clock.setFixedTime(new Date('2026-09-18T08:00:00.000Z'))
  await page.goto('/')
  await page.evaluate(async ({ opportunity, action }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'actions'], 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => { db.close(); resolve() }
        transaction.objectStore('opportunities').put(opportunity)
        transaction.objectStore('actions').put(action)
      }
    })
  }, { opportunity, action })
  await page.reload()
  await expect(page.getByRole('heading', { name: '准备矩阵科技 AI 产品经理申请材料' })).toBeVisible()
}

test('empty local workspace routes directly into setup instead of a maintenance queue', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
  await expect(page.getByText('先让 PJSDAS 了解你的求职进展')).toBeVisible()
  await page.getByRole('button', { name: '打开设置' }).click()
  await expect(page.getByRole('heading', { name: '连接、自动化和长期控制' })).toBeVisible()
  await expect(page.locator('.cloud-connection-impact')).toContainText('当前内容只保存在此设备')
  await expect(page).toHaveURL(/\/settings$/)
})

test('critical local-first action flow survives completion, undo, and browser reload', async ({ page }) => {
  await seedLocalWorkspace(page)

  await expect(page.locator('.tsui-task-row')).toHaveCount(1)
  await page.locator('.tsui-task-row .tsui-done-action').click()
  await expect(page.getByRole('status')).toContainText('已完成')
  await expect(page.getByRole('heading', { name: '准备矩阵科技 AI 产品经理申请材料' })).toHaveCount(0)

  await page.getByRole('button', { name: '撤销' }).click()
  await expect(page.getByRole('heading', { name: '准备矩阵科技 AI 产品经理申请材料' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: '准备矩阵科技 AI 产品经理申请材料' })).toBeVisible()

  const persistedStatus = await page.evaluate(async () => new Promise<string | undefined>((resolve, reject) => {
    const request = indexedDB.open('pjsdas', 11)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('actions', 'readonly')
      const getRequest = tx.objectStore('actions').get('e2e-action')
      getRequest.onerror = () => reject(getRequest.error)
      getRequest.onsuccess = () => { db.close(); resolve(getRequest.result?.status) }
    }
  }))
  expect(persistedStatus).toBe('todo')
})

test('primary navigation, language, recovery, and global Tell PJSDAS stay coherent in English', async ({ page }) => {
  await seedLocalWorkspace(page)

  await page.locator('.tsui-primary-nav').getByRole('button', { name: /岗位库/ }).click()
  await expect(page.getByRole('heading', { name: '岗位库' })).toBeVisible()

  await page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()

  await page.locator('.tsui-primary-nav').getByRole('button', { name: /Jobs/ }).click()
  await expect(page.getByRole('heading', { name: 'Job library' })).toBeVisible()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /Today/ }).click()
  await expect(page.locator('.tsui-page-heading').getByRole('heading', { name: 'Today', exact: true })).toBeVisible()

  await page.locator('.tsui-topbar').getByRole('button', { name: /Settings/ }).click()
  const dataRecovery = page.locator('details.settings-group').filter({ hasText: 'Data & recovery' })
  await dataRecovery.locator('summary').click()
  await page.getByRole('button', { name: '+ Record process event' }).click()
  await expect(page.getByRole('heading', { name: 'Record a real recruiting event' })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()

  await page.locator('.tsui-tell-button').click()
  await expect(page.getByRole('heading', { name: 'Tell PJSDAS', exact: true })).toBeVisible()
  await expect(page.locator('.cgr-capture-input')).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()

  await page.locator('.tsui-primary-nav').getByRole('button', { name: /Today/ }).click()
  await page.reload()
  await expect(page.locator('.tsui-page-heading').getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})

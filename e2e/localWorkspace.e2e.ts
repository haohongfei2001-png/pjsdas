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
  kind: 'apply',
  title: '提交矩阵科技 AI 产品经理申请',
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
  await expect(page.getByRole('heading', { name: '提交矩阵科技 AI 产品经理申请' })).toBeVisible()
}

test('empty local workspace routes directly into setup instead of a maintenance queue', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '先让工作区有第一批真实机会' })).toBeVisible()

  await page.getByRole('button', { name: '打开设置' }).click()
  await expect(page.getByRole('heading', { name: '连接、自动化和长期控制' })).toBeVisible()
})

test('critical local-first action flow survives completion, undo, and browser reload', async ({ page }) => {
  await seedLocalWorkspace(page)

  await expect(page.locator('.decision-kicker')).toHaveText('下一步')
  await page.getByRole('button', { name: '完成' }).first().click()
  await expect(page.getByRole('status')).toContainText('已标记完成')
  await expect(page.getByRole('heading', { name: '提交矩阵科技 AI 产品经理申请' })).toHaveCount(0)

  await page.getByRole('button', { name: '撤销' }).click()
  await expect(page.getByRole('heading', { name: '提交矩阵科技 AI 产品经理申请' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: '提交矩阵科技 AI 产品经理申请' })).toBeVisible()

  const persistedStatus = await page.evaluate(async () => {
    return new Promise<string | undefined>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 10)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction('actions', 'readonly')
        const getRequest = transaction.objectStore('actions').get('e2e-action')
        getRequest.onerror = () => reject(getRequest.error)
        getRequest.onsuccess = () => {
          db.close()
          resolve(getRequest.result?.status)
        }
      }
    })
  })
  expect(persistedStatus).toBe('todo')
})

test('primary navigation, language, and quick-capture surfaces stay coherent in English', async ({ page }) => {
  await seedLocalWorkspace(page)

  await page.locator('.surface-nav').getByRole('button', { name: /机会/ }).click()
  await expect(page.getByRole('heading', { name: '机会、流程和准备在同一个工作面' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'AI产品经理' })).toBeVisible()

  await page.locator('.surface-nav').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.surface-nav').getByRole('button', { name: /Opportunities/ }).click()
  await expect(page.getByRole('heading', { name: 'Opportunities, pipeline, and preparation in one workspace' })).toBeVisible()

  await page.locator('.surface-nav').getByRole('button', { name: /Today/ }).click()
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()

  await page.locator('.surface-nav').getByRole('button', { name: /Settings/ }).click()
  const dataRecovery = page.locator('details.settings-group').filter({ hasText: 'Data & recovery' })
  await dataRecovery.locator('summary').click()
  await page.getByRole('button', { name: '+ Record process event' }).click()
  await expect(page.getByRole('heading', { name: 'Record a real recruiting event' })).toBeVisible()
  await expect(page.locator('.event-form select').first().locator('option[value="assessment_invite"]')).toHaveText('Assessment invitation')
  await page.getByRole('button', { name: 'Close' }).click()

  await page.getByRole('button', { name: 'Update progress / task' }).click()
  await expect(page.getByRole('heading', { name: 'Tell PJSDAS about recruiting progress or another task' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Parse and generate ChangeSet' })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})

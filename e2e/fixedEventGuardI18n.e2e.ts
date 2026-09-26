import { expect, test, type Page } from '@playwright/test'

const opportunity = {
  id: 'e2e-overdue-opportunity',
  company: '节点测试科技',
  role: 'AI产品经理',
  currentStageLabel: '面试',
  processStage: 'interview',
  roleType: 'core',
  early: false,
  opportunityValue: 86,
  fitScore: 82,
  locallyManaged: true,
  importedAt: '2026-09-01T00:00:00.000Z',
}

const processEvent = {
  id: 'e2e-overdue-event',
  opportunityId: opportunity.id,
  company: opportunity.company,
  role: opportunity.role,
  type: 'interview_invite',
  occurredAt: '2026-09-01T00:00:00.000Z',
  dueAt: '2026-09-02T10:00:00.000Z',
  duePrecision: 'datetime',
  timingMode: 'fixed',
  estimatedMinutes: 60,
  source: 'manual',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

async function seedPastEvent(page: Page) {
  await page.evaluate(async ({ opportunity, processEvent }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'processEvents'], 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
        transaction.objectStore('opportunities').put(opportunity)
        transaction.objectStore('processEvents').put(processEvent)
      }
    })
  }, { opportunity, processEvent })
  await page.reload()
}

async function openCapture(page: Page) {
  await page.locator('.tsui-tell-button').click()
  await expect(page.getByRole('heading', { name: '告诉 TodayAction' })).toBeVisible()
}

test('elapsed recruiting node stays unresolved until an explicit completion fact resolves it', async ({ page }) => {
  await page.goto('/')
  await seedPastEvent(page)

  await page.locator('.tsui-unresolved-link').click()
  const unresolved = page.locator('.tsui-schedule-panel .tsui-schedule-row').filter({ hasText: '节点测试科技' })
  await expect(unresolved).toBeVisible()
  await expect(unresolved).toContainText('面试')
  await expect(unresolved).toContainText('待确认')

  await page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /Schedule/ }).click()
  await page.locator('.tsui-schedule-context').getByRole('button', { name: /Past arrangements to confirm/ }).click()
  await expect(page.locator('.tsui-schedule-panel .tsui-schedule-row').filter({ hasText: 'Unresolved' })).toBeVisible()

  await page.locator('.tsui-tell-button').click()
  await page.locator('.cgr-capture-input').fill('节点测试科技 AI产品经理 面试已经完成。')
  await page.getByRole('button', { name: 'Confirm and save' }).click()
  await expect(page.getByRole('status')).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()

  await expect(page.locator('.tsui-schedule-panel .tsui-schedule-row').filter({ hasText: '节点测试科技' })).toHaveCount(0)
})

test('a question about an elapsed event remains read-only and does not complete it', async ({ page }) => {
  await page.goto('/')
  await seedPastEvent(page)

  await openCapture(page)
  await page.locator('.cgr-capture-input').fill('节点测试科技 AI产品经理 面试完成了吗？')
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByRole('status')).toContainText('没有被当作当前事实写入')
  await page.getByRole('button', { name: '关闭' }).click()

  await page.locator('.tsui-unresolved-link').click()
  await expect(page.locator('.tsui-schedule-panel .tsui-schedule-row').filter({ hasText: '节点测试科技' })).toBeVisible()
})

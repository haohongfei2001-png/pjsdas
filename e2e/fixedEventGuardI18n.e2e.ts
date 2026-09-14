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
  timingMode: 'fixed',
  estimatedMinutes: 60,
  source: 'manual',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

async function seedPastEvent(page: Page) {
  await page.evaluate(async ({ opportunity, processEvent }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 8)
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

test('past recruiting-event guard follows English UI and completion still resolves the generated action', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()
  await seedPastEvent(page)
  await page.getByRole('button', { name: 'EN' }).first().click()

  const guard = page.getByRole('alert', { name: 'Past recruiting event needs confirmation' })
  await expect(guard).toBeVisible()
  await expect(guard).toContainText('has passed')
  await expect(guard.getByRole('button', { name: 'Confirm completed' })).toBeVisible()
  await expect(guard).not.toContainText('已经过期')

  await guard.getByRole('button', { name: 'Confirm completed' }).click()
  await expect(guard).toHaveCount(0)
})

test('past recruiting-event guard stays unresolved and surfaces persistence failure', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()
  await seedPastEvent(page)

  const guard = page.getByRole('alert', { name: '过期流程节点待确认' })
  await expect(guard).toBeVisible()

  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
      const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames)
      if (mode === 'readwrite' && names.includes('changeSets')) {
        throw new DOMException('Injected fixed-event completion failure', 'QuotaExceededError')
      }
      return original.call(this, storeNames, mode, options)
    }
  })

  await guard.getByRole('button', { name: '确认已完成' }).click()

  await expect(guard).toBeVisible()
  await expect(guard.locator('.fixed-guard-error')).toContainText('Injected fixed-event completion failure')
  await expect(guard.getByRole('button', { name: '确认已完成' })).toBeEnabled()
})

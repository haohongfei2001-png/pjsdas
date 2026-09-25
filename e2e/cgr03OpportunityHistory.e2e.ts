import { expect, test } from '@playwright/test'

test('CGR-03 opportunity detail labels recent history honestly and reaches the oldest record without losing identity', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const now = Date.now()
    const opportunity = {
      id: 'cgr03-history-opportunity', company: '合成历史科技', role: '产品经理',
      currentStageLabel: '面试', processStage: 'interview', roleType: 'core',
      participationStatus: 'active', early: false, opportunityValue: 86,
      fitScore: 82, importedAt: new Date(now - 34 * 86400000).toISOString(),
    }
    const records = Array.from({length:34}, (_, index) => ({
      id:`cgr03-history-${index}`, kind:'opportunity_updated', category:'opportunity',
      source:'user_action', opportunityId:opportunity.id, company:opportunity.company,
      role:opportunity.role, title:`合成历史记录 ${index}`,
      occurredAt:new Date(now - index * 86400000).toISOString(),
      recordedAt:new Date(now - index * 86400000).toISOString(),
    }))
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['opportunities','timeline'],'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.objectStore('opportunities').put(opportunity)
        for (const record of records) tx.objectStore('timeline').put(record)
      }
    })
  })
  await page.reload()
  await page.locator('.tsui-primary-nav').getByRole('button', {name:/岗位库|Jobs/}).click()
  await page.getByRole('button', {name:/合成历史科技/}).click()
  const detail = page.locator('.job-detail-page')
  await expect(detail).toBeVisible()
  const history = detail.locator('.opportunity-detail-section').filter({has:page.locator('.opportunity-detail-timeline')})
  await expect(history.locator('summary')).toContainText(/6\/34|6 of 34/)
  await history.locator('summary').click()
  await expect(history.locator('article')).toHaveCount(6)
  await expect(history).not.toContainText('合成历史记录 33')
  await history.getByRole('button', {name:/显示更早记录|Show earlier records/}).click()
  await expect(history.locator('article')).toHaveCount(26)
  await history.getByRole('button', {name:/显示更早记录|Show earlier records/}).click()
  await expect(history.locator('article')).toHaveCount(34)
  await expect(history.locator('summary')).toContainText(/完整历史|Full history/)
  await expect(history).toContainText('合成历史记录 33')
  await expect(page).toHaveURL(/\/library\/cgr03-history-opportunity$/)
})

test('CGR-03 stale opportunity deep link explains the missing detail and returns to the list', async ({ page }) => {
  await page.goto('/')
  await page.goto(new URL('opportunities/cgr03-missing', page.url()).toString())
  const missing = page.getByRole('status').filter({ has: page.getByRole('heading', { name: /无法打开这项机会|This opportunity is unavailable/ }) })
  await expect(missing).toBeVisible()
  await missing.getByRole('button', { name: /重新读取|Retry loading/ }).click()
  await expect(missing).toBeVisible()
  await missing.getByRole('button', { name: /返回|Back/ }).click()
  await expect(page).toHaveURL(/\/library$/)
  await expect(missing).toHaveCount(0)
})

test('CGR-03 detail completion uses the shared action command and updates the persisted workspace', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const now = new Date().toISOString()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['opportunities', 'actions'], 'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.objectStore('opportunities').put({
          id: 'cgr03-complete-opportunity', company: '合成行动科技', role: '研究员',
          currentStageLabel: '面试', processStage: 'interview', roleType: 'core',
          participationStatus: 'active', early: false, opportunityValue: 80,
          fitScore: 80, importedAt: now,
        })
        tx.objectStore('actions').put({
          id: 'cgr03-complete-action', kind: 'manual', title: '准备合成面试',
          opportunityId: 'cgr03-complete-opportunity', processStage: 'interview',
          estimatedMinutes: 30, leverage: 80, delayCost: 80, status: 'todo',
          createdAt: now, updatedAt: now,
        })
      }
    })
  })
  await page.reload()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /岗位库|Jobs/ }).click()
  await page.getByRole('button', { name: /合成行动科技/ }).click()
  const detail = page.locator('.job-detail-page')
  const preparation = detail.locator('.opportunity-detail-section').filter({ has: page.locator('.opportunity-detail-action-list article', { hasText: '准备合成面试' }) })
  await preparation.getByRole('button', { name: /标记完成|Mark done/ }).click()
  await expect(page.locator('.action-undo-toast')).toContainText('准备合成面试')
  await expect(detail.locator('.opportunity-detail-action-list article', { hasText: '准备合成面试' })).toHaveCount(0)
  await expect.poll(async () => page.evaluate(async () => {
    const request = indexedDB.open('pjsdas', 11)
    return new Promise<string | undefined>((resolve, reject) => {
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('actions', 'readonly')
        const get = tx.objectStore('actions').get('cgr03-complete-action')
        get.onerror = () => reject(get.error)
        get.onsuccess = () => { db.close(); resolve(get.result?.status) }
      }
    })
  })).toBe('done')
})

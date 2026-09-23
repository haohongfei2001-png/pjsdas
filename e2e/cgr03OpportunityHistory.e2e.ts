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
  await page.locator('.surface-nav').getByRole('button', {name:/机会|Opportunities/}).click()
  await page.getByRole('button', {name:/合成历史科技/}).click()
  const detail = page.getByRole('dialog', {name:/岗位详情|Opportunity details/})
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
  await expect(page).toHaveURL(/\/opportunities\/cgr03-history-opportunity$/)
})

import { expect, test } from '@playwright/test'

test('Job discovery preferences are fully bilingual and persist through the real Settings flow', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await page.getByRole('button', { name: '设置 规则与数据' }).click()
  await page.getByRole('button', { name: 'EN' }).first().click()
  await expect(page.getByRole('heading', { name: 'Preferences, rules, sync, and data safety' })).toBeVisible()

  const card = page.locator('.discovery-profile-card')
  await expect(card.getByRole('heading', { name: 'Job discovery preferences' })).toBeVisible()
  await expect(card.getByText('Target roles / search queries', { exact: true })).toBeVisible()
  await expect(card.getByText('Preferred locations', { exact: true })).toBeVisible()
  await expect(card.getByText('Job discovery history', { exact: true })).toBeVisible()
  await expect(card.getByText(/V1\.3|ROUND 3/)).toHaveCount(0)

  const targetRoles = card.locator('.discovery-profile-grid label').filter({ hasText: 'Target roles / search queries' }).locator('textarea')
  await targetRoles.fill('AI Product Manager\nBusiness Analysis')
  await card.getByRole('button', { name: 'Save preferences' }).click()
  await expect(card.locator('.notice.success')).toContainText('Job-discovery preferences saved locally')

  const stored = await page.evaluate(async () => {
    return new Promise<string[]>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 8)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction('discoveryProfiles', 'readonly')
        const getRequest = transaction.objectStore('discoveryProfiles').get('current')
        getRequest.onerror = () => reject(getRequest.error)
        getRequest.onsuccess = () => {
          const values = getRequest.result?.targetRoleQueries ?? []
          db.close()
          resolve(values)
        }
      }
    })
  })
  expect(stored).toEqual(['AI Product Manager', 'Business Analysis'])

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Only the next moves for today' })).toBeVisible()
  await page.getByRole('button', { name: 'Settings Rules & data' }).click()
  await expect(page.getByRole('heading', { name: 'Preferences, rules, sync, and data safety' })).toBeVisible()
  await expect(page.locator('.discovery-profile-card textarea').first()).toHaveValue('AI Product Manager\nBusiness Analysis')
})

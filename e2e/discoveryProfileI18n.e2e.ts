import { expect, test } from '@playwright/test'

test('Job discovery preferences are bilingual, persist, and never show stale save success after edits', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  await page.locator('.surface-nav').getByRole('button', { name: /设置/ }).click()
  await page.locator('.surface-nav').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Connections, automation, and durable control' })).toBeVisible()
  await page.locator('details.settings-group').filter({ hasText: 'Discovery preferences' }).locator('summary').click()

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

  await targetRoles.fill('AI Product Manager\nBusiness Analysis\nStrategy')
  await expect(card.locator('.notice.success')).toHaveCount(0)
  await expect(card.locator('.notice.error')).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
  await page.locator('.surface-nav').getByRole('button', { name: /Settings/ }).click()
  await expect(page.getByRole('heading', { name: 'Connections, automation, and durable control' })).toBeVisible()
  await page.locator('details.settings-group').filter({ hasText: 'Discovery preferences' }).locator('summary').click()
  await expect(page.locator('.discovery-profile-card textarea').first()).toHaveValue('AI Product Manager\nBusiness Analysis')
})

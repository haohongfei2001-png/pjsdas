import { expect, test } from '@playwright/test'

test('shell hides stale version copy and Decide uses the actual two-tab layout', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await expect(page.getByText('Local-first · v1.8')).not.toBeVisible()
  await expect(page.locator('.sidebar-note')).toContainText('Local-first')

  await page.getByRole('button', { name: /决策/ }).click()
  await expect(page.getByRole('heading', { name: '决定哪些机会值得占用你的时间' })).toBeVisible()

  const tabs = page.locator('.surface-context-tabs button')
  await expect(tabs).toHaveCount(2)
  const first = await tabs.nth(0).boundingBox()
  const second = await tabs.nth(1).boundingBox()
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  expect(Math.abs(first!.width - second!.width)).toBeLessThan(2)
})

import { expect, test } from '@playwright/test'

test('shell hides stale version copy and Opportunities uses the decision-first two-context layout', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  await expect(page.getByText('Local-first · v1.8')).toHaveCount(0)
  await expect(page.locator('.sidebar-note')).toHaveCount(0)
  await expect(page.locator('.surface-sidebar-footer')).toContainText('Today · Opportunities')

  await page.getByRole('button', { name: /机会/ }).click()
  await expect(page.getByRole('heading', { name: '哪些在推进，哪些值得继续投入' })).toBeVisible()

  const tabs = page.locator('.surface-context-tabs button')
  await expect(tabs).toHaveCount(2)
  await expect(page.getByRole('button', { name: /推进中/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /值得推进/ })).toBeVisible()

  const first = await tabs.nth(0).boundingBox()
  const second = await tabs.nth(1).boundingBox()
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  expect(Math.abs(first!.width - second!.width)).toBeLessThan(2)

  await page.locator('.ultimate-toolbar').getByRole('button', { name: /设置/ }).click()
  await expect(page.getByRole('heading', { name: '连接、自动化和长期控制' })).toBeVisible()
  await expect(page.getByText('PJSDAS ACCOUNT & DRIVE', { exact: true })).toBeVisible()
  await expect(page.getByText(/V1\.9/)).toHaveCount(0)
})

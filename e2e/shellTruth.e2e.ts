import { expect, test } from '@playwright/test'

test('shell hides stale version copy and Opportunities uses the three-context layout', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await expect(page.getByText('Local-first · v1.8')).not.toBeVisible()
  await expect(page.locator('.sidebar-note')).toContainText('Local-first')

  await page.getByRole('button', { name: /机会/ }).click()
  await expect(page.getByRole('heading', { name: '机会、流程和准备在同一个工作面' })).toBeVisible()

  const tabs = page.locator('.surface-context-tabs button')
  await expect(tabs).toHaveCount(3)
  const first = await tabs.nth(0).boundingBox()
  const second = await tabs.nth(1).boundingBox()
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  expect(Math.abs(first!.width - second!.width)).toBeLessThan(2)

  await page.getByRole('button', { name: /设置/ }).click()
  await expect(page.getByRole('heading', { name: '连接、自动化和长期控制' })).toBeVisible()
  await expect(page.getByText('PJSDAS ACCOUNT & DRIVE', { exact: true })).toBeVisible()
  await expect(page.getByText(/V1\.9/)).toHaveCount(0)
})

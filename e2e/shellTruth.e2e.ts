import { expect, test } from '@playwright/test'

test('shell hides stale version copy and Opportunities uses the decision-first layout with contextual Discovery Inbox', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  await expect(page.getByText('Local-first · v1.8')).toHaveCount(0)
  await expect(page.locator('.sidebar-note')).toHaveCount(0)
  await expect(page.locator('.tsui-primary-nav button')).toHaveCount(3)

  await page.getByRole('button', { name: /岗位库/ }).click()
  await expect(page.getByRole('heading', { name: '哪些在推进，哪些值得继续投入' })).toBeVisible()

  const tabs = page.locator('.surface-context-tabs button')
  await expect(tabs).toHaveCount(3)
  await expect(page.getByRole('button', { name: /推进中/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /值得推进/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /发现箱/ })).toBeVisible()

  const first = await tabs.nth(0).boundingBox()
  const second = await tabs.nth(1).boundingBox()
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  expect(Math.abs(first!.width - second!.width)).toBeLessThan(2)

  await page.locator('.tsui-topbar').getByRole('button', { name: /设置/ }).click()
  await expect(page.getByRole('heading', { name: '连接、自动化和长期控制' })).toBeVisible()
  await expect(page.getByText('ACCOUNT & CONNECTION', { exact: true })).toBeVisible()
  await expect(page.locator('.cloud-connection-impact')).toContainText('其他设备看不到这些修改')
  await expect(page.locator('.cloud-settings-card').filter({ has: page.locator('.cloud-connection-impact') })).not.toContainText(/Controlled production|Legacy access mode|Local IndexedDB|Connected revision/)
  await expect(page.getByText(/V1\.9/)).toHaveCount(0)
})

import { expect, test } from '@playwright/test'

test('shell hides stale version copy and Jobs uses the approved library with secondary destinations', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  await expect(page.getByText('Local-first · v1.8')).toHaveCount(0)
  await expect(page.locator('.sidebar-note')).toHaveCount(0)
  await expect(page.locator('.tsui-primary-nav button')).toHaveCount(3)

  await page.getByRole('button', { name: /岗位库/ }).click()
  await expect(page.getByRole('heading', { name: '岗位库' })).toBeVisible()
  const filters = page.locator('.tsui-library-filters button')
  await expect(filters).toHaveCount(4)
  await expect(page.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: '待投递' })).toBeVisible()
  await expect(page.getByRole('button', { name: '推进中' })).toBeVisible()
  await expect(page.getByRole('button', { name: '已结束' })).toBeVisible()
  await expect(page.locator('.tsui-library-secondary').getByRole('button', { name: /发现箱/ })).toBeVisible()
  await expect(page.locator('.tsui-library-secondary').getByRole('button', { name: /准备资产/ })).toBeVisible()
  const first = await filters.nth(0).boundingBox()
  const second = await filters.nth(1).boundingBox()
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  expect(first!.height).toBeGreaterThanOrEqual(44)
  expect(second!.height).toBeGreaterThanOrEqual(44)

  await page.locator('.tsui-topbar').getByRole('button', { name: /设置/ }).click()
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()
  await expect(page.getByText('ACCOUNT & CONNECTION', { exact: true })).toBeVisible()
  await expect(page.locator('.cloud-connection-impact')).toContainText('其他设备看不到这些修改')
  await expect(page.locator('.cloud-settings-card').filter({ has: page.locator('.cloud-connection-impact') })).not.toContainText(/Controlled production|Legacy access mode|Local IndexedDB|Connected revision/)
  await expect(page.getByText(/V1\.9/)).toHaveCount(0)
})

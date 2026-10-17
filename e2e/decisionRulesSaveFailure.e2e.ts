import { expect, test } from '@playwright/test'

test('retired Decision Rules exposes no editor or save action', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
  await page.locator('.tsui-topbar').getByRole('button', { name: /设置/ }).click()
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
  await expect(page.locator('details.settings-group > summary').filter({ hasText: '决策规则' })).toHaveCount(0)
  await expect(page.locator('.rules-page, .rules-grid, .rule-field')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '保存规则' })).toHaveCount(0)
  await expect(page.locator('details.settings-group > summary').filter({ hasText: '岗位发现偏好' })).toHaveCount(0)
  await page.goto('/pjsdas/library')
  await page.getByRole('button', { name: '搜索范围', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '每天帮你找新岗位' })).toBeVisible()
  await expect(page.getByText('最低匹配度（0–100，可空）', { exact: true })).toHaveCount(0)
  await expect(page.getByText('最低机会价值（0–100，可空）', { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.rules-page, .rules-grid, .rule-field')).toHaveCount(0)
})

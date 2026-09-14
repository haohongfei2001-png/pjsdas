import { expect, test } from '@playwright/test'

test('Decision Rules uses durable product terminology instead of a development-version label', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await page.getByRole('button', { name: '设置 规则与数据' }).click()
  const rules = page.locator('.rules-page')
  await expect(rules.getByRole('heading', { name: '决策规则' })).toBeVisible()
  await expect(rules.getByText('DECISION POLICY', { exact: true })).toBeVisible()
  await expect(rules.getByText(/V1\.6/)).toHaveCount(0)

  await page.getByRole('button', { name: 'EN' }).first().click()
  await expect(rules.getByRole('heading', { name: 'Decision Rules' })).toBeVisible()
  await expect(rules.getByText('DECISION POLICY', { exact: true })).toBeVisible()
})

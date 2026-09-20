import { expect, test } from '@playwright/test'

test('Decision Rules uses durable product terminology instead of a development-version label', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  await page.locator('.surface-nav').getByRole('button', { name: /设置/ }).click()
  await page.locator('details.settings-group > summary').filter({ hasText: '决策规则' }).click()
  const rules = page.locator('.rules-page')
  await expect(rules.getByRole('heading', { name: '决策规则' })).toBeVisible()
  await expect(rules.getByText('DECISION POLICY', { exact: true })).toBeVisible()
  await expect(rules.getByText(/V1\.6/)).toHaveCount(0)

  await page.locator('.surface-nav').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await expect(rules.getByRole('heading', { name: 'Decision Rules' })).toBeVisible()
  await expect(rules.getByText('DECISION POLICY', { exact: true })).toBeVisible()
})

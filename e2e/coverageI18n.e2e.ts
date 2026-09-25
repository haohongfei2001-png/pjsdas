import { expect, test } from '@playwright/test'

test('routine coverage does not occupy Today in either interface language', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.cgr-coverage-details')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'View ingestion coverage and workspace health' })).toHaveCount(0)

  await page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /Today/ }).click()

  await expect(page.locator('.cgr-coverage-details')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
})

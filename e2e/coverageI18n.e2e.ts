import { expect, test } from '@playwright/test'

test('material coverage follows the global English language inside Today instead of a daily health popup', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.cgr-coverage-details > summary')).toContainText('数据覆盖提示')
  await expect(page.getByRole('button', { name: 'View ingestion coverage and workspace health' })).toHaveCount(0)

  await page.locator('.ultimate-toolbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.surface-nav').getByRole('button', { name: /Today/ }).click()

  const coverage = page.locator('.cgr-coverage-details')
  await expect(coverage.locator('summary')).toContainText('Coverage notes')
  await coverage.locator('summary').click()
  await expect(coverage).toContainText('Some automated sources have no completed coverage record.')
  await expect(page.getByText('数据覆盖提示', { exact: false })).toHaveCount(0)
})

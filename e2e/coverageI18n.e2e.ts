import { expect, test } from '@playwright/test'

test('Coverage and Integrity surface follows the global English interface language', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  await page.locator('.ultimate-toolbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')

  const healthButton = page.getByRole('button', { name: 'View ingestion coverage and workspace health' })
  await expect(healthButton).toBeVisible()
  await healthButton.click()

  const dialog = page.getByRole('dialog', { name: 'Ingestion coverage and workspace health' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Source coverage', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Received / accounted', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Workspace health', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible()

  await expect(dialog.getByText('来源覆盖', { exact: true })).toHaveCount(0)
  await expect(dialog.getByText('工作区健康', { exact: true })).toHaveCount(0)
})

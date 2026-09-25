import { expect, test } from '@playwright/test'

test('local backup follows the interface language and states the sync boundary accurately', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  await page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  await page.locator('.tsui-topbar').getByRole('button', { name: /Settings/ }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page.locator('details.settings-group').filter({ hasText: 'Data & recovery' }).locator('summary').click()
  await page.getByRole('button', { name: 'Local backup' }).click()
  await expect(page.getByRole('heading', { name: 'Backup & restore' })).toBeVisible()
  await expect(page.getByText(/never uploaded to GitHub/)).toBeVisible()
  await expect(page.getByText(/conflict protection/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export JSON backup' })).toBeVisible()
  await expect(page.getByText('Choose backup file')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible()
})

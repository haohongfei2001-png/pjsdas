import { expect, test } from '@playwright/test'

test('History uses release-neutral audit copy in both interface languages', async ({ page }) => {
  await page.goto('/')
  await page.locator('.tsui-topbar').getByRole('button', { name: /设置/ }).click()
  const historyGroup = page.locator('details.settings-group').filter({ hasText: '历史与审计' })
  await historyGroup.locator('summary').click()
  await historyGroup.getByRole('button', { name: '查看活动记录' }).click()
  await expect(page.getByRole('heading', { name: '历史与审计' })).toBeVisible()
  await expect(page.getByText('HISTORY', { exact: true })).toBeVisible()
  await expect(page.getByText(/V0\.9/)).toHaveCount(0)

  await page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
  const englishHistoryGroup = page.locator('details.settings-group').filter({ hasText: 'History & audit' })
  await englishHistoryGroup.locator('summary').click()
  await englishHistoryGroup.getByRole('button', { name: 'Open activity history' }).click()
  await expect(page.getByRole('heading', { name: 'History & audit' })).toBeVisible()
  await expect(page.getByText('HISTORY', { exact: true })).toBeVisible()
})

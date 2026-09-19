import { expect, test } from '@playwright/test'

test('Activity uses release-neutral product copy in both interface languages', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await page.locator('.surface-nav').getByRole('button', { name: /活动/ }).click()
  await expect(page.getByRole('heading', { name: '系统和你都做了什么' })).toBeVisible()
  await expect(page.getByText('ACTIVITY', { exact: true })).toBeVisible()
  await expect(page.getByText(/V0\.9/)).toHaveCount(0)

  await page.getByRole('button', { name: 'EN', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'What you and PJSDAS have done' })).toBeVisible()
  await expect(page.getByText('ACTIVITY', { exact: true })).toBeVisible()
  await expect(page.getByText(/V0\.9/)).toHaveCount(0)
})

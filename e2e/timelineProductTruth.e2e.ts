import { expect, test } from '@playwright/test'

test('Timeline uses release-neutral product copy in both interface languages', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await page.getByRole('button', { name: '历程 发生了什么' }).click()
  await expect(page.getByRole('heading', { name: '求职历程' })).toBeVisible()
  await expect(page.getByText('TIMELINE', { exact: true })).toBeVisible()
  await expect(page.getByText(/V0\.9/)).toHaveCount(0)

  await page.getByRole('button', { name: 'EN' }).first().click()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  await expect(page.getByText('TIMELINE', { exact: true })).toBeVisible()
  await expect(page.getByText(/V0\.9/)).toHaveCount(0)
})

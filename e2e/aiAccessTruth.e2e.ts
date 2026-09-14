import { expect, test } from '@playwright/test'

test('AI Access settings describe current read-only and ChangeSet semantics without release/provider drift', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await page.getByRole('button', { name: '设置 规则与数据' }).click()
  await page.getByRole('button', { name: 'EN' }).first().click()

  const card = page.locator('.cloud-settings-card').filter({ hasText: 'CHATGPT · AI ACCESS' })
  await expect(card).toBeVisible()
  await expect(card.getByRole('heading', { name: 'Enable read-only PJSDAS data for ChatGPT' })).toBeVisible()
  await expect(card).toContainText('Direct AI access remains read-only')
  await expect(card).toContainText('reviewable ChangeSet')
  await expect(card).toContainText('PJSDAS backend')
  await expect(card.getByText(/V1\.1|Vercel/)).toHaveCount(0)
})

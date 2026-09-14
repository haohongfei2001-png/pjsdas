import { expect, test } from '@playwright/test'

test('AI Access settings disclose bounded trusted ingestion and ChangeSet guardrails without release/provider drift', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await page.getByRole('button', { name: '设置 规则与数据' }).click()
  await page.getByRole('button', { name: 'EN' }).first().click()

  const card = page.locator('.cloud-settings-card').filter({ hasText: 'CHATGPT · AI ACCESS' })
  await expect(card).toBeVisible()
  await expect(card.getByRole('heading', { name: 'Enable PJSDAS AI access for ChatGPT' })).toBeVisible()
  await expect(card).toContainText('trusted Monitor/Gmail ingestion')
  await expect(card).toContainText('bounded source-backed facts')
  await expect(card).toContainText('reviewable ChangeSet')
  await expect(card).toContainText('PJSDAS backend')
  await expect(card).not.toContainText('Direct AI access remains read-only')
  await expect(card.getByText(/V1\.1|Vercel/)).toHaveCount(0)
})

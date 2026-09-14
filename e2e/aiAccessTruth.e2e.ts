import { expect, test } from '@playwright/test'

test('AI Access settings disclose bounded trusted automation and user-controlled discovery consent', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await page.getByRole('button', { name: '设置 规则与数据' }).click()
  await page.getByRole('button', { name: 'EN' }).first().click()

  const card = page.locator('.cloud-settings-card').filter({ hasText: 'CHATGPT · AI ACCESS' })
  await expect(card).toBeVisible()
  await expect(card.getByRole('heading', { name: 'Connect PJSDAS AI and background automation' })).toBeVisible()
  await expect(card).toContainText('trusted Monitor/Gmail ingestion')
  await expect(card).toContainText('bounded source-backed facts')
  await expect(card).toContainText('reviewable ChangeSet')

  await expect(card).toContainText('Background job discovery')
  await expect(card).toContainText('Discovery Profile')
  await expect(card).toContainText('Only bounded job-discovery context is sent to the search model')
  await expect(card).toContainText('not the full Drive workspace, Gmail bodies, or unrelated personal data')
  await expect(card).toContainText('Disabling this stops background public-web search')
  await expect(card.getByRole('button', { name: 'Enable discovery' })).toBeVisible()

  await expect(card).toContainText('Automatic recruiting-email tracking')
  await expect(card).toContainText('Gmail read-only access')
  await expect(card).toContainText('Raw email bodies are never persisted in PJSDAS')
  await expect(card).toContainText('ambiguous messages remain unresolved')
  await expect(card.getByRole('button', { name: 'Authorize Gmail and enable' })).toBeVisible()
  await expect(card).toContainText('PJSDAS backend')
  await expect(card).not.toContainText('Direct AI access remains read-only')
  await expect(card.getByText(/V1\.1|Vercel/)).toHaveCount(0)
})

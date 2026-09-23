import { expect, test } from '@playwright/test'

test('AI Access settings disclose bounded trusted automation and user-controlled discovery consent', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

  await page.locator('.ultimate-toolbar').getByRole('button', { name: /设置/ }).click()
  await page.locator('.ultimate-toolbar').getByRole('button', { name: /设置|Settings/ }).click()
  const interfaceGroup = page.locator('details.settings-group > summary').filter({ hasText: /界面.*显示层|Interface.*Presentation/ }).locator('..')
  await interfaceGroup.locator('summary').click()
  await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()

  const card = page.locator('.cloud-settings-card').filter({ hasText: 'BACKGROUND SOURCES' })
  await expect(card).toBeVisible()
  await expect(card.getByRole('heading', { name: 'Background sources and AI connection' })).toBeVisible()
  await expect(card).toContainText('trusted discovery or recruiting-email intake may add only bounded, source-backed facts')
  await expect(card).toContainText('changes to durable preferences, rejection decisions, or deletions still require your review')
  await expect(card).toContainText('app-specific Google Drive files, not your normal Drive files')

  await expect(card).toContainText('Background job discovery')
  await expect(card).toContainText('using your preferences and decision rules, without adding duplicates')
  await expect(card).toContainText('The search model receives only bounded discovery criteria')
  await expect(card).toContainText('never your full workspace, Gmail bodies, or unrelated personal data')
  await expect(card).toContainText('Turning this off stops background public-web search')
  await expect(card.getByRole('button', { name: 'Enable discovery' })).toBeVisible()

  await expect(card).toContainText('Automatic recruiting-email tracking')
  await expect(card).toContainText('Gmail read-only access')
  await expect(card).toContainText('Raw email bodies are never persisted in PJSDAS')
  await expect(card).toContainText('ambiguous messages remain unresolved')
  await expect(card.getByRole('button', { name: 'Authorize Gmail and enable' })).toBeVisible()
  await expect(card).toContainText('Long-lived Google authorization is encrypted')
  await expect(card).toContainText('checked for source, identity, duplicates, and conflicts')
  await expect(card).not.toContainText('ingestion ledger')
  await expect(card).not.toContainText('Direct AI access remains read-only')
  await expect(card.getByText(/V1\.1|Vercel/)).toHaveCount(0)
})

import { expect, test } from '@playwright/test'
import { prepareJourney } from './support/cgr02Journey.js'

test('CGR-02 rollback keeps authoritative Today readable and prevents its capture/write path', async ({ page }) => {
  const server = await prepareJourney(page)
  await page.goto('/pjsdas/today/capture')
  await expect(page).toHaveURL(/\/pjsdas\/today$/)
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  const rollbackNotice = page.getByRole('alert').filter({ hasText: '今天暂时只读' })
  await expect(rollbackNotice).toBeVisible()
  await expect(rollbackNotice).toContainText('已有记录和回执保留')
  await expect(page.locator('.tsui-tell-button')).toBeDisabled()
  const task = page.locator('.tsui-task-row').filter({ has: page.getByRole('heading', { name: 'A第一任务' }) })
  await expect(task.locator('.tsui-row-action')).toBeDisabled()
  await expect(task.locator('.tsui-done-action')).toBeDisabled()
  await expect(page.getByRole('button', { name: '确认并保存' })).toHaveCount(0)
  await page.keyboard.press('Meta+k')
  await expect(page).toHaveURL(/\/pjsdas\/today$/)
  expect(server.commandCount()).toBe(0)
})

import { expect, test } from '@playwright/test'

test('Decision Rules save failure stays visible and never leaves a stale success state', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await page.locator('.surface-nav').getByRole('button', { name: /设置/ }).click()
  await page.locator('details.settings-group').filter({ hasText: '决策规则' }).locator('summary').click()
  await expect(page.getByRole('heading', { name: '决策规则' })).toBeVisible()

  const hardDeadlineField = page.locator('.rule-field').filter({ hasText: '硬截止保护窗口' }).getByRole('spinbutton')
  const originalValue = Number(await hardDeadlineField.inputValue())
  await hardDeadlineField.fill(String(originalValue + 1))
  await expect(page.getByText('有未保存修改')).toBeVisible()

  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
      const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames)
      if (mode === 'readwrite' && names.includes('changeSets')) {
        throw new DOMException('Injected Decision Rules save failure', 'QuotaExceededError')
      }
      return original.call(this, storeNames, mode, options)
    }
  })

  await page.getByRole('button', { name: '保存规则' }).click()

  await expect(page.getByRole('alert')).toContainText('Injected Decision Rules save failure')
  await expect(page.locator('.rules-message')).toHaveCount(0)
  await expect(page.getByText('有未保存修改')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存规则' })).toBeEnabled()
  await expect(hardDeadlineField).toHaveValue(String(originalValue + 1))
})

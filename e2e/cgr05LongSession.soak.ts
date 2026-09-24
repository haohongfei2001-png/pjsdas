import { expect, test } from '@playwright/test'
import { prepareJourney } from './support/cgr02Journey.js'

// This suite is only selected by playwright.soak.config.mts. The certification
// workflow fixes the duration at two real hours; a short local run is a smoke
// check and must never be cited as the CGR-05 long-session gate.
const durationMinutes = Number(process.env.PJSDAS_SOAK_MINUTES ?? 120)
const intervalMs = durationMinutes < 5 ? 5_000 : 5 * 60_000
const durationMs = durationMinutes * 60_000

test('CGR-05 connected Today survives a real multi-hour browser session', async ({ page }) => {
  expect(Number.isFinite(durationMinutes) && durationMinutes > 0).toBe(true)
  test.setTimeout(durationMs + 5 * 60_000)
  const server = await prepareJourney(page)
  const started = performance.now()
  let checks = 0
  let captured = false

  while (performance.now() - started < durationMs) {
    await page.goto('/pjsdas/today')
    await expect(page.getByRole('heading', { name: captured ? '整理面试材料' : 'A第一任务' })).toBeVisible()

    if (!captured && performance.now() - started >= durationMs / 2) {
      await page.locator('.cgr-global-capture').click()
      const dialog = page.getByRole('dialog', { name: '告诉 PJSDAS' })
      await dialog.getByRole('textbox', { name: '要告诉 PJSDAS 的内容' }).fill('事项：整理面试材料')
      await expect(dialog.getByText(/新增行动 · 整理面试材料/)).toBeVisible()
      await dialog.getByRole('button', { name: '确认并保存' }).click()
      await expect(dialog.getByRole('status')).toContainText('已记录：整理面试材料')
      await dialog.getByRole('button', { name: '关闭' }).click()
      await expect(dialog).toBeHidden()
      captured = true
    }

    if (captured) {
      await expect(page.getByText('整理面试材料').first()).toBeVisible()
      expect(server.commandCount()).toBe(1)
    }

    await page.locator('.surface-nav').getByRole('button', { name: /机会|Opportunities/ }).click()
    await expect(page).toHaveURL(/\/pjsdas\/opportunities/)
    await page.locator('.surface-nav').getByRole('button', { name: /今天|Today/ }).click()
    await expect(page.getByRole('heading', { name: captured ? '整理面试材料' : 'A第一任务' })).toBeVisible()
    checks += 1

    const remainingMs = durationMs - (performance.now() - started)
    if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)))
  }

  await page.reload()
  await expect(page.getByRole('heading', { name: '整理面试材料' })).toBeVisible()
  await expect(page.getByText('整理面试材料').first()).toBeVisible()
  expect(server.commandCount()).toBe(1)
  expect(captured).toBe(true)
  expect(checks).toBeGreaterThanOrEqual(durationMinutes < 5 ? 1 : 20)
  expect(performance.now() - started).toBeGreaterThanOrEqual(durationMs)
  console.info(`CGR-05 long-session evidence: ${Math.round((performance.now() - started) / 1000)} wall-clock seconds, ${checks} navigation/read checks, one committed capture.`)
})

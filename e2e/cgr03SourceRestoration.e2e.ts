import { expect, test } from '@playwright/test'
import { prepareJourney } from './support/cgr02Journey.js'

test('CGR-03 broken Gmail source explains stale data and offers explicit read-only reauthorization', async ({ page }, testInfo) => {
  await prepareJourney(page)
  await page.route('**/api/automation-settings', (route) => route.fulfill({
    status: 200,
    headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({
      googleEmail: 'synthetic@example.invalid', gmailScopeGranted: true, gmailEnabled: true,
      gmailHistoryIdPresent: true, gmailLastCheckedAt: '2026-09-23T10:00:00.000Z',
      gmailLastSuccessAt: '2026-09-23T09:00:00.000Z', gmailLastError: 'SYNTHETIC_AUTH_EXPIRED',
      discoveryEnabled: false, discoveryLastError: null,
    }),
  }))
  let authorizationUrl = ''
  await page.route('**/auth/v1/authorize**', (route) => {
    authorizationUrl = route.request().url()
    return route.fulfill({ status: 200, contentType: 'text/plain', body: 'Synthetic consent boundary reached.' })
  })

  await page.goto('/pjsdas/settings')
  const card = page.locator('.cloud-settings-card').filter({ hasText: 'BACKGROUND SOURCES' })
  await expect(card.getByText('新邮件进展可能未同步')).toBeVisible()
  await expect(card).toContainText('最近一次邮件检查失败，已有资料仍可查看')
  await expect(card).toContainText('重新授权会再次请求上方说明的 90 天 Gmail 只读范围')
  await expect(card.getByRole('button', { name: '查看并重新授权 Gmail' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('cgr03-settings-degraded-source.png'), fullPage: true })
  await card.getByRole('button', { name: '查看并重新授权 Gmail' }).click()
  await expect.poll(() => authorizationUrl).toContain('/auth/v1/authorize')
  expect(new URL(authorizationUrl).searchParams.get('scopes')).toContain('gmail.readonly')
})

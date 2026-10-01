import { expect, test } from '@playwright/test'
import { BACKEND, cors, health, seedSession, workspace } from './fixtures/todayWorkspace.js'

const now = '2026-10-02T02:00:00.000Z'
for (const state of ['enabled', 'partial', 'error', 'disabled'] as const) {
  for (const width of [1440, 390, 320]) test(`settings hierarchy ${state} at ${width}`, async ({ page }, info) => {
    await seedSession(page.context())
    await page.clock.setFixedTime(new Date(now))
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
    const snapshot = workspace()
    const calls: unknown[] = []
    await page.route(/https:\/\/[^/]+\.supabase\.co\//, route => route.abort())
    await page.route(BACKEND + '/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (request.method() === 'OPTIONS') return cors(route, {}, 204)
      if (path === '/api/health') return cors(route, health())
      if (path === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: 'synthetic@example.test' })
      if (path === '/api/automation-settings') {
        const body = request.postDataJSON()
        if (body.action !== 'read') { calls.push(body); return cors(route, { message: 'SYNTHETIC_ACTION_FAILURE' }, 503) }
        return cors(route, { googleEmail: state === 'disabled' ? null : 'synthetic-long-workspace-identity@example.test', gmailScopeGranted: state !== 'disabled', gmailEnabled: state === 'enabled' || state === 'error', discoveryEnabled: state !== 'disabled', gmailLastSuccessAt: state === 'disabled' ? null : now, discoveryLastSuccessAt: null, gmailLastError: state === 'error' ? 'SYNTHETIC_AUTH_EXPIRED' : null, discoveryLastError: state === 'error' ? 'SYNTHETIC_DISCOVERY_TIMEOUT' : null })
      }
      if (path === '/api/workspace' && request.postDataJSON().action === 'read') return cors(route, { workspaceId: 'ws-a', revision: 91, workspaceVersion: 'txn:91', schemaVersion: snapshot.version, snapshot })
      calls.push(path); return cors(route, { code: 'UNEXPECTED' }, 409)
    })
    await page.goto('/pjsdas/settings')
    await expect(page.getByRole('heading', { name: '账号与跨设备数据', exact: true })).toBeVisible()
    for (const label of ['后台工作区连接', '后台岗位发现', '招聘邮件自动跟踪']) await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible()
    if (width === 320) await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    const gmail = page.locator('section[aria-labelledby="settings-gmail-heading"]')
    const discovery = page.locator('section[aria-labelledby="settings-discovery-heading"]')
    if (state === 'error') {
      await expect(gmail.getByText('新邮件进展可能未同步')).toBeVisible()
      await expect(discovery.getByText('新岗位可能延迟出现')).toBeVisible()
      await expect(gmail.locator('.settings-permission')).toContainText('最近90天')
      await expect(gmail.getByRole('button', { name: '查看并重新授权 Gmail' })).toBeVisible()
    }
    if (state === 'disabled' || state === 'partial') await expect(gmail.locator('.settings-permission')).toContainText('不发送或修改邮件')
    if (state === 'disabled') await expect(discovery.locator('.settings-permission')).toContainText('不会收到完整工作区')
    for (const control of await page.getByRole('button', { name: /关闭自动跟踪|关闭后台发现/ }).all()) {
      await expect(control).toHaveClass('settings-quiet-button')
      expect(await control.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)')
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `settings-hierarchy-evidence/${state}-${width}.png`, fullPage: true })
    await info.attach('settings-hierarchy', { path: `settings-hierarchy-evidence/${state}-${width}.png`, contentType: 'image/png' })
    expect(calls).toEqual([])
    if (state === 'enabled' && width === 390) {
      await gmail.getByRole('button', { name: '关闭自动跟踪' }).click()
      await expect(gmail.getByRole('alert')).toHaveText('SYNTHETIC_ACTION_FAILURE')
      await expect(gmail.locator('.cloud-state')).toHaveText('已启用')
      await expect(discovery.getByRole('alert')).toHaveCount(0)
      expect(calls).toEqual([{ gmailEnabled: false }])
    }
  })
}

test('Today hides only a repeated application identity and retains job access and other context', async ({ page }, info) => {
  await seedSession(page.context())
  const snapshot = workspace()
  snapshot.data.actions[0] = { ...snapshot.data.actions[0]!, kind: 'apply', title: '投递 A公司｜产品经理' }
  snapshot.data.timePlanning = { version: 1, defaultDailyMinutes: 480, updatedAt: now }
  await page.route(/https:\/\/[^/]+\.supabase\.co\//, route => route.abort())
  await page.route(BACKEND + '/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (path === '/api/health') return cors(route, health())
    if (path === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner' })
    if (path === '/api/workspace' && request.postDataJSON().action === 'read') return cors(route, { workspaceId: 'ws-a', revision: 91, workspaceVersion: 'txn:91', schemaVersion: snapshot.version, snapshot })
    return cors(route, {}, 404)
  })
  await page.goto('/pjsdas/today')
  const row = page.locator('[data-action-id="A-action-1"]')
  await expect(row.getByRole('heading', { name: '投递 A公司｜产品经理' })).toBeVisible()
  await expect(row.locator('.tsui-task-context')).toHaveCount(0)
  await expect(row.getByRole('button', { name: '查看岗位' })).toBeVisible()
  await expect(row.getByRole('button', { name: '我已投递' })).toBeVisible()
  await expect(page.locator('[data-action-id="A-action-2"] .tsui-task-context')).toHaveText('第二公司 · 策略产品')
  await page.screenshot({ path: info.outputPath('today-application-context.png'), fullPage: true })
  await row.getByRole('button', { name: '查看岗位' }).click()
  await expect(page.locator('.job-detail-page h1')).toContainText('产品经理')
})

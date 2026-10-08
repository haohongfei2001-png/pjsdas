import { MOCK_TARGET_AUTH_ORIGIN } from './support/mockCloudTargets.js'
import { expect, test } from '@playwright/test'
import { BACKEND, cors, health, seedSession, workspace } from './fixtures/todayWorkspace.js'

for (const state of ['connected', 'unverified', 'missing', 'expired', 'gmail_scope', 'configuration'] as const) {
  test(`one account connection: ${state}`, async ({ page }) => {
    await seedSession(page.context())
    const writes: unknown[] = []
    const oauth: string[] = []
    let verified = state !== 'unverified'
    let statusReads = 0
    const snapshot = workspace()
    await page.route(`${MOCK_TARGET_AUTH_ORIGIN}/**`, route => {
      if (route.request().url().includes('/authorize')) oauth.push(route.request().url())
      return route.abort()
    })
    await page.route(BACKEND + '/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (request.method() === 'OPTIONS') return cors(route, {}, 204)
      if (path === '/api/health') return cors(route, health())
      if (path === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner' })
      if (path === '/api/automation-settings' && request.postDataJSON().action === 'read') {
        statusReads++
        if (!verified) return cors(route, { message: 'SYNTHETIC_STATUS_UNAVAILABLE' }, 503)
        return cors(route, {
          googleEmail: state === 'missing' ? null : 'synthetic@example.test',
          gmailScopeGranted: state !== 'gmail_scope', gmailEnabled: false, discoveryEnabled: false,
          gmailLastError: state === 'expired' ? 'GOOGLE_AUTH_EXPIRED: Synthetic revoked authorization'
            : state === 'gmail_scope' ? 'GOOGLE_GMAIL_SCOPE_MISSING: Synthetic missing Gmail scope'
              : state === 'configuration' ? 'GOOGLE_AUTH_CONFIG_INVALID: Synthetic configuration issue' : null,
        })
      }
      if (path === '/api/workspace' && request.postDataJSON().action === 'read') return cors(route, { workspaceId: 'ws-a', revision: 91, workspaceVersion: 'txn:91', schemaVersion: snapshot.version, snapshot })
      writes.push({ path, body: request.postData() }); return cors(route, {}, 409)
    })
    await page.goto('/pjsdas/settings')
    const account = page.getByRole('region', { name: '账号与跨设备数据', exact: true })
    await expect(account).toBeVisible()
    await expect(page.getByRole('heading', { name: '后台工作区连接', exact: true })).toHaveCount(0)
    const status = account.locator('.cloud-state')
    if (state === 'unverified') {
      await expect(status).toHaveText('连接待核对')
      await expect(account.getByRole('alert')).toContainText('Google 连接状态暂时无法核对')
      await account.getByText('错误详情', { exact: true }).click()
      await expect(account.getByText('SYNTHETIC_STATUS_UNAVAILABLE', { exact: true })).toBeVisible()
      verified = true
      const before = statusReads
      await account.getByRole('button', { name: '重新核对连接' }).click()
      await expect.poll(() => statusReads).toBeGreaterThan(before)
      await expect(status).toHaveText('同步正常')
      await expect(account.getByRole('alert')).toHaveCount(0)
    } else if (state === 'missing' || state === 'expired') {
      await expect(status).toHaveText(state === 'missing' ? '需连接 Google' : '需重新连接 Google')
      await expect(account.getByRole('button', { name: /^(连接 Google|重新连接 Google)$/ })).toBeHidden()
      await account.getByRole('button', { name: '查看连接修复' }).click()
      await expect(account.getByRole('button', { name: /^(连接 Google|重新连接 Google)$/ })).toBeVisible()
      await account.getByLabel('管理账号与同步', { exact: true }).click()
    } else if (state === 'configuration') {
      await expect(status).toHaveText('连接需要维护')
      await expect(account.getByRole('button', { name: '查看连接修复' })).toHaveCount(0)
    } else await expect(status).toHaveText('同步正常')
    await account.getByLabel('管理账号与同步', { exact: true }).click()
    await expect(account.getByText(/长期授权信息会加密保存/)).toBeVisible()
    await account.getByText('后台更新与授权范围', { exact: true }).click()
    await expect(account.getByText(/修改长期偏好、拒绝决定或删除资料仍需你审阅确认/)).toBeVisible()
    await expect(account.getByText(/每项来源都能单独关闭/)).toBeVisible()
    // Repeated disclosure interactions and navigation must not start OAuth or alter consent.
    await account.getByLabel('管理账号与同步', { exact: true }).click()
    await account.getByLabel('管理账号与同步', { exact: true }).click()
    await account.getByLabel('管理账号与同步', { exact: true }).click()
    const gmail = page.locator('section[aria-labelledby="settings-gmail-heading"]')
    const discovery = page.locator('section[aria-labelledby="settings-discovery-heading"]')
    await expect(gmail.locator('.cloud-state')).toHaveText(state === 'expired' || state === 'gmail_scope' ? '需要重新连接 Google' : state === 'configuration' ? '授权配置需要维护' : '未启用')
    await expect(discovery.locator('.cloud-state')).toHaveText('未启用')
    await page.getByRole('button', { name: '今天', exact: true }).click()
    await page.goBack()
    await expect(account).toBeVisible()
    expect(oauth).toEqual([])
    expect(writes).toEqual([])
  })
}

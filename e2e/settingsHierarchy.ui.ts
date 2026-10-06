import { expect, test } from '@playwright/test'
import { createIngestionLedgerTimeline } from '../src/ingestion.js'
import { BACKEND, cors, health, seedSession, workspace } from './fixtures/todayWorkspace.js'

const now = '2026-10-02T02:00:00.000Z'
for (const state of ['enabled', 'pending', 'partial', 'error', 'transient', 'configuration', 'disabled', 'unverified'] as const) {
  for (const width of [1440, 390, 320]) test(`settings hierarchy ${state} at ${width}`, async ({ page }, info) => {
    await seedSession(page.context())
    await page.clock.setFixedTime(new Date(now))
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
    const snapshot = workspace()
    if (state === 'unverified') snapshot.data.timeline = [createIngestionLedgerTimeline({
      sourceKind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: 'synthetic-historical-mail',
      runId: 'synthetic-historical-run', recordType: 'recruiting_message', outcome: 'unresolved',
      fingerprint: 'synthetic-fingerprint', receivedAt: now, accountedAt: now,
    })]
    if (state === 'pending') snapshot.data.timeline = Array.from({ length: 84 }, (_, index) => createIngestionLedgerTimeline({
      sourceKind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: `synthetic-review-${index}`,
      runId: 'synthetic-review-run', recordType: 'recruiting_message', outcome: 'unresolved',
      fingerprint: `synthetic-review-${index}`, receivedAt: now, accountedAt: now,
      issueKinds: [index < 42 ? 'interpretation_failure' : 'business_ambiguity'],
    }))
    // Fixture content is synthetic; error enums match the real persisted contract.
    // An HTTP/provider outage or client configuration failure is not revoked consent.
    const gmailError = state === 'error' ? 'GOOGLE_AUTH_EXPIRED: Synthetic revoked authorization'
      : state === 'transient' ? 'GOOGLE_DRIVE_UNAVAILABLE: Synthetic temporary outage'
        : state === 'configuration' ? 'GOOGLE_AUTH_CONFIG_INVALID: Synthetic client configuration failure' : null
    const calls: unknown[] = []
    await page.route(/https:\/\/[^/]+\.supabase\.co\//, route => route.abort())
    await page.route(BACKEND + '/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (request.method() === 'OPTIONS') return cors(route, {}, 204)
      if (path === '/api/health') return cors(route, health())
      if (path === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: 'synthetic@example.test' })
      if (path === '/api/automation-settings') {
        const body = request.postDataJSON()
        if (state === 'unverified') return cors(route, { message: 'SYNTHETIC_STATUS_UNAVAILABLE' }, 503)
        if (body.action !== 'read') { calls.push(body); return cors(route, { message: 'SYNTHETIC_ACTION_FAILURE' }, 503) }
        return cors(route, { googleEmail: state === 'disabled' ? null : 'synthetic-long-workspace-identity@example.test', gmailScopeGranted: state !== 'disabled', gmailEnabled: state === 'enabled' || state === 'pending' || Boolean(gmailError), discoveryEnabled: state !== 'disabled', discoveryReadiness: { profileConfigured: state === 'partial', budgetState: 'approval_required' }, gmailLastSuccessAt: state === 'disabled' ? null : now, discoveryLastSuccessAt: null, gmailLastError: gmailError, discoveryLastError: state === 'error' || state === 'pending' ? 'SYNTHETIC_DISCOVERY_TIMEOUT' : null })
      }
      if (path === '/api/workspace' && request.postDataJSON().action === 'read') return cors(route, { workspaceId: 'ws-a', revision: 91, workspaceVersion: 'txn:91', schemaVersion: snapshot.version, snapshot })
      calls.push(path); return cors(route, { code: 'UNEXPECTED' }, 409)
    })
    await page.goto('/pjsdas/settings')
    await expect(page.getByRole('heading', { name: '账号', exact: true })).toBeVisible()
    for (const label of ['后台岗位发现', '招聘邮件自动跟踪']) await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '后台工作区连接', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '退出 TodayAction', exact: true })).toBeHidden()
    await page.getByLabel('管理账号与同步', { exact: true }).click()
    await expect(page.getByRole('button', { name: '退出 TodayAction', exact: true })).toBeVisible()
    await page.getByLabel('管理账号与同步', { exact: true }).click()
    if (width === 1440 && state === 'enabled') {
      const bounds = await page.locator('.settings-connections').boundingBox()
      expect(bounds?.height).toBeLessThan(270)
      for (const row of await page.locator('.settings-account, .settings-source-panel').all()) expect((await row.boundingBox())?.height).toBeLessThanOrEqual(64)
      await expect(page.locator('.settings-preferences')).toBeVisible()
    }
    if (width === 320) await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    const gmail = page.locator('section[aria-labelledby="settings-gmail-heading"]')
    const discovery = page.locator('section[aria-labelledby="settings-discovery-heading"]')
    if (state === 'enabled') await expect(discovery.locator('.cloud-state')).toHaveText('待配置发现偏好')
    if (state === 'partial') await expect(discovery.locator('.cloud-state')).toHaveText('待批准 TA 搜索预算')
    if (state === 'unverified') {
      await expect(page.getByRole('alert')).toContainText('Google 连接状态暂时无法核对')
      await expect(page.locator('.settings-account .cloud-state')).toHaveText('连接待核对')
      await expect(gmail.getByLabel('Gmail 来源结果')).toContainText('传输与对账：状态待核对')
      await expect(gmail.getByLabel('Gmail 来源结果')).not.toContainText('传输与对账：已关闭')
      for (const region of [gmail, discovery]) await expect(region.getByRole('alert')).toHaveCount(0)
    }
    if (state === 'pending') {
      await expect(gmail.getByLabel(/^查看邮件核对结果：/)).toContainText('84 项待核对')
      await expect(gmail.locator('.cloud-state')).toHaveText('最近检查已完成')
      await expect(gmail.getByRole('alert')).toHaveCount(0)
      await expect(discovery.getByText('新岗位可能延迟出现')).toBeVisible()
      await gmail.getByLabel(/^查看邮件核对结果：/).focus()
      await page.keyboard.press('Enter')
      await expect(gmail.getByText('解释失败 42', { exact: false })).toBeVisible()
      await expect(gmail.getByText('业务歧义 42', { exact: false })).toBeVisible()
      await page.keyboard.press('Enter')
    }
    if (state === 'error') {
      await expect(gmail.locator('.cloud-state')).toHaveText('需要重新连接 Google')
      await expect(gmail.getByText('新邮件进展可能未同步')).toBeVisible()
      await expect(discovery.getByText('新岗位可能延迟出现')).toBeVisible()
      await expect(gmail.locator('.settings-permission')).toContainText('最近90天')
      await expect(gmail.getByRole('button', { name: '查看并重新授权 Gmail' })).toBeHidden()
      await gmail.locator('.settings-source-manage > summary').click()
      await expect(gmail.locator('.settings-permission')).toBeVisible()
      await expect(gmail.getByRole('button', { name: '查看并重新授权 Gmail' })).toBeVisible()
      await gmail.locator('.settings-source-manage > summary').click()
    }
    if (state === 'transient' || state === 'configuration') {
      await expect(gmail.locator('.cloud-state')).toHaveText(state === 'transient'
        ? '最近检查失败 · 等待重试' : '授权配置需要维护')
      await expect(gmail.getByText('新邮件进展可能未同步')).toBeVisible()
      await gmail.locator('.settings-source-manage > summary').click()
      await expect(gmail.locator('.settings-permission')).toBeVisible()
      await expect(gmail.getByRole('button', { name: '关闭自动跟踪', exact: true })).toBeVisible()
      await expect(gmail.getByRole('button', { name: '查看并重新授权 Gmail', exact: true })).toHaveCount(0)
      await expect(gmail).not.toContainText('重新授权会再次请求')
      await gmail.locator('.settings-source-manage > summary').click()
    }
    if (state === 'disabled' || state === 'partial') await expect(gmail.locator('.settings-permission')).toContainText('不发送或修改邮件')
    if (state === 'disabled') await expect(discovery.locator('.settings-permission')).toContainText('不会收到完整工作区')
    for (const region of [gmail, discovery]) {
      await expect(region.locator('.settings-source-body')).toBeHidden()
      await region.locator('.settings-source-manage > summary').click()
      const panelBounds = await region.boundingBox()
      const bodyBounds = await region.locator('.settings-source-body').boundingBox()
      expect(bodyBounds!.width).toBeGreaterThan(panelBounds!.width * .8)
      if (width === 320) {
        const manageBounds = await region.locator('.settings-source-manage > summary').boundingBox()
        expect(bodyBounds!.y).toBeGreaterThanOrEqual(manageBounds!.y + manageBounds!.height)
      }
    }
    if (state === 'disabled' || state === 'partial') await expect(gmail.locator('.settings-permission')).toBeVisible()
    if (state === 'disabled') await expect(discovery.locator('.settings-permission')).toBeVisible()
    for (const control of await page.getByRole('button', { name: /关闭自动跟踪|关闭后台发现/ }).all()) {
      await expect(control).toHaveClass('settings-quiet-button')
      expect(await control.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)')
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: `settings-hierarchy-evidence/${state}-${width}-expanded.png`, fullPage: true })
    for (const region of [gmail, discovery]) await region.locator('.settings-source-manage > summary').click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: `settings-hierarchy-evidence/${state}-${width}.png`, fullPage: true })
    await info.attach('settings-hierarchy', { path: `settings-hierarchy-evidence/${state}-${width}.png`, contentType: 'image/png' })
    expect(calls).toEqual([])
    if (state === 'enabled' && width === 390) {
      await gmail.locator('.settings-source-manage > summary').click()
      await gmail.getByRole('button', { name: '关闭自动跟踪' }).click()
      await expect(gmail.getByRole('alert')).toHaveText('SYNTHETIC_ACTION_FAILURE')
      await expect(gmail.locator('.cloud-state')).toHaveText('状态待核对')
      await expect(gmail.getByRole('button', { name: '关闭自动跟踪' })).toBeVisible()
      await expect(discovery.getByRole('alert')).toHaveCount(0)
      expect(calls).toEqual([{ gmailEnabled: false }])
    }
    if (state === 'pending') {
      const interfaceGroup = page.locator('details.settings-group').filter({ has: page.locator('summary strong').filter({ hasText: /^(界面|Interface)$/ }) })
      await interfaceGroup.locator('summary').click()
      await interfaceGroup.getByRole('button', { name: 'EN', exact: true }).click()
      await interfaceGroup.locator('summary').click()
      await expect(page.getByRole('heading', { name: 'Automatic recruiting-email tracking', exact: true })).toBeVisible()
      await expect(gmail.locator('.cloud-state')).toHaveText('Recent check completed')
      await expect(gmail.getByLabel(/^Review email reconciliation:/)).toContainText('84 need review')
      if (width === 320) for (const region of [gmail, discovery]) {
        const panelBounds = await region.boundingBox()
        const headingBounds = await region.getByRole('heading').boundingBox()
        const manageBounds = await region.locator('.settings-source-manage > summary').boundingBox()
        expect(headingBounds!.width).toBeGreaterThan(panelBounds!.width * .8)
        expect(manageBounds!.y).toBeGreaterThan(headingBounds!.y + headingBounds!.height)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: `settings-hierarchy-evidence/pending-en-${width}.png`, fullPage: true })
    }
  })
}

test('Today hides only a repeated application identity and retains job access and other context', async ({ page }, info) => {
  await seedSession(page.context())
  await page.clock.setFixedTime(new Date(now))
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

for (const width of [1440, 390, 320]) test(`signed-out Settings has one language owner and a brief account at ${width}`, async ({ page }, info) => {
  const oauth: string[] = []
  const writes: unknown[] = []
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.route(/https:\/\/[^/]+\.supabase\.co\//, route => {
    if (route.request().url().includes('/authorize')) oauth.push(route.request().url())
    return route.abort()
  })
  await page.route(BACKEND + '/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (path === '/api/health') return cors(route, health())
    if (request.postData() && request.postDataJSON().action !== 'read') writes.push(request.postDataJSON())
    return cors(route, {}, 401)
  })
  await page.goto('/pjsdas/settings')
  const account = page.getByRole('region', { name: /^(账号与跨设备数据|Account & cross-device data)$/ })
  const language = page.locator('.settings-surface .language-switch')
  await expect(account.getByRole('heading', { name: '账号', exact: true })).toBeVisible()
  await expect(account.getByRole('button')).toHaveCount(1)
  await expect(account.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible()
  await expect(account.locator('.cloud-settings-heading p')).toHaveText('内容仅保存在此设备')
  await expect(account.locator('.cloud-state, .cloud-connection-impact')).toHaveCount(0)
  await expect(account.getByText('使用 Google 登录 TodayAction', { exact: true })).toHaveCount(0)
  await expect(account.getByText('登录后可在自己的设备间使用同一份资料。', { exact: true })).toHaveCount(0)
  await expect(page.locator('.settings-mobile-language')).toHaveCount(0)
  await expect(language).toHaveCount(1)
  await expect(language).toBeHidden()
  const permission = account.locator('.settings-signin-permission')
  await expect(permission.locator('.settings-permission')).toBeHidden()
  await permission.getByText('授权说明', { exact: true }).click()
  await expect(permission.locator('.settings-permission')).toBeVisible()
  await expect(permission).toContainText('基本身份信息和应用专用的 Google Drive 文件权限')
  await expect(permission).toContainText('不能浏览普通 Drive 文件')
  await permission.getByText('授权说明', { exact: true }).click()
  await expect(permission.locator('.settings-permission')).toBeHidden()
  await page.screenshot({ path: `settings-hierarchy-evidence/signed-out-zh-${width}.png`, fullPage: true })
  const interfaceGroup = page.locator('details.settings-group').filter({ has: page.locator('summary strong').filter({ hasText: '界面' }) })
  await interfaceGroup.locator('summary').click()
  await expect(language).toBeVisible()
  await language.getByRole('button', { name: 'EN', exact: true }).click()
  await expect(account.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
  await expect(account.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeVisible()
  await expect(account.locator('.cloud-settings-heading p')).toHaveText('Data is saved on this device only')
  // The sole language owner persists across reload; disclosure/navigation remain read-only.
  await page.reload()
  await expect(account.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
  await expect(language).toHaveCount(1)
  await expect(language).toBeHidden()
  if (width === 320) await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  const buttonBounds = await account.getByRole('button').boundingBox()
  const permissionBounds = await permission.locator('summary').boundingBox()
  expect(buttonBounds!.height).toBeGreaterThanOrEqual(44)
  expect(permissionBounds!.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: `settings-hierarchy-evidence/signed-out-en-${width}.png`, fullPage: true })
  await info.attach('signed-out-settings', { path: `settings-hierarchy-evidence/signed-out-en-${width}.png`, contentType: 'image/png' })
  await permission.getByText('Permissions', { exact: true }).click()
  await expect(permission.locator('.settings-permission')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await permission.getByText('Permissions', { exact: true }).click()
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.goBack()
  await expect(account.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
  await expect(permission.locator('.settings-permission')).toBeHidden()
  expect(oauth).toEqual([])
  expect(writes).toEqual([])
})

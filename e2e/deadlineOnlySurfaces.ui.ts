import { expect, test } from '@playwright/test'
import { BACKEND, cors, health, opportunity, seedSession, workspace } from './fixtures/todayWorkspace.js'

const now = '2026-10-02T02:00:00.000Z'

for (const width of [1440, 390]) test(`deadline-only settings and job library at ${width}px`, async ({ page }, info) => {
  await seedSession(page.context())
  await page.clock.setFixedTime(new Date(now))
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  const snapshot = workspace()
  snapshot.data.opportunities = [
    { ...opportunity('later', '较晚截止公司', '策略产品经理'), deadline: '2026-10-08', deadlinePrecision: 'date', fitScore: 100, opportunityValue: 100 },
    { ...opportunity('unknown', '无截止日期公司', '数据分析师'), fitScore: 100, opportunityValue: 100 },
    { ...opportunity('earlier', '较近截止公司', '产品经理'), deadline: '2026-10-04', deadlinePrecision: 'date', fitScore: 1, opportunityValue: 1 },
  ]
  snapshot.data.actions = []
  const unexpectedWrites: string[] = []
  await page.route(/https:\/\/[^/]+\.supabase\.co\//, (route) => route.abort())
  await page.route(BACKEND + '/**', (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (path === '/api/health') return cors(route, health())
    if (path === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: 'synthetic@example.test' })
    if (path === '/api/workspace' && request.postDataJSON().action === 'read') return cors(route, { workspaceId: 'ws-a', revision: 91, workspaceVersion: 'txn:91', schemaVersion: snapshot.version, snapshot })
    if (path === '/api/automation-settings' && request.postDataJSON().action === 'read') return cors(route, { googleEmail: 'synthetic@example.test', gmailScopeGranted: true, gmailEnabled: true, discoveryEnabled: true, discoveryReadiness: { profileConfigured: true, budgetState: 'approval_required' }, gmailLastSuccessAt: now, discoveryLastSuccessAt: null, gmailLastError: null, discoveryLastError: null })
    unexpectedWrites.push(path)
    return cors(route, { code: 'UNEXPECTED' }, 409)
  })

  await page.goto('/pjsdas/settings')
  await expect(page.getByRole('heading', { name: '账号', exact: true })).toBeVisible()
  await expect(page.locator('.settings-group > summary').filter({ hasText: '决策规则' })).toHaveCount(0)
  await expect(page.locator('.rules-page, .rules-grid')).toHaveCount(0)
  await expect(page.locator('.settings-group > summary').filter({ hasText: '岗位发现偏好' })).toBeVisible()
  await expect(page.locator('.settings-group > summary').filter({ hasText: '数据与恢复' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: `artifacts/deadline-only-ui/settings-${width}.png`, fullPage: true })
  await info.attach('settings', { path: `artifacts/deadline-only-ui/settings-${width}.png`, contentType: 'image/png' })

  await page.locator('.settings-group > summary').filter({ hasText: '岗位发现偏好' }).click()
  await expect(page.locator('.discovery-profile-grid')).toBeVisible()
  await expect(page.getByText(/最低匹配度|最低机会价值/)).toHaveCount(0)
  await page.locator('.settings-group > summary').filter({ hasText: '岗位发现偏好' }).click()

  await page.goto('/pjsdas/library')
  const rows = page.locator('.tsui-job-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toHaveAttribute('data-opportunity-id', 'earlier')
  await expect(rows.nth(1)).toHaveAttribute('data-opportunity-id', 'later')
  await expect(rows.nth(2)).toHaveAttribute('data-opportunity-id', 'unknown')
  await expect(page.getByText(/匹配度|机会价值|综合评分/)).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: `artifacts/deadline-only-ui/jobs-${width}.png`, fullPage: true })
  await info.attach('jobs', { path: `artifacts/deadline-only-ui/jobs-${width}.png`, contentType: 'image/png' })
  await rows.nth(0).locator('.tsui-job-open').click()
  await expect(page.locator('.job-detail-page')).toBeVisible()
  await expect(page.locator('.opportunity-assessment-summary')).toHaveCount(0)
  await page.goBack()
  await expect(rows).toHaveCount(3)
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-capacity')).toBeVisible()
  await page.locator('.tsui-capacity > summary').click()
  await expect(page.getByRole('spinbutton', { name: '今天可用小时' })).toBeVisible()
  await expect(page.getByRole('button', { name: '保存可用时间' })).toHaveCount(0)
  expect(unexpectedWrites).toEqual([])
})

import { MOCK_TARGET_AUTH_ORIGIN } from './support/mockCloudTargets.js'
import { expect, test, type Page } from '@playwright/test'
import { BACKEND, cors, health, opportunity, seedSession, workspace } from './fixtures/todayWorkspace.js'

const NOW = '2026-10-06T12:00:00.000Z'
async function visual(page: Page, label: string) {
  const data = (await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true })).toString('base64')
  console.log(`OPERATIONS_VISUAL_${label}_BEGIN`)
  for (let index = 0; index < data.length; index += 3000) console.log(`OPERATIONS_VISUAL_${label}_DATA:${data.slice(index, index + 3000)}`)
  console.log(`OPERATIONS_VISUAL_${label}_END`)
}
for (const width of [1440, 390]) test(`Calendar keeps actual events apart from operation records at ${width}px`, async ({ page }, info) => {
  await seedSession(page.context())
  await page.clock.setFixedTime(new Date(NOW))
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  const snapshot = workspace()
  snapshot.data.opportunities = [opportunity('sample-job', '示例科技', '软件产品经理 P100｜2027校招'), opportunity('applied', '已投递公司', '产品经理')]
  snapshot.data.actions = []
  snapshot.data.processEvents = []
  snapshot.data.processes = []
  snapshot.data.scheduleNodes = [{ id: 'interview', occurrenceId: 'interview', version: 1, kind: 'interview', opportunityId: 'applied', state: 'scheduled', constraintKind: 'employer_hard',
    temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-08T02:00:00.000Z', resolutionBasis: 'source_explicit' },
    relatedActionIds: [], relatedPrepIds: [], evidenceRefs: [], sourceVersionRefs: [], createdAt: NOW, updatedAt: NOW }]
  snapshot.data.timeline = [
    { id: 'write', kind: 'opportunity_added', category: 'opportunity', source: 'user_action', occurredAt: '2026-10-06T03:21:00.000Z', recordedAt: '2026-10-06T03:21:00.000Z', title: '明确写入机会｜示例科技｜软件产品经理 P100｜2027校招', opportunityId: 'sample-job' },
    { id: 'correct', kind: 'opportunity_updated', category: 'opportunity', source: 'user_action', occurredAt: '2026-10-06T03:21:00.000Z', recordedAt: '2026-10-06T03:21:00.000Z', title: '核实投递截止时间', opportunityId: 'sample-job' },
    { id: 'skip', kind: 'action_status_changed', category: 'action', source: 'user_action', occurredAt: '2026-10-06T03:21:00.000Z', recordedAt: '2026-10-06T03:21:00.000Z', title: '跳过行动｜完成示例游戏｜笔试', actionId: 'old-test', changes: { status: { before: 'todo', after: 'skipped' } } },
    { id: 'submitted', kind: 'application_submitted', category: 'opportunity', source: 'user_action', occurredAt: '2026-10-02T08:00:00.000Z', recordedAt: '2026-10-06T03:21:00.000Z', title: '完成投递', opportunityId: 'applied' },
  ]
  snapshot.data.scheduleNodes.push({ ...snapshot.data.scheduleNodes[0], id: 'completed-interview', occurrenceId: 'completed-interview', state: 'completed', completedAt: '2026-10-02T08:00:00Z', temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-02T07:00:00Z', resolutionBasis: 'source_explicit' } })
  const writes: string[] = []
  await page.route(`${MOCK_TARGET_AUTH_ORIGIN}/**`, route => route.abort())
  await page.route(BACKEND + '/**', route => {
    const req = route.request(), path = new URL(req.url()).pathname
    if (req.method() === 'OPTIONS') return cors(route, {}, 204)
    if (path === '/api/health') return cors(route, health())
    if (path === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: 'synthetic@example.test' })
    if (path === '/api/workspace' && req.postDataJSON().action === 'read') return cors(route, { workspaceId: 'ws-a', revision: 92, workspaceVersion: 'txn:92', schemaVersion: snapshot.version, snapshot })
    if (path === '/api/automation-settings' && req.postDataJSON().action === 'read') return cors(route, { googleEmail: 'synthetic@example.test', gmailScopeGranted: false, gmailEnabled: false, discoveryEnabled: false, discoveryReadiness: { profileConfigured: false, budgetState: 'approval_required' } })
    writes.push(path)
    return cors(route, { code: 'UNEXPECTED' }, 409)
  })
  await page.goto('/pjsdas/schedule?view=past')
  const rows = page.locator('.tsui-schedule-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('面试')
  await expect(rows.first()).not.toContainText('完成投递')
  await expect(page.locator('.tsui-schedule-date')).toHaveText('2026-10-02')
  await expect(page.getByText('明确写入机会', { exact: false })).toHaveCount(0)
  await expect(page.getByText('核实投递截止时间', { exact: false })).toHaveCount(0)
  await expect(page.getByText('跳过行动', { exact: false })).toHaveCount(0)
  await expect(page.locator('.tsui-end')).toContainText('1')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: info.outputPath(`schedule-events-${width}.png`), fullPage: true })
  await visual(page, `SCHEDULE_${width}`)
  await rows.first().click()
  await expect(page.locator('.tsui-schedule-detail')).toContainText('已投递公司')
  await page.locator('.tsui-schedule-detail').getByRole('button', { name: '关闭详情' }).click()
  await page.locator('.tsui-schedule-tabs').getByRole('button', { name: /接下来/ }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('面试')
  await expect(page.locator('.tsui-schedule-date')).toHaveText('2026-10-08')
  await page.reload()
  await expect(rows.first()).toContainText('面试')

  await page.goto('/pjsdas/settings')
  const operations = page.locator('.settings-group').filter({ has: page.locator('summary strong').filter({ hasText: '操作记录' }) })
  await operations.locator('summary').click()
  await operations.getByRole('button', { name: '查看操作记录' }).click()
  await expect(page).toHaveURL(/\/history$/)
  await expect(page.locator('.timeline-event:not([data-record-id="timeline:system:backfill-v1"])')).toHaveCount(4)
  await expect(page.getByRole('heading', { name: '明确写入机会｜示例科技｜软件产品经理 P100｜2027校招' })).toBeVisible()
  await expect(page.locator('[data-record-id="submitted"] .timeline-recorded-time')).toContainText('记录于')
  await expect(page.locator('[data-record-id="submitted"] .timeline-event-time')).toContainText('10月2日')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: info.outputPath(`operation-records-${width}.png`), fullPage: true })
  await visual(page, `HISTORY_${width}`)
  await page.getByRole('button', { name: '返回设置' }).click()
  await expect(page).toHaveURL(/\/settings$/)
  expect(writes).toEqual([])
})

import { expect, test, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { BACKEND, cors, health, seedSession, workspace } from './fixtures/todayWorkspace.js'
import { validateSnapshot } from '../src/snapshot.js'

const phase = process.env.TA_SECONDARY_PHASE === 'before' ? 'before' : 'after'
const evidence = `secondary-ui-${phase}`
const now = '2026-09-23T08:00:00.000Z'
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function fixture() {
  const snapshot = workspace()
  snapshot.data.opportunities[0]!.company = '示例公司 · 产品与用户研究团队'
  snapshot.data.opportunities[0]!.role = '高级产品策略与体验研究 / Senior Product Research'
  snapshot.data.opportunities[1]!.company = snapshot.data.opportunities[0]!.company
  snapshot.data.timePlanning = { version: 1, defaultDailyMinutes: 480, updatedAt: now }
  snapshot.data.scheduleNodes = [{
    id: 'secondary-node', occurrenceId: 'secondary-occurrence', version: 1,
    opportunityId: 'A-opp-1', kind: 'interview', state: 'scheduled', constraintKind: 'employer_hard',
    temporal: { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai', date: '2026-09-24', resolutionBasis: 'source_explicit' },
    evidenceRefs: ['synthetic:interview'], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
    createdAt: now, updatedAt: now,
  }]
  snapshot.data.decisionRequests = [{
    id: 'secondary-decision', reason: 'ambiguous_target', state: 'open',
    question: '这次面试安排属于哪个岗位？', affectedObjects: [],
    choices: snapshot.data.opportunities.map(job => ({ id: `opportunity:${job.id}`,
      label: `${job.company} · ${job.role}`, consequence: '仅更新这个岗位，其他记录保持不变。', resolution: { opportunityId: job.id } })),
    evidenceRefs: ['synthetic:decision'], createdAt: now, updatedAt: now,
    payloadBinding: { contractVersion: 1, inputId: 'secondary-input', candidateId: 'fragment:0', statementMode: 'current_intent',
      source: { kind: 'web', sourceId: 'web', sourceRecordId: 'secondary-input', observedAt: now, assertedAt: now, timezone: 'Asia/Shanghai' },
      candidate: { id: 'fragment:0', kind: 'process_event', eventType: 'interview_invite', target: { company: snapshot.data.opportunities[0]!.company }, objectConfidence: 'low', eventConfidence: 'high', evidenceRefs: ['synthetic:decision'], sourceVersionRefs: [] } },
  }]
  validateSnapshot(snapshot)
  return snapshot
}

async function seed(page: Page) {
  await page.clock.setFixedTime(new Date(now))
  await seedSession(page.context())
  const snapshot = fixture()
  const mutations: string[] = []
  await page.route(/https:\/\/[^/]+\.supabase\.co\//, route => route.abort())
  await page.route(BACKEND + '/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (path === '/api/health') return cors(route, health())
    if (path === '/api/access' && request.postDataJSON().action === 'read') return cors(route, {
      authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: 'synthetic@example.test',
    })
    if (path === '/api/automation-settings' && request.postDataJSON().action === 'read') return cors(route, {
      googleEmail: 'synthetic@example.test', gmailScopeGranted: true, gmailEnabled: true,
      gmailHistoryIdPresent: true, gmailLastCheckedAt: now, gmailLastSuccessAt: now,
      gmailLastError: null, discoveryEnabled: false, discoveryLastCheckedAt: null,
      discoveryLastSuccessAt: null, discoveryLastError: null,
    })
    if (path === '/api/workspace') {
      const body = request.postDataJSON()
      if (body.action === 'read') return cors(route, { workspaceId: 'ws-a', revision: 91, workspaceVersion: 'txn:91', schemaVersion: snapshot.version, snapshot })
      mutations.push(body.action); return cors(route, { code: 'UNEXPECTED_WRITE' }, 409)
    }
    return cors(route, { code: 'NOT_FOUND' }, 404)
  })
  return mutations
}

async function capture(page: Page, label: string, width: number, scale = 100, protectMain = false) {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; window.scrollTo(0, 0) }, scale)
  await page.evaluate(() => document.fonts.ready)
  const name = `${label}-${width}-${scale}.png`
  await mkdir(evidence, { recursive: true })
  const bytes = await page.screenshot({ path: `${evidence}/${name}`, fullPage: true, animations: 'disabled', caret: 'hide' })
  if (protectMain && phase === 'after') {
    const baseline = await readFile(`secondary-ui-before/${name}`)
    expect(digest(bytes), `${label}: main/body pixels must remain identical to deployed 37e8487a`).toBe(digest(baseline))
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (phase === 'after') expect(overflow, `${name}: no horizontal overflow`).toBeLessThanOrEqual(1)
  const metric = { label, width, scale, overflow, sha256: digest(bytes), protectedMain: protectMain }
  console.log('SECONDARY_UI:' + JSON.stringify(metric))
  await writeFile(`${evidence}/${name}.json`, JSON.stringify(metric, null, 2))
}

for (const width of [1440, 390]) test(`main pixels stay fixed before and after secondary navigation at ${width}`, async ({ page }) => {
  const mutations = await seed(page)
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-task-row')).not.toHaveCount(0)
  await capture(page, 'MAIN_TODAY', width, 100, true)
  await page.locator('.tsui-primary-nav').getByRole('button', { name: '岗位库', exact: true }).click()
  await expect(page.locator('.tsui-job-open')).toHaveCount(2)
  await capture(page, 'MAIN_JOBS', width, 100, true)
  await page.locator('.tsui-primary-nav').getByRole('button', { name: '日程', exact: true }).click()
  await expect(page.locator('.tsui-schedule-row')).not.toHaveCount(0)
  await capture(page, 'MAIN_SCHEDULE', width, 100, true)
  await page.locator('.tsui-topbar').getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('heading', { name: '账号与跨设备数据', exact: true })).toBeVisible()
  await capture(page, 'SETTINGS', width)
  await page.locator('.tsui-primary-nav').getByRole('button', { name: '今天', exact: true }).click()
  await expect(page.locator('.tsui-task-row')).not.toHaveCount(0)
  await capture(page, 'MAIN_AFTER_SETTINGS', width, 100, true)
  await page.locator('.tsui-tell-button').click()
  await expect(page.getByRole('textbox', { name: '要告诉 TodayAction 的内容' })).toBeFocused()
  await capture(page, 'CAPTURE', width)
  await page.getByRole('textbox', { name: '要告诉 TodayAction 的内容' }).fill('例如：明天下午准备面试。')
  await expect(page.locator('.cgr-understanding')).toBeVisible()
  await capture(page, 'CAPTURE_PREVIEW', width)
  await page.keyboard.press('Escape')
  await expect(page.locator('.tsui-tell-button')).toBeFocused()
  await capture(page, 'MAIN_AFTER_CAPTURE', width, 100, true)
  expect(mutations).toEqual([])
})

for (const width of [1440, 390, 320]) test(`details and settings retain readable complete content at ${width}`, async ({ page }) => {
  const mutations = await seed(page)
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.goto('/pjsdas/library/A-opp-1')
  await expect(page.locator('.job-detail-page h1')).toContainText('Senior Product Research')
  await capture(page, 'JOB_DETAIL', width)
  await page.getByRole('button', { name: '告诉 TodayAction', exact: true }).click()
  await expect(page.locator('.cgr-capture-context')).toContainText('示例公司')
  await capture(page, 'CONTEXT_CAPTURE', width, width === 320 ? 200 : 100)
  await page.keyboard.press('Escape')
  await expect(page.locator('.job-detail-capture')).toBeFocused()
  await page.goto('/pjsdas/decisions/secondary-decision?from=A-opp-1')
  await expect(page.locator('.ultimate-decision-card')).toHaveCount(1)
  await capture(page, 'DECISION_DETAIL', width, width === 320 ? 200 : 100)
  await page.goto('/pjsdas/decisions/missing')
  await expect(page.locator('.ultimate-quiet-state')).toBeVisible()
  await capture(page, 'DECISION_EMPTY', width)
  await page.goto('/pjsdas/library/missing')
  await expect(page.locator('.cgr-missing-opportunity')).toBeVisible()
  await capture(page, 'JOB_MISSING', width)
  await page.goto('/pjsdas/schedule')
  await expect(page.locator('.tsui-schedule-row')).not.toHaveCount(0)
  await page.locator('.tsui-schedule-row').first().click()
  await expect(page.locator('.tsui-schedule-detail')).toBeVisible()
  await capture(page, 'EVENT_DETAIL', width, width === 320 ? 200 : 100)
  await page.getByRole('button', { name: '关闭详情' }).click()
  await expect(page.locator('.tsui-schedule-detail')).toHaveCount(0)
  await page.goto('/pjsdas/settings')
  await expect(page.getByRole('heading', { name: '账号与跨设备数据', exact: true })).toBeVisible()
  await page.locator('.settings-group').filter({ hasText: '可用时间' }).locator('summary').first().click()
  await capture(page, 'SETTINGS_PLANNING', width, width === 320 ? 200 : 100)
  await page.locator('.settings-group').filter({ hasText: '数据与恢复' }).locator('summary').first().click()
  await page.locator('.backup-dock-trigger').click()
  await expect(page.locator('.backup-dialog')).toBeVisible()
  await capture(page, 'BACKUP_DETAIL', width)
  await page.locator('.backup-close').click()
  await page.locator('.event-dock-trigger').click()
  await expect(page.locator('.event-dock')).toBeVisible()
  await capture(page, 'PROCESS_DETAIL', width)
  await page.locator('.event-close').click()
  expect(mutations).toEqual([])
})

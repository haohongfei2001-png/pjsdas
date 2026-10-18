import { expect, test, type Page } from '@playwright/test'
import { BACKEND, cors, health, opportunity, seedSession, workspace } from './fixtures/todayWorkspace.js'
import { MOCK_TARGET_AUTH_ORIGIN } from './support/mockCloudTargets.js'
import { semanticIntakeSchema } from '../gateway/semanticIntake.js'
import { applySemanticIntake } from '../src/semanticIntake.js'

const NOW = new Date('2026-09-21T00:00:00Z')
const NOTICE = '京东 AI产品经理 面试通知，请于2026年9月25日 14:30参加视频面试'
const IMPORT = `请导入以下转发的面试通知。\n-----Forwarded message-----\n${NOTICE}`
test.use({ timezoneId: 'Asia/Shanghai' })

async function fixture(page: Page, width: number) {
  await seedSession(page.context(), 'notice-owner', 'synthetic-notice-token')
  await page.clock.setFixedTime(NOW)
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 })
  let snapshot = workspace(), revision = 1
  snapshot.data.opportunities = [opportunity('jd', '京东', 'AI产品经理')]
  snapshot.data.processes = []; snapshot.data.processEvents = []; snapshot.data.actions = []
  snapshot.data.scheduleNodes = []; snapshot.data.timeline = []
  const commands: Array<{ id: string; candidates: unknown[]; status: string }> = []
  const receipts = new Map<string, { input: string; response: any }>()
  await page.route(`${MOCK_TARGET_AUTH_ORIGIN}/**`, route => route.abort())
  await page.route(BACKEND + '/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (path === '/api/health') return cors(route, health())
    if (path === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: 'synthetic@example.test' })
    const body = request.postDataJSON()
    const base = () => ({ workspaceId: 'synthetic-notice', revision, workspaceVersion: `txn:${revision}`, schemaVersion: snapshot.version, snapshot })
    if (path === '/api/automation-settings' && body.action === 'read') return cors(route, { googleEmail: 'synthetic@example.test', gmailScopeGranted: false, gmailEnabled: false, discoveryEnabled: false })
    if (path === '/api/workspace' && body.action === 'read') return cors(route, base())
    if (path === '/api/workspace' && body.action === 'receipt') {
      const prior = receipts.get(body.commandId)
      return cors(route, { ...base(), found: !!prior, ...(prior?.response ?? {}) })
    }
    if (path === '/api/workspace' && body.action === 'command' && body.command.type === 'semantic_intake') {
      const input = JSON.stringify(body.command), prior = receipts.get(body.commandId)
      if (prior) return prior.input === input ? cors(route, { ...base(), ...prior.response, outcome: 'ALREADY_APPLIED' }) : cors(route, { code: 'COMMAND_ID_REUSED' }, 409)
      if (body.baseRevision !== revision) return cors(route, { code: 'CONFLICT' }, 409)
      try {
        // Exercise the real gateway DTO and domain interpreter, not a canned
        // success response. Only the transport/account fixture is synthetic.
        const observation = semanticIntakeSchema.parse(body.command.value)
        const evaluated = applySemanticIntake(snapshot, observation, { authorized: true, workspaceRevision: `txn:${revision}`, now: NOW })
        snapshot = evaluated.snapshot; revision++
        const result = { status: evaluated.status, summary: evaluated.summary, semanticReceiptId: evaluated.receipt?.id, decisionRequestIds: evaluated.decisionRequests.map(item => item.id) }
        const response = { outcome: 'COMMITTED', result, receipt: { commandId: body.commandId, receiptId: `receipt:${body.commandId}`, status: 'COMMITTED', revision,
          undoAvailable: false, result } }
        receipts.set(body.commandId, { input, response })
        commands.push({ id: body.commandId, candidates: observation.candidates, status: evaluated.status })
        return cors(route, { ...base(), ...response })
      } catch (error) { return cors(route, { code: 'INVALID_COMMAND', message: String(error) }, 422) }
    }
    return cors(route, { code: 'UNEXPECTED' }, 409)
  })
  await page.goto('/pjsdas/today/capture')
  // Known-job parsing requires this existing fixture; immediate first-write
  // readiness is independently covered by the unchanged B1 journeys.
  await expect.poll(() => page.evaluate(async () => {
    const { exportLocalSnapshot } = await import('/pjsdas/src/db.ts')
    return (await exportLocalSnapshot()).data.opportunities.map(job => job.id)
  })).toEqual(['jd'])
  return { snapshot: () => snapshot, commands }
}

async function localBusiness(page: Page) {
  return page.evaluate(async () => {
    const { exportLocalSnapshot } = await import('/pjsdas/src/db.ts')
    const { processEvents, scheduleNodes } = (await exportLocalSnapshot()).data
    return { processEvents, scheduleNodes }
  })
}

for (const width of [320, 390, 1440]) {
  test(`explicit selected notice has one authoritative fact after repeat and reload at ${width}px`, async ({ page }, info) => {
    const server = await fixture(page, width), input = page.getByLabel('要告诉 TodayAction 的内容', { exact: true })
    await input.fill(IMPORT)
    await expect(page.locator('.cgr-understanding')).toContainText('记录面试安排 · 京东 · AI产品经理')
    await page.screenshot({ path: info.outputPath(`quoted-notice-preview-${width}.png`), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.getByRole('button', { name: '确认并保存', exact: true }).click()
    await expect(page.locator('.cgr-capture-receipt')).toContainText('已保存')
    expect(server.commands).toHaveLength(1)
    expect(server.commands[0]).toMatchObject({ status: 'APPLIED' })
    const first = structuredClone(server.snapshot().data)
    expect(first.processEvents).toHaveLength(1)
    expect(first.processEvents[0]).toMatchObject({ opportunityId: 'jd', type: 'interview_invite', duePrecision: 'datetime', timingMode: 'fixed' })
    expect(Date.parse(first.processEvents[0]!.dueAt!)).toBe(Date.parse('2026-09-25T14:30:00+08:00'))
    expect(first.scheduleNodes).toHaveLength(1)
    expect(first.semanticReceipts?.[0]?.sourceKind).toBe('web')
    expect(await localBusiness(page)).toEqual({ processEvents: first.processEvents, scheduleNodes: first.scheduleNodes })
    await page.reload()
    await expect(page.getByRole('dialog', { name: '告诉 TodayAction', exact: true })).toBeVisible()
    await input.fill(IMPORT)
    await expect(page.locator('.cgr-understanding')).toContainText('记录面试安排')
    await page.getByRole('button', { name: '确认并保存', exact: true }).click()
    await expect(page.locator('.cgr-capture-receipt')).toBeVisible()
    expect(server.commands).toHaveLength(2)
    expect(server.snapshot().data.processEvents).toEqual(first.processEvents)
    expect(server.snapshot().data.scheduleNodes).toEqual(first.scheduleNodes)
    expect(await localBusiness(page)).toEqual({ processEvents: first.processEvents, scheduleNodes: first.scheduleNodes })
  })

  test(`quoted source and withdrawn outer request never become facts at ${width}px`, async ({ page }) => {
    const server = await fixture(page, width), before = structuredClone(server.snapshot().data)
    const texts = [
      `以下是转发的面试通知。\n-----Forwarded message-----\n${NOTICE}`,
      `请保存以下引用的面试通知。\n> ${NOTICE}\n先不要导入`,
      `${IMPORT}；https://meet.example.test/room，非本人面试`,
      `${IMPORT}；地点：会议室A 非本人面试`,
    ]
    for (const [index, text] of texts.entries()) {
      await page.getByLabel('要告诉 TodayAction 的内容', { exact: true }).fill(text)
      await expect(page.locator('.cgr-understanding')).toHaveAttribute('aria-busy', 'false')
      await expect(page.locator('.cgr-understanding li')).toHaveCount(0)
      await page.getByRole('button', { name: '确认并保存', exact: true }).click()
      await expect(page.locator('.cgr-capture-receipt')).toContainText('没有被当作当前事实写入')
      expect(server.commands).toHaveLength(index + 1)
      expect(server.commands[index]).toMatchObject({ candidates: [], status: 'NO_WRITE' })
      expect(server.snapshot().data).toEqual(before)
    }
    await page.reload()
    expect(await localBusiness(page)).toEqual({ processEvents: [], scheduleNodes: [] })
  })
}

test('explicit structured quoted job saves only an Opportunity, repeats safely, and respects withdrawal', async ({ page }) => {
  const server = await fixture(page, 390)
  const text = '请导入以下岗位说明。\n> 公司：示例科技\n> 岗位：AI产品经理\n> 地点：上海\n> 招聘链接：https://careers.example.test/jobs/pm-2027\n> 申请截止：2026-10-30'
  const input = page.getByLabel('要告诉 TodayAction 的内容', { exact: true })
  const localJobs = () => page.evaluate(async () => {
    const { exportLocalSnapshot } = await import('/pjsdas/src/db.ts')
    const { opportunities, actions, processes, processEvents, scheduleNodes } = (await exportLocalSnapshot()).data
    return { opportunities, actions, processes, processEvents, scheduleNodes }
  })
  await input.fill(text)
  await expect(page.locator('.cgr-understanding')).toContainText('添加岗位 · 示例科技 · AI产品经理')
  await page.getByRole('button', { name: '确认并保存', exact: true }).click()
  await expect(page.locator('.cgr-capture-receipt')).toContainText('已保存')
  expect(server.commands).toHaveLength(1)
  expect(server.commands[0]).toMatchObject({ status: 'APPLIED', candidates: [{ kind: 'user_opportunity' }] })
  const first = structuredClone(server.snapshot().data)
  expect(first.opportunities).toHaveLength(2)
  expect(first.opportunities[1]).toMatchObject({ company: '示例科技', role: 'AI产品经理', processStage: 'not_applied',
    deadline: '2026-10-30', deadlinePrecision: 'date', detail: { userFacts: { provenance: 'user_asserted', location: '上海' } } })
  const expected = { opportunities: first.opportunities, actions: [], processes: [], processEvents: [], scheduleNodes: [] }
  expect(await localJobs()).toEqual(expected)
  await page.reload()
  await expect(page.getByRole('dialog', { name: '告诉 TodayAction', exact: true })).toBeVisible()
  expect(await localJobs()).toEqual(expected)
  await input.fill(text)
  await expect(page.locator('.cgr-understanding')).toContainText('添加岗位')
  await page.getByRole('button', { name: '确认并保存', exact: true }).click()
  await expect(page.locator('.cgr-capture-receipt')).toBeVisible()
  expect(server.commands).toHaveLength(2)
  expect(server.snapshot().data.opportunities).toEqual(first.opportunities)
  expect(await localJobs()).toEqual(expected)
  const beforeWithdrawal = structuredClone(server.snapshot().data)
  await input.fill(text + '\n先不要导入，这只是示例。')
  await expect(page.locator('.cgr-understanding')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.cgr-understanding li')).toHaveCount(0)
  await page.getByRole('button', { name: '确认并保存', exact: true }).click()
  await expect(page.locator('.cgr-capture-receipt')).toContainText('没有被当作当前事实写入')
  expect(server.commands).toHaveLength(3)
  expect(server.commands[2]).toMatchObject({ status: 'NO_WRITE', candidates: [] })
  expect(server.snapshot().data).toEqual(beforeWithdrawal)
  expect(await localJobs()).toEqual(expected)
})

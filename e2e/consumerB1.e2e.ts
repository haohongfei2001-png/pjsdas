import { withFailureDiagnostic } from './fixtures/failureDiagnostic.js'
import { MOCK_TARGET_AUTH_ORIGIN } from './support/mockCloudTargets.js'
import { expect, test, type Page } from '@playwright/test'
import { BACKEND, cors, health, seedSession, workspace } from './fixtures/todayWorkspace.js'
import { applySemanticIntake, applySemanticCompensation } from '../src/semanticIntake.js'
import { applyUserDomainCommand, applyDomainCompensation } from '../src/domainCommands.js'
import { semanticIntakeSchema } from '../gateway/semanticIntake.js'

const NOW = new Date('2026-10-07T02:00:00Z')
test.use({ timezoneId: 'Asia/Shanghai' })
async function visual(page: Page, label: string) {
  const value = (await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true })).toString('base64')
  console.log(`B1_VISUAL_${label}_BEGIN`)
  for (let i = 0; i < value.length; i += 3000) console.log(`B1_VISUAL_${label}_DATA:${value.slice(i, i + 3000)}`)
  console.log(`B1_VISUAL_${label}_END`)
}

for (const { width, deferredBootstrap } of [
  { width: 390, deferredBootstrap: false },
  { width: 1440, deferredBootstrap: false },
  { width: 390, deferredBootstrap: true },
]) test(`B1 global add, explicit today and timed task preserve authority at ${width}px${deferredBootstrap ? ' with deferred passive bootstrap' : ''}`, async ({ page }, info) => {
  await seedSession(page.context(), 'b1-owner', 'synthetic-b1-token')
  if (deferredBootstrap) await page.addInitScript(() => {
    // A supported setting disables timer-driven sync, not the command path.
    // Consumer passive reads are held below, so only the explicit save can
    // establish the first owner. Do not wait for a hidden readiness predicate.
    const key = 'pjsdas-google-drive-sync-state-v2'
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 2, deviceId: 'synthetic-command-first', autoSync: false, accounts: {} }))
  })
  await page.clock.setFixedTime(NOW)
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  let snapshot = workspace(), revision = 1
  snapshot.data.opportunities = []; snapshot.data.actions = []; snapshot.data.processEvents = []
  snapshot.data.processes = []; snapshot.data.scheduleNodes = []; snapshot.data.timeline = []
  const commands = new Map<string, { input: string; result: any; compensation?: any }>()
  const mutations: string[] = []
  let holdSubmission = false, releaseSubmission = () => {}
  let submissionAcknowledgement = Promise.resolve()
  let passiveReads = 0, releaseBootstrap = () => {}, bootstrapRequested = () => {}
  const bootstrapBlocked = new Promise<void>(resolve => { releaseBootstrap = resolve })
  const bootstrapStarted = new Promise<void>(resolve => { bootstrapRequested = resolve })
  page.on('close', releaseBootstrap)
  await page.route(`${MOCK_TARGET_AUTH_ORIGIN}/**`, route => route.abort())
  await page.route(BACKEND + '/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (path === '/api/health') return cors(route, health())
    if (path === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: 'synthetic@example.test' })
    const body = request.postDataJSON()
    const base = () => ({ workspaceId: 'synthetic-b1', revision, workspaceVersion: `txn:${revision}`, schemaVersion: snapshot.version, snapshot })
    if (path === '/api/automation-settings' && body.action === 'read') return cors(route, { googleEmail: 'synthetic@example.test', gmailScopeGranted: false, gmailEnabled: false, discoveryEnabled: false, discoveryReadiness: { profileConfigured: false, budgetState: 'approval_required' } })
    if (path === '/api/workspace' && body.action === 'read') {
      if (deferredBootstrap && !body.projection) {
        passiveReads++
        bootstrapRequested()
        await bootstrapBlocked
        // The first document has deliberately navigated away by release.
        if (request.failure() || page.isClosed()) return
      }
      return cors(route, base())
    }
    if (path === '/api/workspace' && body.action === 'receipt') {
      const prior = commands.get(body.commandId)
      return cors(route, { ...base(), found: !!prior, ...(prior?.result ?? {}) })
    }
    if (path === '/api/workspace' && (body.action === 'command' || body.action === 'undo')) {
      const input = JSON.stringify(body.command ?? body.targetCommandId)
      const prior = commands.get(body.commandId)
      if (prior) return prior.input === input ? cors(route, { ...base(), ...prior.result, outcome: 'ALREADY_APPLIED' }) : cors(route, { code: 'COMMAND_ID_REUSED' }, 409)
      // Undo is bound to its authoritative target receipt, not a client revision.
      if (body.action === 'command' && body.baseRevision !== revision) return cors(route, { code: 'CONFLICT' }, 409)
      try {
        let compensation: any, result: any
        if (body.action === 'undo') {
          const undo = commands.get(body.targetCommandId)?.compensation
          snapshot = undo?.operation === 'semantic_batch' ? applySemanticCompensation(snapshot, undo, NOW) : applyDomainCompensation(snapshot, undo, NOW)
          result = { status: 'APPLIED', summary: 'Undone.' }
        } else if (body.command.type === 'semantic_intake') {
          const evaluated = applySemanticIntake(snapshot, semanticIntakeSchema.parse(body.command.value), { authorized: true, workspaceRevision: `txn:${revision}`, now: NOW })
          snapshot = evaluated.snapshot; compensation = evaluated.compensation
          result = { status: evaluated.status, summary: evaluated.summary, semanticReceiptId: evaluated.receipt?.id, decisionRequestIds: evaluated.decisionRequests.map(item => item.id) }
        } else {
          const evaluated = applyUserDomainCommand(snapshot, body.command.value, NOW)
          snapshot = evaluated.snapshot; compensation = 'compensation' in evaluated ? evaluated.compensation : undefined
          result = { status: evaluated.status, summary: evaluated.summary }
        }
        revision++; mutations.push(body.commandId)
        const response = { outcome: 'COMMITTED', result, receipt: { commandId: body.commandId, receiptId: `receipt:${body.commandId}`,
          status: 'COMMITTED', revision, undoAvailable: Boolean(compensation), undoCompensation: compensation, result } }
        commands.set(body.commandId, { input, result: response, compensation })
        if (holdSubmission && body.command?.type === 'domain' && body.command.value.kind === 'record_application_submission') await submissionAcknowledgement
        return cors(route, { ...base(), ...response })
      } catch (error) { return cors(route, { code: 'INVALID_COMMAND', message: String(error) }, 422) }
    }
    return cors(route, { code: 'UNEXPECTED' }, 409)
  })
  await page.goto('/pjsdas/today/capture')
  // Establish the controlled in-flight request, never completed authority.
  if (deferredBootstrap) await bootstrapStarted
  await page.locator('.cgr-capture-more').click()
  await page.getByRole('button', { name: '手动填写岗位', exact: true }).click()
  const manualCapture = page.getByRole('dialog', { name: '添加岗位', exact: true })
  await expect(manualCapture).toBeVisible()
  await expect(manualCapture).toHaveAttribute('aria-modal', 'false')
  await page.getByLabel('公司名称', { exact: true }).fill('示例科技')
  await page.getByLabel('岗位名称', { exact: true }).fill('产品经理 2027')
  await page.getByText('地点与截止日期＋', { exact: true }).click()
  await page.getByLabel('申请截止日期（选填）', { exact: true }).fill('2026-10-12')
  await page.screenshot({ path: info.outputPath(`manual-job-${width}.png`), fullPage: true })
  await visual(page, `FORM_${width}`)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  if (deferredBootstrap) {
    expect(passiveReads).toBeGreaterThan(0)
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2')!))
    expect(state.autoSync).toBe(false)
    expect(state.workspaceOwnerUserId).toBeUndefined()
  }
  await page.getByRole('button', { name: '保存岗位', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
  await expect(page.locator('.cgr-capture-receipt')).toContainText('岗位已保存')
  if (deferredBootstrap) {
    // Immediate observations, not polling or extra settling before navigation.
    const binding = await page.evaluate(async () => {
      const { canMountMockAccountCache } = await import('/pjsdas/src/cloud/mockCacheBoundary.ts')
      const { getCloudDeviceState } = await import('/pjsdas/src/cloud/syncState.ts')
      return { owner: getCloudDeviceState().workspaceOwnerUserId, reloadable: await canMountMockAccountCache(localStorage, getCloudDeviceState) }
    })
    expect(binding).toEqual({ owner: 'b1-owner', reloadable: true })
  }
  expect(mutations).toHaveLength(1)
  expect(snapshot.data.opportunities).toHaveLength(1)
  expect(snapshot.data.actions).toEqual([])
  expect(snapshot.data.scheduleNodes).toEqual([])
  const job = snapshot.data.opportunities[0]
  expect(job.detail?.userFacts).toMatchObject({ provenance: 'user_asserted', deadline: '2026-10-12', deadlinePrecision: 'date' })
  expect(job.detail?.userFacts?.applicationUrl).toBeUndefined()
  expect(job.detail?.discovery).toBeUndefined()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.goto(`/pjsdas/opportunities/${encodeURIComponent(job.id)}`)
  await expect(page.getByRole('heading', { name: '产品经理 2027', exact: true })).toBeVisible()
  // A new job has no application task. Explicit submission still uses the
  // durable immediate Undo path, including offline capture and delayed ACK.
  submissionAcknowledgement = new Promise(resolve => { releaseSubmission = resolve })
  holdSubmission = true
  try {
    if (width === 390) await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }))
    await page.getByRole('button', { name: '我已投递', exact: true }).click()
    const undo = page.locator('.action-undo-toast').getByRole('button', { name: '撤销', exact: true })
    await withFailureDiagnostic(() => expect(undo).toBeVisible(), async () => {
      // Failure-only, synthetic fixture diagnostics. Never serialize Auth storage,
      // tokens, command payloads, or the workspace itself.
      const diagnostic = await page.evaluate(async () => {
        const lease = await import('/pjsdas/src/cloud/accountCacheLease.ts')
        const account = lease.currentAccountCacheSession()
        const state = JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? 'null')
        if (account !== 'b1-owner' || state?.workspaceOwnerUserId !== 'b1-owner') {
          return { syntheticAccountMatches: false, generation: lease.currentAccountCacheGeneration(), resolved: lease.isAccountCacheSessionResolved() }
        }
        const checkpoint = state.accounts?.['b1-owner'] ?? {}
        const { pendingCommandSummary } = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
        const { exportLocalSnapshot } = await import('/pjsdas/src/db.ts')
        const { fingerprintWorkspace } = await import('/pjsdas/src/cloud/workspaceFingerprint.ts')
        return {
          syntheticAccountMatches: true, generation: lease.currentAccountCacheGeneration(), resolved: lease.isAccountCacheSessionResolved(),
          checkpoint: { lastSyncedVersion: checkpoint.lastSyncedVersion, lastSyncedFingerprint: checkpoint.lastSyncedFingerprint,
            localPendingFingerprint: checkpoint.localPendingFingerprint, conflictPresent: Boolean(checkpoint.conflict) },
          localFingerprint: await fingerprintWorkspace(await exportLocalSnapshot()),
          pending: pendingCommandSummary('b1-owner'),
        }
      })
      await info.attach('synthetic-submission-admission.json', {
        body: JSON.stringify(diagnostic, null, 2), contentType: 'application/json',
      })
    })
    if (width === 390) {
      expect(mutations).toHaveLength(1)
      await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')) })
    }
    await expect.poll(() => snapshot.data.opportunities[0].processStage).toBe('screening')
    expect(snapshot.data.actions).toEqual([])
    await undo.click()
    await expect(page.getByRole('button', { name: '我已投递', exact: true })).toBeVisible()
  } finally { holdSubmission = false; releaseSubmission(); releaseBootstrap() }
  await expect.poll(() => snapshot.data.opportunities[0].processStage).toBe('not_applied')
  await expect.poll(() => mutations.length).toBe(3)
  expect(snapshot.data.actions).toEqual([])
  expect(snapshot.data.scheduleNodes).toEqual([])
  await page.getByRole('button', { name: '加入今天', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已加入今天' })).toBeVisible()
  await page.getByRole('button', { name: '加入今天', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已加入今天' })).toBeVisible()
  expect(snapshot.data.actions).toHaveLength(1)
  expect(snapshot.data.actions[0].plannedDate).toBe('2026-10-07')
  expect(snapshot.data.scheduleNodes).toEqual([])
  await page.goto('/pjsdas/today')
  await expect(page.locator('[data-action-id="apply:' + job.id + '"]')).toBeVisible()
  await page.goto('/pjsdas/schedule')
  await expect(page.locator('.tsui-schedule-row')).toHaveCount(0)
  await page.goto('/pjsdas/today/capture')
  await page.getByRole('textbox', { name: '要告诉 TodayAction 的内容' }).fill('明天 15:00 填写报销单')
  await page.getByRole('button', { name: '确认并保存', exact: true }).click()
  await expect(page.locator('.cgr-capture-receipt')).toContainText('已记录明确事实')
  const timed = snapshot.data.actions.find(item => item.title === '明天 15:00 填写报销单')!
  expect(timed.scheduledTemporal?.startAt).toBe('2026-10-08T15:00:00+08:00')
  expect(snapshot.data.scheduleNodes).toHaveLength(1)
  expect(snapshot.data.scheduleNodes![0].relatedActionIds).toEqual([timed.id])
  expect(snapshot.data.scheduleNodes![0].temporal.endAt).toBeUndefined()
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.goto('/pjsdas/schedule')
  await expect(page.locator('.tsui-schedule-row')).toHaveCount(1)
  await expect(page.locator('.tsui-schedule-row')).toContainText('填写报销单')
  await expect(page.locator('.tsui-schedule-date')).toHaveText('2026-10-08')
  await visual(page, `SCHEDULE_${width}`)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.reload()
  await expect(page.locator('.tsui-schedule-row')).toHaveCount(1)
  await page.goto(`/pjsdas/opportunities/${encodeURIComponent(job.id)}`)
  await page.getByRole('button', { name: '我已投递', exact: true }).click()
  await expect(page.locator('.action-undo-toast').getByRole('button', { name: '撤销', exact: true })).toBeVisible()
  await expect.poll(() => snapshot.data.opportunities[0].processStage).toBe('screening')
  await expect.poll(() => snapshot.data.actions.find(item => item.id === `apply:${job.id}`)?.status).toBe('done')
  expect(snapshot.data.scheduleNodes).toHaveLength(1)
})

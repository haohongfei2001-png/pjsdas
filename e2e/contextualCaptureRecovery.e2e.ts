import { expect, test } from '@playwright/test'
import { BACKEND, cors, health, opportunity, seedSession, workspace } from './fixtures/todayWorkspace.js'
import { MOCK_TARGET_AUTH_ORIGIN } from './support/mockCloudTargets.js'
import { semanticIntakeSchema } from '../gateway/semanticIntake.js'
import { applySemanticIntake } from '../src/semanticIntake.js'

test('a late A completion never consumes or presents success for same-text B', async ({ page }) => {
  await seedSession(page.context(), 'context-owner', 'synthetic-context-token')
  const now = new Date('2026-10-07T12:00:00Z')
  await page.clock.setFixedTime(now)
  let snapshot = workspace(), revision = 1
  snapshot.data.opportunities = [opportunity('a', 'Context A', 'Analyst'), opportunity('b', 'Context B', 'Engineer')]
  snapshot.data.actions = []; snapshot.data.processes = []; snapshot.data.processEvents = []; snapshot.data.timeline = []
  snapshot.data.scheduleNodes = ['a', 'b'].map(id => ({ id: `schedule:${id}:v1`, occurrenceId: `${id}-interview`, opportunityId: id,
    version: 1, kind: 'interview', state: 'scheduled', constraintKind: 'employer_hard',
    temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: '2026-10-08T12:00:00Z', endAt: '2026-10-08T13:00:00Z', resolutionBasis: 'user_explicit' },
    evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [], createdAt: now.toISOString(), updatedAt: now.toISOString() }))
  const commands: string[] = [], receipts = new Map<string, any>()
  let release = () => {}, started = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { started = resolve })
  page.on('close', release)
  await page.route(`${MOCK_TARGET_AUTH_ORIGIN}/**`, route => route.abort())
  await page.route(BACKEND + '/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (path === '/api/health') return cors(route, health())
    if (path === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: 'synthetic@example.test' })
    const body = request.postDataJSON()
    const base = () => ({ workspaceId: 'synthetic-context', revision, workspaceVersion: `txn:${revision}`, schemaVersion: snapshot.version, snapshot })
    if (path === '/api/automation-settings') return cors(route, { googleEmail: 'synthetic@example.test', gmailScopeGranted: false, gmailEnabled: false, discoveryEnabled: false })
    if (path === '/api/workspace' && body.action === 'read') return cors(route, base())
    if (path === '/api/workspace' && body.action === 'receipt') return cors(route, { ...base(), found: receipts.has(body.commandId), ...(receipts.get(body.commandId) ?? {}) })
    if (path === '/api/workspace' && body.action === 'command' && body.command.type === 'semantic_intake') {
      commands.push(body.commandId); started(); await held
      if (receipts.has(body.commandId)) return cors(route, { ...base(), ...receipts.get(body.commandId), outcome: 'ALREADY_APPLIED' })
      const observation = semanticIntakeSchema.parse(body.command.value)
      expect(observation.contextRefs).toEqual(['opportunity:a'])
      const applied = applySemanticIntake(snapshot, observation, { authorized: true, workspaceRevision: `txn:${revision}`, now })
      expect(applied.status).toBe('APPLIED')
      snapshot = applied.snapshot; revision++
      const result = { status: applied.status, summary: applied.summary, decisionRequestIds: [] }
      const response = { outcome: 'COMMITTED', result, receipt: { commandId: body.commandId, status: 'COMMITTED', revision, result, undoAvailable: false } }
      receipts.set(body.commandId, response)
      return cors(route, { ...base(), ...response })
    }
    return cors(route, { code: 'UNEXPECTED' }, 409)
  })
  try {
    await page.goto('/pjsdas/opportunities/a')
    await expect(page.getByRole('heading', { name: 'Analyst', exact: true })).toBeVisible()
    await page.locator('.job-detail-capture').click()
    const input = page.getByLabel('要告诉 TodayAction 的内容', { exact: true })
    const text = '这次面试已经完成了。'
    await input.fill(text)
    await expect(page.locator('.cgr-understanding')).toContainText('面试已完成')
    await page.getByRole('button', { name: '确认并保存', exact: true }).click()
    await requested
    await page.keyboard.press('Escape')
    await page.locator('.tsui-primary-nav').getByRole('button', { name: /岗位库|Jobs/ }).click()
    await page.locator('.opportunity-decision-row').filter({ hasText: 'Context B' }).click()
    await page.locator('.job-detail-capture').click()
    await expect(page.getByRole('dialog', { name: '告诉 TodayAction', exact: true })).toContainText('Context B · Engineer')
    await expect(input).toHaveValue(text)
    release()
    await expect.poll(() => snapshot.data.scheduleNodes?.find(node => node.occurrenceId === 'a-interview')?.state).toBe('completed')
    await expect(page.getByRole('button', { name: '确认保存状态', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '确认保存状态', exact: true }).click()
    await expect(page.locator('.cgr-capture-receipt')).toContainText('当前岗位的输入没有提交')
    await expect(input).toHaveValue(text)
    expect(commands).toHaveLength(1)
    expect(snapshot.data.scheduleNodes?.find(node => node.occurrenceId === 'b-interview')?.state).toBe('scheduled')
    expect(await page.evaluate(async () => (await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')).readAccountDraft('context-owner', 'tell-pjsdas'))).toBe(text)
  } finally { release() }
})

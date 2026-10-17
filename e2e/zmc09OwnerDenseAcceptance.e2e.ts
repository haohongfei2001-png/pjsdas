import { expect, test, type BrowserContext, type Route } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { diffCommandObjects, domainIntentObjects, overlappingCommandObjects,
  semanticIntentObjects, type CommandObjectRef } from '../gateway/commandObjects.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
import { denseDecision, denseDecisionWorkspace, DENSE_NOW } from '../tests/fixtures/denseDecisionWorkspace.js'
import { action, BACKEND, cors, health, seedSession, workspace } from './fixtures/todayWorkspace.js'

test.use({ timezoneId: 'Asia/Shanghai' })

interface SyntheticServer {
  revision: number
  snapshot: PJSDASSnapshot
  receipts: Map<string, Record<string, unknown>>
  commands: Array<{ client: string; commandId: string; baseRevision: number;
    resultingRevision: number; intentObjects: CommandObjectRef[]; affectedObjects: CommandObjectRef[] }>
}

function response(server: SyntheticServer, extra: Record<string, unknown> = {}) {
  return { workspaceId: 'owner-dense-workspace', revision: server.revision,
    workspaceVersion: `txn:${server.revision}`, schemaVersion: server.snapshot.version,
    snapshot: server.snapshot, ...extra }
}

async function installServer(context: BrowserContext, server: SyntheticServer, client: string,
  unavailable: () => boolean) {
  await context.route(`${BACKEND}/**`, (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (url.pathname === '/api/health') return cors(route, health())
    if (url.pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)
    if (unavailable()) return route.abort('failed')
    const body = request.postDataJSON() as Record<string, any>
    if (body.action === 'read') return cors(route, response(server))
    if (body.action === 'receipt') {
      const receipt = server.receipts.get(String(body.commandId))
      return cors(route, response(server, { found: Boolean(receipt), receipt }))
    }
    if (body.action === 'command' && ['semantic_intake', 'domain'].includes(body.command?.type)) {
      const commandId = String(body.commandId)
      let receipt = server.receipts.get(commandId)
      if (receipt) return cors(route, response(server, { outcome: 'ALREADY_APPLIED', receipt, result: receipt.result }))
      const baseRevision = Number(body.baseRevision)
      const intentObjects = body.command.type === 'semantic_intake'
        ? semanticIntentObjects(body.command.value, server.snapshot)
        : domainIntentObjects(body.command.value, server.snapshot)
      const intervening = server.commands.filter(item => item.resultingRevision > baseRevision)
      const overlapping = intervening.flatMap(item => overlappingCommandObjects(intentObjects, item.affectedObjects))
      if (!Number.isInteger(baseRevision) || baseRevision > server.revision || overlapping.length) {
        return cors(route, response(server, { outcome: 'CONFLICT', conflict: {
          kind: 'OBJECT_CONFLICT', message: 'This business object changed on another device.',
          objects: overlapping, interveningCommandIds: intervening.map(item => item.commandId),
        } }), 409)
      }
      if (body.command.type !== 'semantic_intake') return cors(route, { code: 'UNEXPECTED_DOMAIN_COMMAND' }, 400)
      if (!receipt) {
        const before = structuredClone(server.snapshot)
        const candidate = body.command.value?.candidates?.find((item: { kind: string }) => item.kind === 'manual_action')
        const title = String(candidate?.title ?? '已记录的行动')
        const actionId = `accepted:${commandId}`
        server.snapshot.data.actions.push(action(actionId, title, undefined, 70, '2026-09-29'))
        server.snapshot.data.semanticReceipts ??= []
        server.snapshot.data.semanticReceipts.push({
          id: `semantic-receipt:${commandId}`, inputId: body.command.value.inputId,
          sourceKind: 'web', sourceId: 'todayaction-web',
          sourceRecordId: body.command.value.source.sourceRecordId,
          commandId, status: 'committed', summary: `已记录：${title}`,
          affectedObjects: [{ type: 'action', id: actionId }], decisionRequestIds: [],
          undoAvailable: true, createdAt: DENSE_NOW.toISOString(), updatedAt: DENSE_NOW.toISOString(),
        })
        server.revision += 1
        const affectedObjects = diffCommandObjects(before, server.snapshot)
        server.commands.push({ client, commandId, baseRevision, resultingRevision: server.revision,
          intentObjects, affectedObjects })
        receipt = { commandId, receiptId: `command-receipt:${commandId}`, status: 'COMMITTED',
          revision: server.revision, affectedObjects,
          undoAvailable: true, result: { type: 'semantic_intake', status: 'APPLIED',
            summary: `已记录：${title}`, decisionRequestIds: [] } }
        server.receipts.set(commandId, receipt)
      }
      return cors(route, response(server, { outcome: 'COMMITTED', receipt, result: receipt.result }))
    }
    return cors(route, { code: 'UNEXPECTED_ACTION', action: body.action }, 400)
  })
}

async function localRows(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const db = await (await import('/pjsdas/src/db.ts')).dbPromise
    return { actions: await db.getAll('actions'), decisions: await db.getAll('decisionRequests'),
      nodes: await db.getAll('scheduleNodes'), audit: await db.get('timeline', 'gmail-background-audit') }
  })
}

test('dense owner day survives Gmail refresh, a cross-device update and offline command restart', async ({ browser }) => {
  test.setTimeout(120_000)
  const snapshot = denseDecisionWorkspace()
  snapshot.data.timePlanning = { version: 1, defaultDailyMinutes: 360, updatedAt: DENSE_NOW.toISOString() }
  for (let index = 98; index < 101; index += 1) {
    const node = snapshot.data.scheduleNodes?.[index]
    if (node?.temporal.shape === 'date_only') node.temporal.date = '2026-09-30'
  }
  const server: SyntheticServer = { revision: 1004, snapshot, receipts: new Map(), commands: [] }
  const profilePath = await mkdtemp(join(tmpdir(), 'zmc09-owner-profile-'))
  let firstContext = await browser.browserType().launchPersistentContext(profilePath, {
    timezoneId: 'Asia/Shanghai', headless: true,
  })
  const secondContext = await browser.newContext({ timezoneId: 'Asia/Shanghai' })
  let firstUnavailable = false
  await seedSession(firstContext, 'owner-account', 'first-device-token')
  await seedSession(secondContext, 'owner-account', 'second-device-token')
  await installServer(firstContext, server, 'first', () => firstUnavailable)
  await installServer(secondContext, server, 'second', () => false)
  try {
    const first = await firstContext.newPage()
    const second = await secondContext.newPage()
    await first.clock.setFixedTime(DENSE_NOW)
    await second.clock.setFixedTime(DENSE_NOW)
    await first.goto('/pjsdas/today')
    await second.goto('/pjsdas/today')
    await expect.poll(() => first.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}')
      .accounts?.['owner-account']?.lastSyncedVersion)).toBe('txn:1004')
    await expect.poll(() => second.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}')
      .accounts?.['owner-account']?.lastSyncedVersion)).toBe('txn:1004')
    const taskCount = await first.locator('.tsui-task-panel .tsui-task-row').count()
    expect(taskCount).toBeGreaterThan(0)
    expect(taskCount).toBeLessThanOrEqual(server.snapshot.data.actions.length)
    // This source fixture contains only archived application deadlines.
    await expect(first.locator('.tsui-node-panel .tsui-node-row')).toHaveCount(0)
    await expect(first.locator('.tsui-status')).toHaveCount(0)
    await expect(first.getByRole('button', { name: /查看全部待决定事项/ })).toHaveCount(0)
    await expect(first.locator('.tsui-task-row').filter({ hasText: '需要你决定' })).toHaveCount(0)

    // Server-side Gmail ingestion advances authority while the first browser holds an old cache.
    server.snapshot.data.timeline ??= []
    server.snapshot.data.timeline.push({
      id: 'gmail-background-audit', kind: 'ingestion_recorded', category: 'data', source: 'gmail',
      occurredAt: DENSE_NOW.toISOString(), recordedAt: DENSE_NOW.toISOString(), title: 'Background Gmail observation',
      ingestion: { version: 1, sourceKind: 'gmail', sourceId: 'gmail:primary',
        sourceRecordId: 'background-message', runId: 'background-run', fingerprint: 'synthetic-message-fingerprint',
        recordType: 'recruiting_message', outcome: 'ignored', receivedAt: DENSE_NOW.toISOString(),
        accountedAt: DENSE_NOW.toISOString() },
    })
    server.revision += 1
    await first.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(async () => Boolean((await localRows(first)).audit)).toBe(true)
    await expect(first.locator('.tsui-status')).toHaveCount(0)

    // The first device records an offline command. A separate device commits while it is offline.
    await firstContext.setOffline(true)
    await first.locator('.tsui-topbar').getByRole('button', { name: /告诉 TodayAction/ }).click()
    await first.locator('.cgr-capture-input').fill('事项：离线整理材料')
    await first.getByRole('button', { name: '确认并保存' }).click()
    await expect(first.getByText('待同步')).toBeVisible()
    const queued = await first.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:owner-account') ?? '[]'))
    expect(queued).toMatchObject([{ status: 'pending', baseRevision: 1005 }])
    expect(server.commands.filter(item => item.client === 'first')).toHaveLength(0)

    await second.locator('.tsui-topbar').getByRole('button', { name: /告诉 TodayAction/ }).click()
    await second.locator('.cgr-capture-input').fill('事项：另一设备整理岗位')
    await second.getByRole('button', { name: '确认并保存' }).click()
    await expect(second.getByText(/已记录：另一设备整理岗位/)).toBeVisible()
    expect(server.commands.filter(item => item.client === 'second')).toHaveLength(1)

    // Close and relaunch the browser process with the same IndexedDB profile and outbox.
    firstUnavailable = true
    await firstContext.setOffline(false)
    // Keep mocks active while the old app document unloads; the following
    // context close/relaunch still discards the entire browser process.
    console.log(`Mock restart lifecycle: dense owner before blank ${new Date().toISOString()}`)
    await first.goto('about:blank')
    console.log(`Mock restart lifecycle: dense owner before close ${new Date().toISOString()}`)
    await first.close()
    await firstContext.close()
    firstContext = await browser.browserType().launchPersistentContext(profilePath, {
      timezoneId: 'Asia/Shanghai', headless: true,
    })
    await seedSession(firstContext, 'owner-account', 'first-device-token')
    await installServer(firstContext, server, 'first', () => firstUnavailable)
    const restarted = await firstContext.newPage()
    await restarted.goto('/pjsdas/capture')
    await restarted.clock.setFixedTime(DENSE_NOW)
    await restarted.reload()
    await expect(restarted.locator('.cgr-capture-input')).toHaveValue('事项：离线整理材料')
    expect(await restarted.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:owner-account') ?? '[]')))
      .toMatchObject([{ commandId: queued[0].commandId, status: 'pending' }])
    expect(server.commands.filter(item => item.client === 'first')).toHaveLength(0)
    firstUnavailable = false
    await restarted.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(() => server.commands.filter(item => item.client === 'first').length).toBe(1)
    expect(server.commands.find(item => item.client === 'first')).toMatchObject({
      commandId: queued[0].commandId, baseRevision: 1005, resultingRevision: 1007,
    })
    const secondWrite = server.commands.find(item => item.client === 'second')!
    const firstWrite = server.commands.find(item => item.client === 'first')!
    expect(secondWrite.resultingRevision).toBe(1006)
    expect(overlappingCommandObjects(firstWrite.intentObjects, secondWrite.affectedObjects)).toHaveLength(0)
    await expect.poll(() => restarted.evaluate(() => localStorage.getItem('pjsdas-cgr01-pending:owner-account'))).toBeNull()
    await restarted.goto('/pjsdas/today')
    const saved = await localRows(restarted)
    expect(saved.decisions).toHaveLength(358)
    expect(saved.nodes).toHaveLength(300)
    expect(saved.audit?.source).toBe('gmail')
    expect(saved.actions.some(item => item.title === '离线整理材料')).toBe(true)
    expect(saved.actions.some(item => item.title === '另一设备整理岗位')).toBe(true)
    expect(server.commands.filter(item => item.client === 'first')).toHaveLength(1)
    // The same stale base cannot overwrite the action that the first device actually created.
    const staleConflict = await restarted.evaluate(async ({ backend, actionId }) => {
      const result = await fetch(`${backend}/api/workspace`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer owner-token' },
        body: JSON.stringify({ action: 'command', commandId: 'zmc09-conflicting-replay',
          baseRevision: 1005, command: { type: 'domain', value: {
            commandId: 'zmc09-conflicting-replay', kind: 'set_action_status', actionId, status: 'done',
          } } }),
      })
      return { status: result.status, outcome: (await result.json()).outcome }
    }, { backend: BACKEND, actionId: `accepted:${firstWrite.commandId}` })
    expect(staleConflict).toEqual({ status: 409, outcome: 'CONFLICT' })
    expect(server.commands).toHaveLength(2)
    await expect(restarted.locator('.tsui-status')).toHaveCount(0)
    expect(await restarted.locator('.tsui-task-panel .tsui-task-row').count()).toBeLessThanOrEqual(server.snapshot.data.actions.length)

    // An actual current web choice appears as one business question; old Gmail parser debt stays quiet.
    const current = denseDecision(999)
    current.id = 'current-owner-choice'
    current.createdAt = DENSE_NOW.toISOString()
    current.payloadBinding.inputId = 'current-owner-input'
    current.payloadBinding.source = { kind: 'web', sourceId: 'web', sourceRecordId: 'current-owner-input',
      observedAt: DENSE_NOW.toISOString(), assertedAt: DENSE_NOW.toISOString(), timezone: 'Asia/Shanghai' }
    current.payloadBinding.statementMode = 'current_intent'
    server.snapshot.data.opportunities[0].company = 'Choice company'
    server.snapshot.data.opportunities[1].company = 'Choice company'
    server.snapshot.data.opportunities[1].role = 'Analyst'
    current.payloadBinding.candidate.target = { company: 'Choice company' }
    current.choices = server.snapshot.data.opportunities.slice(0, 2).map(job => ({
      id: `opportunity:${job.id}`, label: `${job.company}｜${job.role}`,
      consequence: 'Only this opportunity will be updated.', resolution: { opportunityId: job.id },
    }))
    server.snapshot.data.decisionRequests?.push(current)
    server.revision += 1
    await restarted.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(restarted.locator('.tsui-task-row').filter({ hasText: '需要你决定' })).toHaveCount(1)
    await expect(restarted.locator('.tsui-status')).toHaveCount(0)
  } finally {
    await firstContext.close()
    await secondContext.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('Schedule cancellation stays server-confirmed when a local edit blocks projection', async ({ page }) => {
  await page.clock.setFixedTime(DENSE_NOW)
  const initial = workspace()
  initial.data.scheduleNodes = [{
    id: 'owner-cancel-node', occurrenceId: 'owner-cancel-occurrence', version: 1,
    opportunityId: 'A-opp-1', kind: 'interview', state: 'scheduled', constraintKind: 'employer_hard',
    temporal: { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai',
      date: '2026-10-20', resolutionBasis: 'source_explicit' },
    evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
    createdAt: DENSE_NOW.toISOString(), updatedAt: DENSE_NOW.toISOString(),
  }]
  let authoritative = initial
  let revision = 1004
  let commandCalls = 0
  let receiptCalls = 0
  let receipt: Record<string, unknown> | undefined
  await seedSession(page.context(), 'owner-account', 'owner-token')
  await page.route(`${BACKEND}/**`, async route => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    const path = new URL(request.url()).pathname
    if (path === '/api/health') return cors(route, health())
    if (path !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)
    const body = request.postDataJSON() as Record<string, any>
    const current = () => ({ workspaceId: 'owner-cancel', revision,
      workspaceVersion: `txn:${revision}`, schemaVersion: authoritative.version, snapshot: authoritative })
    if (body.action === 'read') return cors(route, current())
    if (body.action === 'receipt') {
      receiptCalls += 1
      return cors(route, { ...current(), found: Boolean(receipt), receipt })
    }
    if (body.action !== 'command') return cors(route, { code: 'UNEXPECTED_ACTION' }, 400)
    commandCalls += 1
    expect(body.command?.value).toMatchObject({ kind: 'cancel_occurrence', occurrenceId: 'owner-cancel-occurrence' })
    const applied = applyUserDomainCommand(authoritative, body.command.value)
    expect(applied.status).toBe('APPLIED')
    authoritative = applied.snapshot
    revision += 1
    receipt = { commandId: body.commandId, receiptId: `receipt:${body.commandId}`,
      status: 'COMMITTED', revision, result: { type: 'domain', status: 'APPLIED', summary: applied.summary } }
    // Race an unsynced browser edit into IndexedDB after the command leaves but before its snapshot projects.
    await page.evaluate(async () => {
      const db = await (await import('/pjsdas/src/db.ts')).dbPromise
      const existing = await db.get('actions', 'A-action-1')
      if (!existing) throw Error('Missing local action')
      await db.put('actions', { ...existing, title: '本机未同步的修改' })
    })
    return cors(route, { ...current(), outcome: 'COMMITTED', receipt })
  })

  await page.goto('/pjsdas/schedule')
  const row = page.locator('.tsui-schedule-row').filter({ hasText: 'A公司' })
  await expect(row).toHaveCount(1)
  await row.click()
  await page.locator('.tsui-schedule-command-buttons').getByRole('button', { name: /取消安排|Cancel occurrence/ }).click()
  await page.locator('.tsui-schedule-confirm').getByRole('button', { name: /确认|Confirm/ }).click()
  await expect(page.locator('.tsui-schedule-feedback')).toContainText(/服务器已确认，本机状态待安全刷新|server confirmed/i)
  await expect(page.locator('.tsui-schedule-feedback')).not.toContainText('UNKNOWN_COMMAND_OUTCOME')
  expect(commandCalls).toBe(1)
  expect(authoritative.data.scheduleNodes?.find(node => node.occurrenceId === 'owner-cancel-occurrence' && node.state === 'cancelled')).toBeTruthy()
  const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:owner-account') ?? '[]'))
  expect(pending).toMatchObject([{ commandId: receipt?.commandId, status: 'projection_pending' }])

  await page.reload()
  // Date-only cancellation has no invented occurrence instant; it remains
  // accessible in the undated section after durable optimistic restart.
  await page.getByRole('button', { name: /已发生|Past/, exact: true }).click()
  await page.getByRole('button', { name: /时间待定|Time TBD/ }).click()
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(page.getByText(/这次修改已保存，日程正在更新|change is saved; the schedule is updating/i)).toBeVisible()
  expect(commandCalls).toBe(1)
  expect(receiptCalls).toBeGreaterThan(0)
  const local = await localRows(page)
  expect(local.actions.find(item => item.id === 'A-action-1')?.title).toBe('本机未同步的修改')
})

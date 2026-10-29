import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { AUTH_KEY, BACKEND, session } from './fixtures/todayWorkspace.js'
import { installConsumerBrowserBootstrap } from '../tests/fixtures/consumerBrowserBootstrap.js'
import { guardMockApplicationRequests } from './support/mockApplicationRequests.js'
import type { consumerHttpFixture } from '../tests/sql/consumer-pg-http-fixture.mjs'
import { consumerCases, consumerStopFollowingCase, verifyConsumerSource } from '../tests/sql/consumer-pg-source.mjs'
import { sha, safeError, sourceImport } from '../tests/sql/workspace-rows-durable-v2-source.mjs'
import type { PJSDASSnapshot } from '../src/snapshot.js'

const browserOrigin = 'http://127.0.0.1:4176'
type Harness = Awaited<ReturnType<typeof consumerHttpFixture>>
async function state(page: Page, account: string) {
  return page.evaluate(async account => {
    const queue = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
    const db = await import('/pjsdas/src/db.ts')
    const pending = queue.listAccountPendingOperations(account)
    return { pending, records: await db.readCommandInteractions(account),
      actions: (await db.exportLocalSnapshot()).data.actions,
      nativeIDB: Object.prototype.toString.call(indexedDB), online: navigator.onLine }
  }, account)
}
async function bridge(context: BrowserContext, h: Harness) {
  const guard = await guardMockApplicationRequests(context)
  expect(BACKEND).toBe('https://todayaction-backend.invalid')
  // Synthetic login and one saved refresh preference, only at the app origin.
  // No workspace, checkpoint, pending operation, command ID or journal seed.
  await context.addInitScript(installConsumerBrowserBootstrap, {
    origin: browserOrigin, authKey: AUTH_KEY, session: session(h.account, h.accessToken),
  })
  await context.route(`${BACKEND}/**`, async route => {
    const request = route.request(), url = new URL(request.url())
    try {
      // Preserve method, original Origin/Authorization and exact request bytes.
      // Only the destination changes. Never synthesize a workspace/receipt.
      const response = await fetch(h.origin + url.pathname + url.search, { method: request.method(),
        headers: await request.allHeaders(), body: request.postDataBuffer() ?? undefined })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()) })
    } catch { await route.abort('failed') }
  })
  return guard
}
async function mount(page: Page, h: Harness, phase: (value: string) => void) {
  phase('mount-navigation')
  await page.goto('/pjsdas/today')
  phase('mount-task-button')
  await expect(page.locator('[data-action-id="consumer-task"] .tsui-done-action')).toBeEnabled()
  phase('mount-native-indexeddb')
  await expect.poll(async () => (await state(page, h.account)).nativeIDB).toBe('[object IDBFactory]')
  phase('mount-cache-origin-proof')
  await expect.poll(() => page.evaluate(async () => {
    const proof = await import('/pjsdas/src/cloud/mockCacheBoundary.ts')
    const sync = await import('/pjsdas/src/cloud/syncState.ts')
    return proof.canMountMockAccountCache(localStorage, sync.getCloudDeviceState)
  })).toBe(true)
}
async function freshPage(context: BrowserContext, old: Page) {
  await old.close()
  await context.setOffline(false)
  const next = await context.newPage()
  await next.goto('/pjsdas/today')
  return next
}
const commandRequests = (h: Harness) => h.requests.filter(request => ['command', 'undo'].includes(request.action))
async function assertSettled(h: Harness, page: Page, ids: string[], targetStatus: string) {
  // Navigation completion is not Auth/account adoption completion. Observe the
  // real page's resolved lease before any account-scoped journal reads; never
  // catch a lease error or invoke recovery to make the observation succeed.
  await expect.poll(() => page.evaluate(async account => {
    const lease = await import('/pjsdas/src/cloud/accountCacheLease.ts')
    return lease.isAccountCacheSessionResolved() && lease.currentAccountCacheSession() === account
  }, h.account)).toBe(true)
  await expect.poll(async () => (await state(page, h.account)).pending.length).toBe(0)
  const local = await state(page, h.account), rows = await h.ledger(), current = await h.current()
  expect(local.records.filter(record => ids.includes(record.commandId)).map(record => record.state)).toEqual(ids.map(() => 'confirmed'))
  expect(rows.map(row => row.command_id)).toEqual(ids)
  expect(current.revision).toBe(ids.length)
  expect(current.snapshot.data.actions.find(action => action.id === 'consumer-task')?.status).toBe(targetStatus)
  expect(local.actions.find(action => action.id === 'consumer-task')?.status).toBe(targetStatus)
  expect(current.snapshot.data.actions.find(action => action.id === 'unrelated-task')).toEqual(h.snapshot.data.actions.find(action => action.id === 'unrelated-task'))
  expect(commandRequests(h).map(request => request.commandId)).toEqual(ids)
  await h.assertNoLargeIntent()
  if (targetStatus === 'todo') await expect(page.locator('[data-action-id="consumer-task"] .tsui-done-action')).toBeEnabled()
  else await expect(page.locator('[data-action-id="consumer-task"]')).toHaveCount(0)
}

for (const label of consumerCases) test(label, async ({ page, context, browserName }) => {
  const source = verifyConsumerSource(), evidenceRoot = process.env.TA_CONSUMER_EVIDENCE
  expect(evidenceRoot).toBeTruthy()
  const directory = join(evidenceRoot!, label); await mkdir(directory)
  const report: Record<string, unknown> = { contract: 'consumer-ui-real-pg-recovery-v1', label,
    sourceCommit: source.commit, sourceTree: source.tree, prHead: source.prHeadSha, browserName,
    status: 'RUNNING', boundary: 'small-row UI command; synthetic identity; actual API/public PostgREST/PG',
    durableV2Admission: false, uiCreatedCommands: false, mountedConsumer: false,
    clockMocked: false, explicitRecoveryCalls: 0, automaticIntervalCertified: false }
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  let h: Harness | undefined, currentPage = page, primaryError: unknown
  const phase = (value: string) => { report.phase = value }
  const pageErrors: Array<{ name: string; observedPageDocument: string }> = []
  const observePageErrors = (owned: Page) => owned.on('pageerror', error => {
    // Delivery-time page URL only, not attribution of the error's source URL.
    const url = owned.url()
    const observedPageDocument = url === 'about:blank' ? 'initial-blank'
      : url.startsWith(browserOrigin + '/') ? 'consumer-origin' : 'other-origin'
    pageErrors.push({ name: ['SecurityError', 'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(error.name) ? error.name : 'OtherError', observedPageDocument })
  })
  context.on('page', observePageErrors)
  observePageErrors(page)
  try {
    phase('fixture-setup')
    const { consumerHttpFixture } = await import('../tests/sql/consumer-pg-http-fixture.mjs')
    h = await consumerHttpFixture(directory, browserOrigin)
    const guard = await bridge(context, h)
    await mount(page, h, phase)
    const beforeClicks = await state(page, h.account)
    expect(beforeClicks.pending).toEqual([])
    expect(beforeClicks.records).toEqual([])
    expect(await h.ledger()).toEqual([])
    report.mountedConsumer = true
    if (label === 'offline-ui-done-undo-new-page-auto-recovery') {
      phase('offline-ui-completion-and-undo')
      await context.setOffline(true)
      expect((await state(page, h.account)).online).toBe(false)
      await page.locator('[data-action-id="consumer-task"] .tsui-done-action').click()
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await expect.poll(async () => (await state(page, h!.account)).pending.length).toBe(2)
      const queued = await state(page, h.account)
      expect(queued.pending).toHaveLength(2)
      const done = queued.pending.find(item => item.action === 'command')!, undo = queued.pending.find(item => item.action === 'undo')!
      expect(done.command?.type).toBe('domain')
      expect(done.command?.value.kind).toBe('set_action_status')
      expect(undo.targetCommandId).toBe(done.commandId)
      expect(await h.ledger()).toEqual([]); expect(commandRequests(h)).toEqual([])
      report.uiCreatedCommands = true
      report.commandIdHashes = [sha(done.commandId), sha(undo.commandId)]
      currentPage = await freshPage(context, page)
      phase('new-page-command-and-undo-recovery')
      await assertSettled(h, currentPage, [done.commandId, undo.commandId], 'todo')
      report.newPageAutomaticRecovery = true
    } else {
      phase('lost-committed-ack')
      // Let the genuine initial 700 ms outbox timer finish while the queue is
      // empty. We never install a clock or call a recovery module function.
      await page.waitForTimeout(1500)
      await page.evaluate(() => {
        ;(window as any).consumerRecoveryTriggers = []
        for (const type of ['focus', 'online', 'visibilitychange']) window.addEventListener(type, event => {
          if (event.target === window || event.target === document) (window as any).consumerRecoveryTriggers.push(type)
        })
      })
      h.armLostAck()
      await page.locator('[data-action-id="consumer-task"] .tsui-done-action').click()
      await expect.poll(() => Boolean(h!.lostAck)).toBe(true)
      await expect.poll(() => h!.receiptFailures).toBeGreaterThan(0)
      const originalId = h.lostAck.commandId
      expect((await state(page, h.account)).pending.map(item => item.commandId)).toEqual([originalId])
      expect((await h.ledger()).map(row => row.command_id)).toEqual([originalId])
      report.uiCreatedCommands = true; report.commandIdHashes = [sha(originalId)]
      report.commitProvenBeforeAckLoss = h.lostAck.confirmedBeforeDisconnect
      if (label === 'lost-ack-new-page-auto-receipt') {
        phase('new-page-receipt-recovery')
        await page.close(); h.restoreReceiptTransport()
        currentPage = await context.newPage(); await currentPage.goto('/pjsdas/today')
        await assertSettled(h, currentPage, [originalId], 'done')
        report.newPageAutomaticRecovery = true
      } else {
        phase('real-interval-receipt-recovery')
        h.restoreReceiptTransport()
        await expect.poll(async () => (await state(page, h!.account)).pending.length, { timeout: 90_000 }).toBe(0)
        const elapsed = performance.now() - h.lostAck.at
        expect(elapsed).toBeGreaterThanOrEqual(50_000)
        expect(await page.evaluate(() => (window as any).consumerRecoveryTriggers)).toEqual([])
        await assertSettled(h, page, [originalId], 'done')
        report.automaticIntervalCertified = true; report.observedRecoveryElapsedMs = elapsed
      }
    }
    guard.assertNoUnexpectedRequests(); expect(pageErrors).toEqual([])
    await expect.poll(() => {
      const ancillary = h!.safeRequests().filter(request => request.path === '/api/automation-settings' && request.method === 'POST')
      return ancillary.length > 0 && ancillary.every(request => request.status === 401 && request.expectedAncillaryDenial)
    }).toBe(true)
    report.ancillaryAutomationRead = 'actual-api-auth-invalid-no-fixture-acl-expansion'
    expect(h.errors).toEqual([]); report.status = 'PASS'
  } catch (error) { primaryError = error; report.status = 'FAIL'; report.error = safeError(error); throw error }
  finally {
    const failures: unknown[] = []
    for (const close of [...context.pages().map(owned => async () => { await owned.close() }),
      async () => { if (h) { await h.close(); report.httpBridgeClosed = true } }, async () => { verifyConsumerSource() }]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length) { report.status = 'FAIL'; report.cleanupErrors = failures.map(safeError) }
    if (h) { report.transport = h.safeRequests(); report.transportErrors = h.errors }
    report.pageErrors = pageErrors
    await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n')
    if (failures.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...failures], 'Consumer case/cleanup/source verification failed')
  }
})

// Separate from the unchanged three outbox-recovery cases above: this closes
// the production AppV8 -> native domain delta -> original Undo chain, not a
// large-command reservation or another 60-second scheduler certification.
async function stopState(page: Page, account: string) {
  await expect.poll(() => page.evaluate(async account => {
    const path = '/pjsdas/src/cloud/accountCacheLease.ts'
    const lease = await import(path) as typeof import('../src/cloud/accountCacheLease.js')
    return lease.isAccountCacheSessionResolved() && lease.currentAccountCacheSession() === account
  }, account)).toBe(true)
  return page.evaluate(async account => {
    const dbPath = '/pjsdas/src/db.ts', clientPath = '/pjsdas/src/cloud/authoritativeCommandClient.ts'
    const db = await import(dbPath) as typeof import('../src/db.js')
    const client = await import(clientPath) as typeof import('../src/cloud/authoritativeCommandClient.js')
    return { snapshot: await db.exportLocalSnapshot(), records: await db.readCommandInteractions(account),
      pending: client.listAccountPendingOperations(account),
      locator: client.readAccountDraft(account, 'stop-following:consumer-stop-job'),
      nativeIDB: Object.prototype.toString.call(indexedDB), nativeLocks: Object.prototype.toString.call(navigator.locks) }
  }, account)
}
const jsonValue = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const byId = (rows: ReadonlyArray<{ id: string }>) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
function assertStopBusiness(actual: PJSDASSnapshot, initial: PJSDASSnapshot, abandoned: boolean) {
  const job = actual.data.opportunities.find(item => item.id === 'consumer-stop-job')!
  expect(job.participationStatus).toBe(abandoned ? 'abandoned' : 'active')
  expect(job.processStage).toBe('screening'); expect(job.currentStageLabel).toBe('筛选中')
  expect(actual.data.actions.find(item => item.id === 'consumer-stop-todo')?.status).toBe(abandoned ? 'skipped' : 'todo')
  expect(actual.data.actions.find(item => item.id === 'consumer-stop-doing')?.status).toBe(abandoned ? 'skipped' : 'doing')
  for (const id of ['consumer-stop-done', 'consumer-task', 'unrelated-task']) {
    expect(actual.data.actions.find(item => item.id === id)).toEqual(initial.data.actions.find(item => item.id === id))
  }
  expect(actual.data.opportunities.find(item => item.id === 'consumer-other-job')).toEqual(initial.data.opportunities.find(item => item.id === 'consumer-other-job'))
  expect(actual.data.processes).toEqual(initial.data.processes)
  expect(actual.data.processEvents).toEqual(initial.data.processEvents)
  for (const record of initial.data.timeline ?? []) expect(actual.data.timeline?.find(item => item.id === record.id)).toEqual(record)
}
function assertStopProjection(local: PJSDASSnapshot, authoritative: PJSDASSnapshot) {
  // IDB key order is not server collection order. Business rows, including
  // their real timestamps and retained history, must otherwise match exactly.
  for (const collection of ['opportunities', 'actions', 'processes', 'processEvents', 'timeline', 'scheduleNodes'] as const) {
    expect(jsonValue(byId(local.data[collection] ?? []))).toEqual(jsonValue(byId(authoritative.data[collection] ?? [])))
  }
}
function assertDeltaTransport(request: Harness['requests'][number], baseRevision: number, undo: boolean) {
  expect(request.status).toBe(200)
  expect(request.authorizationMatched).toBe(true); expect(request.originMatched).toBe(true)
  expect(request.projection).toMatchObject({ requestProjection: 'delta-v1', responseHasSnapshot: false,
    responseHasDelta: true, responseDeltaContract: 'delta-v1', responseBaseRevision: baseRevision,
    responseRevision: baseRevision + 1, receiptContractVersion: 5,
    receiptOperation: undo ? 'undo_command' : 'domain:abandon_opportunity' })
  expect(request.projection.deltaChangeCount).toBeGreaterThan(0)
}

test(consumerStopFollowingCase, async ({ page, context, browserName }) => {
  const source = verifyConsumerSource(), evidenceRoot = process.env.TA_CONSUMER_EVIDENCE
  expect(evidenceRoot).toBeTruthy()
  const directory = join(evidenceRoot!, consumerStopFollowingCase); await mkdir(directory)
  const report: Record<string, unknown> = { contract: 'consumer-ui-stop-following-real-pg-v1', label: consumerStopFollowingCase,
    sourceCommit: source.commit, sourceTree: source.tree, prHead: source.prHeadSha, browserName,
    status: 'RUNNING', boundary: 'full AppV8; small-row Stop/Undo; synthetic identity; actual API delta/public PostgREST/PG',
    durableV2Admission: false, uiCreatedCommands: false, mountedConsumer: false, clockMocked: false, explicitRecoveryCalls: 0 }
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  let h: Harness | undefined, primaryError: unknown
  const pageErrors: string[] = []
  const observe = (owned: Page) => owned.on('pageerror', error => pageErrors.push(['SecurityError', 'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(error.name) ? error.name : 'OtherError'))
  context.on('page', observe); observe(page)
  try {
    report.phase = 'fixture-setup'
    const { consumerHttpFixture } = await import('../tests/sql/consumer-pg-http-fixture.mjs')
    h = await consumerHttpFixture(directory, browserOrigin, 'stop-following')
    const guard = await bridge(context, h)
    const { applyUserDomainCommand, applyDomainCompensation } = await sourceImport('src/domainCommands.ts')
    const { upgradeSnapshotToLatest } = await sourceImport('src/snapshot.ts')
    const normalized = (value: PJSDASSnapshot) => jsonValue(upgradeSnapshotToLatest(value))
    await mount(page, h, value => { report.phase = value })
    report.mountedConsumer = true
    const initial = await stopState(page, h.account)
    expect(initial.pending).toEqual([]); expect(initial.records).toEqual([]); expect(initial.locator).toBe('')
    expect(initial.nativeIDB).toBe('[object IDBFactory]'); expect(initial.nativeLocks).toBe('[object LockManager]')
    expect((await h.current()).revision).toBe(0); expect(await h.ledger()).toEqual([])
    assertStopProjection(initial.snapshot, h.snapshot)
    await h.assertNoLargeResources()
    report.phase = 'real-library-route'
    await page.locator('.tsui-primary-nav').getByRole('button', { name: '岗位库', exact: true }).click()
    await page.locator('[data-job-filter="all"]').click()
    await page.locator('.tsui-job-open[data-opportunity-id="consumer-stop-job"]').click()
    await expect(page).toHaveURL(/\/pjsdas\/library\/consumer-stop-job$/)
    await expect(page.getByRole('button', { name: '不再跟进', exact: true })).toBeEnabled()
    // The explicit initial viewedAt is business data, not suppression of the
    // real job_viewed effect. Navigation itself must not seed a command.
    expect(commandRequests(h)).toEqual([]); expect(await h.ledger()).toEqual([])
    report.initialBusinessOnly = true
    report.phase = 'stop-original-delta'
    await page.getByRole('button', { name: '不再跟进', exact: true }).click()
    await expect(page.getByRole('button', { name: '撤销不再跟进', exact: true })).toBeEnabled()
    await expect.poll(async () => (await stopState(page, h!.account)).pending.length).toBe(0)
    const forwardLocal = await stopState(page, h.account), firstLedger = await h.ledger(), saved = await h.current()
    expect(firstLedger).toHaveLength(1); expect(saved.revision).toBe(1)
    const original = firstLedger[0], originalId = original.command_id
    expect(Number(original.resulting_revision)).toBe(1); expect(original.receipt.revision).toBe(1)
    expect(original.receipt).toMatchObject({ commandId: originalId, contractVersion: 5, status: 'COMMITTED', operation: 'domain:abandon_opportunity', undoAvailable: true })
    expect(original.compensation).toEqual({ operation: 'restore_participation', payload: { opportunityId: 'consumer-stop-job', participationStatus: 'active',
      actionStates: [{ actionId: 'consumer-stop-todo', status: 'todo' }, { actionId: 'consumer-stop-doing', status: 'doing' }] } })
    const expected = applyUserDomainCommand(h.snapshot, { commandId: originalId, kind: 'abandon_opportunity', opportunityId: 'consumer-stop-job' }, new Date(saved.snapshot.exportedAt))
    expect(expected.status).toBe('APPLIED'); expect(saved.snapshot).toEqual(normalized(expected.snapshot)); expect(original.compensation).toEqual(expected.compensation)
    expect(commandRequests(h)).toHaveLength(1); expect(commandRequests(h)[0].commandId).toBe(originalId)
    assertDeltaTransport(commandRequests(h)[0], 0, false)
    expect(JSON.parse(forwardLocal.locator)).toEqual({ version: 1, opportunityId: 'consumer-stop-job', commandId: originalId })
    const forwardRecord = forwardLocal.records.find(item => item.commandId === originalId)!
    expect(forwardLocal.records).toHaveLength(1)
    expect(forwardRecord).toMatchObject({ state: 'confirmed', serverRevision: 1,
      command: { commandId: originalId, kind: 'abandon_opportunity', opportunityId: 'consumer-stop-job' }, delta: original.receipt.projectionDelta })
    expect(forwardRecord.delta).toEqual(original.receipt.projectionDelta)
    assertStopBusiness(saved.snapshot, h.snapshot, true); assertStopProjection(forwardLocal.snapshot, saved.snapshot)
    await h.assertNoLargeResources()
    report.realDeltaForward = true; report.forwardRevision = 1; report.uiCreatedCommands = true
    report.phase = 'reload-original-snapshot-receipt'
    const beforeReload = h.requests.length
    await page.reload()
    await stopState(page, h.account)
    await expect(page.getByRole('button', { name: '撤销不再跟进', exact: true })).toBeEnabled()
    await expect.poll(() => h!.requests.slice(beforeReload).filter(request => request.action === 'receipt' && request.commandId === originalId
      && request.status === 200 && request.projection?.requestProjection === 'snapshot' && request.projection?.responseHasSnapshot === true).length).toBeGreaterThan(0)
    expect(commandRequests(h)).toHaveLength(1); expect(await h.ledger()).toEqual(firstLedger); expect(await h.current()).toEqual(saved)
    const reloaded = await stopState(page, h.account)
    expect(reloaded.pending).toEqual([]); expect(JSON.parse(reloaded.locator).commandId).toBe(originalId)
    expect(reloaded.records.find(item => item.commandId === originalId)?.command).toEqual(forwardRecord.command)
    assertStopProjection(reloaded.snapshot, saved.snapshot)
    report.reloadOriginalReceipt = true; report.reloadWriteCount = 0
    report.phase = 'original-undo-delta'
    await page.getByRole('button', { name: '撤销不再跟进', exact: true }).click()
    await expect(page.getByText('已撤销这次不再跟进。', { exact: true })).toBeVisible()
    await expect.poll(async () => (await stopState(page, h!.account)).pending.length).toBe(0)
    const finalLocal = await stopState(page, h.account), ledger = await h.ledger(), final = await h.current()
    expect(ledger).toHaveLength(2); expect(ledger[0]).toEqual(original); expect(final.revision).toBe(2)
    const undo = ledger[1], undoId = undo.command_id
    expect(Number(undo.resulting_revision)).toBe(2); expect(undo.receipt.revision).toBe(2)
    expect(undoId).not.toBe(originalId)
    expect(undo.receipt).toMatchObject({ commandId: undoId, contractVersion: 5, status: 'COMMITTED', operation: 'undo_command', undoOf: originalId })
    expect(undo.compensation).toBeNull()
    expect(final.snapshot).toEqual(normalized(applyDomainCompensation(saved.snapshot, original.compensation, new Date(final.snapshot.exportedAt))))
    expect(commandRequests(h)).toHaveLength(2); expect(commandRequests(h)[1]).toMatchObject({ action: 'undo', commandId: undoId, targetCommandId: originalId })
    assertDeltaTransport(commandRequests(h)[1], 1, true)
    expect(finalLocal.records).toHaveLength(2)
    expect(finalLocal.records.find(item => item.commandId === undoId)).toMatchObject({ state: 'confirmed', serverRevision: 2, targetCommandId: originalId, delta: undo.receipt.projectionDelta })
    expect(finalLocal.records.find(item => item.commandId === undoId)?.delta).toEqual(undo.receipt.projectionDelta)
    expect(JSON.parse(finalLocal.locator)).toEqual({ version: 1, opportunityId: 'consumer-stop-job', commandId: originalId, undoCommandId: undoId })
    assertStopBusiness(final.snapshot, h.snapshot, false); assertStopProjection(finalLocal.snapshot, final.snapshot)
    expect(final.snapshot.data.timeline).toEqual(saved.snapshot.data.timeline)
    report.largeResourceCounts = await h.assertNoLargeResources()
    report.realDeltaUndo = true; report.undoRevision = 2; report.originalUndoTarget = true
    report.nativeIdbProjection = true; report.businessAndRetainedFacts = true
    report.commandIdHashes = [sha(originalId), sha(undoId)]
    guard.assertNoUnexpectedRequests(); expect(context.serviceWorkers()).toEqual([]); expect(pageErrors).toEqual([])
    await expect.poll(() => h!.requests.filter(request => request.path === '/api/automation-settings' && request.method === 'POST').some(request => request.status === 401 && request.expectedAncillaryDenial)).toBe(true)
    expect(h.errors).toEqual([]); report.status = 'PASS'
  } catch (error) { primaryError = error; report.status = 'FAIL'; report.error = safeError(error); throw error }
  finally {
    const failures: unknown[] = []
    for (const close of [...context.pages().map(owned => async () => { await owned.close() }),
      async () => { if (h) { await h.close(); report.httpBridgeClosed = true } }, async () => { verifyConsumerSource() }]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length) { report.status = 'FAIL'; report.cleanupErrors = failures.map(safeError) }
    if (h) { report.transport = h.safeRequests(); report.transportErrors = h.errors }
    report.pageErrors = pageErrors
    await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n')
    if (failures.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...failures], 'Stop-following consumer case/cleanup/source verification failed')
  }
})

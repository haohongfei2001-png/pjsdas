import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { BACKEND, seedSession } from './fixtures/todayWorkspace.js'
import { guardMockApplicationRequests } from './support/mockApplicationRequests.js'
import type { consumerHttpFixture } from '../tests/sql/consumer-pg-http-fixture.mjs'
import { consumerCases, verifyConsumerSource } from '../tests/sql/consumer-pg-source.mjs'
import { sha, safeError } from '../tests/sql/workspace-rows-durable-v2-source.mjs'

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
  await seedSession(context, h.account, h.accessToken)
  // A saved local refresh preference only: no workspace, checkpoint, pending
  // operation, command ID, journal or receipt is injected into the browser.
  await context.addInitScript(() => {
    const key = 'pjsdas-google-drive-sync-state-v2'
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 2,
      deviceId: crypto.randomUUID(), autoSync: false, accounts: {} }))
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
  const pageErrors: string[] = []
  context.on('page', next => next.on('pageerror', error => pageErrors.push(error.name)))
  page.on('pageerror', error => pageErrors.push(error.name))
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
    await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n')
    if (failures.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...failures], 'Consumer case/cleanup/source verification failed')
  }
})

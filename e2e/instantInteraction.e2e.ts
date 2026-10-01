import { setupInstantServer as setup } from './fixtures/instantServer.js'
import { test, expect } from '@playwright/test'
import { INSTANT_NOW } from '../tests/fixtures/instantDenseWorkspace.js'

// Video encoding competes with the measured UI on small CI runners. Keep
// failure screenshots/traces and timing receipts without a live video encoder.
test.use({ timezoneId: 'Asia/Shanghai', video: 'off' })
test('dense capacity and completion settle before delayed server confirmation', async ({ page, context }, info) => {
  test.setTimeout(90_000)
  const server = await setup(context)
  await page.clock.setFixedTime(INSTANT_NOW)
  await page.goto('/pjsdas/today')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['instant-owner']?.lastSyncedVersion)).toBe('txn:1204')
  await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
  await page.evaluate(() => { (window as any).interactionMeasures = []; window.addEventListener('pjsdas:interaction-measure', event => (window as any).interactionMeasures.push((event as CustomEvent).detail)) })
  await page.locator('.tsui-capacity summary').click()
  await page.getByRole('spinbutton', { name: '今天可用小时' }).fill('6')
  // Use a changed value; an already-current preference cannot prove a save.
  await page.getByRole('spinbutton', { name: '今天可用小时' }).fill('5')
  const capacityMs = await page.evaluate(async () => {
    const started = performance.now()
    ;(document.querySelector('.tsui-capacity button[type=submit]') as HTMLButtonElement).click()
    while (!document.querySelector('.tsui-capacity summary')?.textContent?.includes('5 小时') && performance.now() - started < 5000) await new Promise(requestAnimationFrame)
    return performance.now() - started
  })
  expect(capacityMs).toBeLessThanOrEqual(150)
  const completeMs = await page.evaluate(async () => {
    const started = performance.now()
    ;(document.querySelector('[data-action-id="dense-action-0"] .tsui-done-action') as HTMLButtonElement).click()
    while (document.querySelector('[data-action-id="dense-action-0"]') && performance.now() - started < 5000) await new Promise(requestAnimationFrame)
    return performance.now() - started
  })
  expect(completeMs).toBeLessThanOrEqual(150)
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeVisible()
  await expect.poll(() => server.sent.length).toBe(2)
  await expect.poll(() => server.snapshot.data.actions[0].status, { timeout: 15000 }).toBe('done')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]').length), { timeout: 15000 }).toBe(0)
  expect(Math.max(...server.payloadBytes)).toBeLessThan(150000)
  const measured = await page.evaluate(() => (window as any).interactionMeasures)
  for (const phase of ['durable-outbox', 'indexeddb-write', 'today-selector', 'schedule-selector', 'network-confirmation']) expect(measured.some((item: any) => item.phase === phase)).toBe(true)
  await info.attach('dense-interaction-stages.json', { body: JSON.stringify({ capacityMs, completeMs, measured, serverExecutionMs: server.serverExecutionMs, payloadBytes: server.payloadBytes }, null, 2), contentType: 'application/json' })
  await page.reload()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
  await expect(page.locator('.tsui-capacity summary')).toContainText('5 小时')
})


async function start(page: import('@playwright/test').Page) {
  await page.clock.setFixedTime(INSTANT_NOW)
  await page.goto('/pjsdas/today')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['instant-owner']?.lastSyncedVersion)).toBe('txn:1204')
}
async function pendingCount(page: import('@playwright/test').Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]').length)
}

for (const failure of ['journal-read', 'account-change', 'read-and-archive'] as const) test(`pre-projection ${failure} never replays a failed click after reopen`, async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50)
  await start(page)
  const result = await page.evaluate(async failure => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    const accounts = await import('/pjsdas/src/cloud/accountCacheLease.ts')
    const snapshot = await api.exportLocalSnapshot()
    const getAll = IDBIndex.prototype.getAll, put = IDBObjectStore.prototype.put
    let armed = true
    IDBIndex.prototype.getAll = function(...args: Parameters<IDBIndex['getAll']>) {
      if (this.name === 'by-account-state' && armed) {
        armed = false
        if (failure === 'account-change') accounts.setAccountCacheSession('different-account')
        else throw new Error('Synthetic journal read failure')
      }
      return getAll.apply(this, args)
    }
    if (failure === 'read-and-archive') IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'commandInteractions') throw new Error('Synthetic archive unavailable')
      return put.apply(this, args)
    }
    const commandId = `instant-action:failed-${failure}`
    let failed = false
    try { await client.beginInstantCommand('instant-owner', snapshot, { commandId, kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' }) }
    catch { failed = true }
    finally { IDBIndex.prototype.getAll = getAll; IDBObjectStore.prototype.put = put; accounts.setAccountCacheSession('instant-owner') }
    const mirrored = JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]')
    await client.recoverInstantInteraction('instant-owner', commandId)
    return { failed, mirrored: mirrored.map((item: any) => ({ commandId: item.commandId, status: item.status })),
      status: (await (await api.dbPromise).get('actions', 'dense-action-0'))!.status,
      archiveState: (await api.readCommandInteraction('instant-owner', commandId))?.state }
  }, failure)
  expect(result.failed).toBe(true)
  expect(result.status).toBe('todo')
  if (failure === 'read-and-archive') expect(result.mirrored).toEqual([{ commandId: `instant-action:failed-${failure}`, status: 'conflict' }])
  else { expect(result.mirrored).toEqual([]); expect(result.archiveState).toBe('rejected') }
  expect(server.sent).toEqual([])
  await page.reload()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
  expect(server.sent).toEqual([])
})

test('immediate Undo preserves original audit and compensates after its delayed receipt', async ({ page, context }) => {
  test.setTimeout(90_000)
  const server = await setup(context)
  server.setDelay(1500)
  server.setNow(new Date(INSTANT_NOW.getTime() + 1000))
  await start(page)
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
  await expect.poll(() => server.sent.length).toBe(2)
  await expect.poll(() => pendingCount(page), { timeout: 15000 }).toBe(0)
  expect(server.snapshot.data.actions[0].status).toBe('todo')
  expect(server.snapshot.data.timeline!.length).toBeGreaterThanOrEqual(3941)
  const localNodes = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data.scheduleNodes)
  expect(localNodes?.find(node => node.id === 'schedule:action:dense-action-0:v1')?.sourceVersionRefs).toEqual(server.snapshot.data.scheduleNodes?.find(node => node.id === 'schedule:action:dense-action-0:v1')?.sourceVersionRefs)

  await page.reload()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
})

test('definitive rejection rolls back only its own change and retains command provenance', async ({ page, context }) => {
  const server = await setup(context)
  server.setDelay(50)
  await start(page)
  server.denyNext()
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: '这次修改未被接受' })).toBeVisible()
  const records = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).readCommandInteractions('instant-owner')))
  expect(records.some((record: any) => record.state === 'rejected' && record.command?.actionId === 'dense-action-0')).toBe(true)
  expect(await pendingCount(page)).toBe(0)
})

test('known rejection with unavailable rollback archive never becomes a replayable unknown command', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(700)
  await start(page); server.denyNext()
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    ;(window as any).restoreArchive = () => { IDBObjectStore.prototype.put = put }
    IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'commandInteractions') throw new Error('Synthetic rollback archive unavailable')
      return put.apply(this, args)
    }
  })
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]')[0]?.status)).toBe('conflict')
  await page.evaluate(async () => {
    ;(window as any).restoreArchive()
    const pending = JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]')[0]
    await (await import('/pjsdas/src/cloud/instantCommandClient.ts')).recoverInstantInteraction('instant-owner', pending.commandId)
  })
  expect(server.sent).toHaveLength(1)
  expect(server.snapshot.data.actions[0].status).toBe('todo')
  await page.reload()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]')[0]?.status)).toBe('conflict')
  expect(server.sent).toHaveLength(1)
})

test('lost acknowledgement recovers receipt after reload without repeating the business command', async ({ page, context }) => {
  test.setTimeout(90_000)
  const server = await setup(context)
  server.setDelay(50)
  await start(page)
  server.loseNextResponse()
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await expect.poll(() => server.snapshot.data.actions[0].status).toBe('done')
  await page.reload()
  await expect.poll(() => pendingCount(page), { timeout: 20000 }).toBe(0)
  expect(server.sent).toHaveLength(1)
  await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
})

test('offline completion persists through reload and receipt-absent reconnect sends the original identity once', async ({ page, context }) => {
  test.setTimeout(90_000)
  const server = await setup(context)
  server.setDelay(50)
  await start(page)
  await context.addInitScript(() => { if (localStorage.getItem('instant-offline') === 'true') Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }) })
  await page.evaluate(() => { localStorage.setItem('instant-offline', 'true'); Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }) })
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
  const commandId = await page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner')!)[0].commandId)
  expect(server.sent).toHaveLength(0)
  await page.reload()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
  expect(await pendingCount(page)).toBe(1)
  await page.evaluate(() => { localStorage.removeItem('instant-offline'); Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')) })
  await expect.poll(() => pendingCount(page), { timeout: 15000 }).toBe(0)
  expect(server.sent).toEqual([commandId])
  expect(server.snapshot.data.actions[0].status).toBe('done')
})

test('independent Gmail update during optimistic completion recovers the revision gap without losing audit', async ({ page, context }) => {
  const server = await setup(context)
  server.setDelay(500)
  await start(page)
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  server.backgroundGmail()
  await expect.poll(() => pendingCount(page)).toBe(0)
  await expect.poll(() => page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).dbPromise).get('timeline', 'instant-gmail-audit'))).toBeTruthy()
  expect(server.sent).toHaveLength(1)
  await page.reload()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
})

test('a genuine local field edit blocks confirmed projection and is never overwritten', async ({ page, context }) => {
  const server = await setup(context)
  server.setDelay(1000)
  await start(page)
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await page.evaluate(async () => {
    const db = await (await import('/pjsdas/src/db.ts')).dbPromise
    const action = await db.get('actions', 'dense-action-0')
    await db.put('actions', { ...action!, status: 'skipped', updatedAt: '2026-10-01T02:00:00Z' })
  })
  await expect.poll(() => server.snapshot.data.actions[0].status).toBe('done')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]')[0]?.status)).toBe('projection_pending')
  expect(await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).dbPromise).get('actions', 'dense-action-0').then(action => action?.status))).toBe('skipped')
  expect(server.sent).toHaveLength(1)
})

for (const operation of ['complete', 'cancel', 'reschedule'] as const) {
  test(`dense schedule ${operation} settles before delayed confirmation`, async ({ page, context }) => {
    test.setTimeout(60_000)
    const server = await setup(context)
    server.setDelay(1500)
    await start(page)
    await page.getByRole('button', { name: '日程', exact: true }).click()
    await page.locator('[data-schedule-entry="node:dense-node-0"]').click()
    await page.getByRole('button', { name: operation === 'complete' ? '确认完成' : operation === 'cancel' ? '取消安排' : '改期', exact: true }).click()
    if (operation === 'reschedule') await page.locator('.tsui-schedule-detail input').fill('2026-10-02T22:30')
    const elapsed = await page.evaluate(async () => {
      const start = performance.now()
      const confirm = [...document.querySelectorAll<HTMLButtonElement>('.tsui-schedule-detail button')].find(button => button.textContent === '确认' || button.textContent === '确认改期')!
      confirm.click()
      while (document.querySelector('.tsui-schedule-detail') && performance.now() - start < 5000) await new Promise(requestAnimationFrame)
      return performance.now() - start
    })
    expect(elapsed).toBeLessThanOrEqual(150)
    await expect.poll(() => pendingCount(page)).toBe(0)
    expect(server.sent).toHaveLength(1)
    const node = server.snapshot.data.scheduleNodes!.filter(item => item.occurrenceId === 'application-deadline:dense-job-0').sort((a, b) => b.version - a.version)[0]
    if (operation === 'reschedule') expect(node.temporal.deadlineAt).toBe('2026-10-02T14:30:00.000Z')
    else expect(node.state).toBe(operation === 'complete' ? 'completed' : 'cancelled')
  })
}


test('unchanged explicit capacity confirms without leaving a permanent outbox entry', async ({ page, context }) => {
  const server = await setup(context)
  server.snapshot.data.timePlanning!.dateOverrides = { '2026-10-01': 360 }
  await start(page)
  await page.locator('.tsui-capacity summary').click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.tsui-capacity')).not.toHaveAttribute('open', '')
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toHaveLength(1)
})

test('rejected earlier capacity unwinds dependent optimistic edits to the confirmed baseline', async ({ page, context }) => {
  const server = await setup(context)
  server.setDelay(1000)
  await start(page)
  server.denyNext()
  for (const hours of ['5', '4']) {
    await page.locator('.tsui-capacity summary').click()
    await page.getByRole('spinbutton', { name: '今天可用小时' }).fill(hours)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.tsui-capacity summary')).toContainText(`${hours} 小时`)
  }
  await expect.poll(() => pendingCount(page)).toBe(0)
  await expect(page.locator('.tsui-capacity summary')).toContainText('6 小时')
  expect(server.sent).toHaveLength(1)
})

test('application submitted immediately settles the exact action and process', async ({ page, context }) => {
  const server = await setup(context)
  server.setDelay(1000)
  await start(page)
  await expect(page.locator('[data-action-id="apply:dense-job-2"] .tsui-done-action')).toBeVisible()
  const duration = await page.evaluate(async () => {
    const started = performance.now()
    ;(document.querySelector('[data-action-id="apply:dense-job-2"] .tsui-done-action') as HTMLButtonElement).click()
    while (document.querySelector('[data-action-id="apply:dense-job-2"]') && performance.now() - started < 5000) await new Promise(requestAnimationFrame)
    return performance.now() - started
  })
  expect(duration).toBeLessThanOrEqual(150)
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.snapshot.data.actions[2].status).toBe('done')
  expect(server.snapshot.data.opportunities[2].processStage).toBe('screening')
  expect(server.snapshot.data.processes.find(process => process.opportunityId === 'dense-job-2')?.stage).toBe('screening')
})

test('submission Undo retains a newly created process and confirms without full recovery', async ({ page, context }) => {
  const server = await setup(context)
  server.snapshot.data.processes = server.snapshot.data.processes.filter(process => process.opportunityId !== 'dense-job-2')
  server.setDelay(250)
  server.setNow(new Date(INSTANT_NOW.getTime() + 1000))
  await start(page)
  await page.locator('[data-action-id="apply:dense-job-2"] .tsui-done-action').click()
  await expect.poll(() => pendingCount(page)).toBe(0)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.locator('[data-action-id="apply:dense-job-2"]')).toBeVisible()
  const optimistic = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data.processes.find(process => process.opportunityId === 'dense-job-2'))
  expect(optimistic).toMatchObject({ stage: 'not_applied', progress: 'not_started' })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(new Set(server.sent).size).toBe(2)
  const records = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).readCommandInteractions('instant-owner')))
  expect(records.every(record => record.state === 'confirmed')).toBe(true)
  const local = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()))
  expect(local.data.processes.find(process => process.opportunityId === 'dense-job-2')).toEqual(server.snapshot.data.processes.find(process => process.opportunityId === 'dense-job-2'))
  expect(local.data.timeline!.length).toBeGreaterThanOrEqual(3941)
  await page.reload()
  await expect(page.locator('[data-action-id="apply:dense-job-2"]')).toBeVisible()
  expect(server.sent).toHaveLength(2)
})


test('Undo journal crash before local transaction recovers the original identity', async ({ page, context }) => {
  const server = await setup(context)
  server.setDelay(50)
  await start(page)
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await expect.poll(() => pendingCount(page)).toBe(0)
  const undoId = 'instant-undo:crash-before-local-transaction'
  await page.evaluate(async undoId => {
    const records = await (await import('/pjsdas/src/db.ts')).readCommandInteractions('instant-owner')
    const target = records.find(item => item.command?.kind === 'set_action_status')!
    ;(await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')).journalConnectedInteraction('instant-owner', {
      commandId: undoId, targetCommandId: target.commandId, baseRevision: target.serverRevision!,
    })
  }, undoId)
  await page.reload()
  await expect.poll(() => pendingCount(page), { timeout: 20000 }).toBe(0)
  await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
  expect(server.sent).toHaveLength(2)
  expect(server.sent[1]).toBe(undoId)
})

test('confirmed blocked projection recovers with a read-only snapshot after equivalence returns', async ({ page, context }) => {
  const server = await setup(context)
  server.setDelay(700)
  await start(page)
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await page.evaluate(async () => {
    const db = await (await import('/pjsdas/src/db.ts')).dbPromise
    const row = await db.get('actions', 'dense-action-0')
    ;(window as any).originalAction = row
    await db.put('actions', { ...row!, status: 'skipped' })
  })
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]')[0]?.status)).toBe('projection_pending')
  await page.evaluate(async () => { const db = await (await import('/pjsdas/src/db.ts')).dbPromise; await db.put('actions', (window as any).originalAction) })
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts')
    const original = (await api.readCommandInteractions('instant-owner')).find(item => item.state === 'projection_pending')!
    await (await import('/pjsdas/src/cloud/instantCommandClient.ts')).recoverInstantInteraction('instant-owner', original.commandId)
  })
  await expect.poll(() => pendingCount(page), { timeout: 20000 }).toBe(0)
  const checkpoint = await page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2')!).accounts['instant-owner'])
  expect(checkpoint.lastSyncedVersion).toBe('txn:1205')
  expect(checkpoint.lastSyncedFingerprint).toMatch(/^[0-9a-f]{64}$/)
  expect(checkpoint.lastReadProjectionSourceFingerprint).toBe(checkpoint.lastSyncedFingerprint)
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts')
    await (await import('/pjsdas/src/cloud/instantCommandClient.ts')).beginInstantCommand('instant-owner', await api.exportLocalSnapshot(),
      { commandId: 'instant-action:after-safe-recovery', kind: 'set_action_status', actionId: 'dense-action-0', status: 'todo' })
  })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.baseRevisions).toEqual([1204, 1205])
  expect(server.sent).toHaveLength(2)
  await page.reload()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
})


test('explicit unchanged local capacity still updates a newer authoritative preference', async ({ page, context }) => {
  const server = await setup(context)
  server.snapshot.data.timePlanning!.dateOverrides = { '2026-10-01': 360 }
  server.setDelay(50)
  await start(page)
  server.snapshot.data.timePlanning!.dateOverrides = { '2026-10-01': 420 }
  await page.locator('.tsui-capacity summary').click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toHaveLength(1)
  expect(server.snapshot.data.timePlanning!.dateOverrides?.['2026-10-01']).toBe(360)
  await page.reload()
  await expect(page.locator('.tsui-capacity summary')).toContainText('6 小时')
})


test('three optimistic edits retain latest intent through acknowledgements in dependency order', async ({ page, context }) => {
  const server = await setup(context)
  server.setDelay(1500)
  await start(page)
  // Deliberately reverse IndexedDB primary-key order at an identical clock time.
  await page.evaluate(() => { let sequence = 9; Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => `00000000-0000-4000-8000-00000000000${sequence--}` }) })
  for (const hours of ['5', '4', '3']) {
    await page.locator('.tsui-capacity summary').click()
    await page.getByRole('spinbutton', { name: '今天可用小时' }).fill(hours)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.tsui-capacity summary')).toContainText(`${hours} 小时`)
  }
  await expect.poll(() => pendingCount(page), { timeout: 10000 }).toBe(2)
  await expect(page.locator('.tsui-capacity summary')).toContainText('3 小时')
  await expect.poll(() => pendingCount(page), { timeout: 15000 }).toBe(0)
  expect(server.sent).toHaveLength(3)
  expect(server.snapshot.data.timePlanning!.dateOverrides?.['2026-10-01']).toBe(180)
  await page.reload()
  await expect(page.locator('.tsui-capacity summary')).toContainText('3 小时')
})


for (const status of [401, 403]) test(`authentication ${status} retains durable intent and retries the same identity`, async ({ page, context }) => {
  const server = await setup(context)
  server.setDelay(50)
  await start(page)
  server.denyNext(status)
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: status === 401 ? '登录已过期' : '账号访问暂不可用' })).toBeVisible()
  expect(await pendingCount(page)).toBe(1)
  const id = server.sent[0]
  expect(server.snapshot.data.actions[0].status).toBe('todo')
  await page.reload()
  await expect.poll(() => pendingCount(page), { timeout: 15000 }).toBe(0)
  expect(server.sent).toEqual([id, id])
  expect(server.snapshot.data.actions[0].status).toBe('done')
})

test('unrelated rejected capacity preserves a completed task Undo control', async ({ page, context }) => {
  const server = await setup(context)
  server.setDelay(100)
  await start(page)
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await expect.poll(() => pendingCount(page)).toBe(0)
  server.denyNext()
  await page.locator('.tsui-capacity summary').click()
  await page.getByRole('spinbutton', { name: '今天可用小时' }).fill('5')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.tsui-interaction-notice')).toContainText('这次修改未被接受')
  await page.locator('.action-undo-toast button').click()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.snapshot.data.actions[0].status).toBe('todo')
})

test('verified proof compaction retains original journals and audit and refuses genuine local edits', async ({ page, context }) => {
  const server = await setup(context)
  server.setDelay(50)
  await start(page)
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await expect.poll(() => pendingCount(page)).toBe(0)
  const result = await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), db = await api.dbPromise
    const originalJournal = await api.readCommandInteractions('instant-owner')
    const timelineBefore = await db.count('timeline')
    const tx = db.transaction('projectionDeltas', 'readwrite')
    for (let index = 0; index < 64; index++) await tx.store.add({ accountKey: 'instant-owner', delta: { contract: 'delta-v1', baseRevision: 1205, changes: [] } })
    await tx.done
    const local = await api.exportLocalSnapshot()
    // A proven baseline is independent of unique-ID collection order, before
    // and after compaction. Reverse the captured order to exercise both paths.
    local.data.actions.reverse()
    local.data.scheduleNodes!.reverse()
    const verified = await api.isRecordedAccountProjection('instant-owner', local, { compact: true })
    const after = await db.count('projectionDeltas')
    const stillVerified = await api.isRecordedAccountProjection('instant-owner', await api.exportLocalSnapshot())
    const journalRetained = JSON.stringify(originalJournal) === JSON.stringify(await api.readCommandInteractions('instant-owner'))
    const timelineRetained = timelineBefore === await db.count('timeline')
    const action = await db.get('actions', 'dense-action-0')
    await db.put('actions', { ...action!, title: 'Genuine independent local edit' })
    const genuineEditVerified = await api.isRecordedAccountProjection('instant-owner', await api.exportLocalSnapshot(), { compact: true })
    return { verified, after, stillVerified, journalRetained, timelineRetained, genuineEditVerified }
  })
  expect(result).toEqual({ verified: true, after: 0, stillVerified: true, journalRetained: true, timelineRetained: true, genuineEditVerified: false })
})

test('capacity Undo retains newly materialized preferences with authoritative compensation semantics', async ({ page, context }) => {
  const server = await setup(context)
  delete server.snapshot.data.timePlanning
  server.setDelay(50)
  await start(page)
  const result = await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    const commandId = 'instant-capacity:new-preferences'
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId, kind: 'set_date_capacity', date: '2026-10-01', minutes: 360 })
    return commandId
  })
  await expect.poll(() => pendingCount(page)).toBe(0)
  await page.evaluate(async commandId => {
    await (await import('/pjsdas/src/cloud/instantCommandClient.ts')).beginInstantUndo('instant-owner', commandId, await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot())
  }, result)
  await expect.poll(() => pendingCount(page)).toBe(0)
  const local = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()))
  expect(local.data.timePlanning).toEqual(server.snapshot.data.timePlanning)
  expect(local.data.timePlanning).toMatchObject({ version: 1, dateOverrides: {} })
  expect(server.sent).toHaveLength(2)
})


test('account boundary quarantines retained provenance and exports only the active account', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50)
  await start(page)
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await expect.poll(() => pendingCount(page)).toBe(0)
  const result = await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts')
    const accounts = await import('/pjsdas/src/cloud/accountCacheLease.ts')
    const confirmed = (await api.readCommandInteractions('instant-owner'))[0]
    await api.saveCommandInteraction({ ...confirmed, id: 'instant-owner:unresolved-intent', commandId: 'unresolved-intent', state: 'active' })
    const before = await api.readCommandInteractions('instant-owner')
    accounts.setAccountCacheSession('different-account')
    await api.clearLocalWorkspaceCache()
    const other = await api.exportLocalRecoveryArchive()
    let denied = false
    try { await api.readCommandInteractions('instant-owner') } catch { denied = true }
    accounts.setAccountCacheSession(undefined)
    const anonymous = await api.exportLocalRecoveryArchive()
    accounts.setAccountCacheSession('instant-owner')
    const after = await api.readCommandInteractions('instant-owner')
    const owner = await api.exportLocalRecoveryArchive()
    return { otherCount: other.stores.commandInteractions.length, anonymousCount: anonymous.stores.commandInteractions.length,
      proofCount: owner.stores.projectionDeltas.length, denied, retained: JSON.stringify(before) === JSON.stringify(after), ownerCount: owner.stores.commandInteractions.length }
  })
  expect(result).toEqual({ otherCount: 0, anonymousCount: 0, proofCount: 0, denied: true, retained: true, ownerCount: 2 })
})

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

test('known rejection with unavailable rollback archive stays untrusted and safely rolls back without replay', async ({ page, context }) => {
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
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]')[0]?.status)).toBe('rollback_pending')
  const untrusted = await page.evaluate(async () => {
    const db = await import('/pjsdas/src/db.ts')
    const proof = await db.isRecordedAccountProjection('instant-owner', await db.exportLocalSnapshot())
    const refresh = await (await import('/pjsdas/src/cloud/authoritativeReadModelClient.ts')).refreshConnectedAuthoritativeCache('instant-owner')
    return { proof, state: refresh.state }
  })
  expect(untrusted).toEqual({ proof: false, state: 'pending_operations' })
  await page.evaluate(() => (window as any).restoreArchive())
  await page.reload()
  await expect.poll(() => pendingCount(page)).toBe(0)
  await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
  expect(server.sent).toHaveLength(1)
  expect(server.snapshot.data.actions[0].status).toBe('todo')
})

test('repeated complete and Undo chain settles transitive dependencies after reconnect', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50)
  await start(page)
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }))
  for (let i = 0; i < 2; i++) {
    await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
    await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
  }
  expect(await pendingCount(page)).toBe(4)
  await page.evaluate(async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    await (await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')).replayAccountPendingOperations('instant-owner')
  })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toHaveLength(4)
  expect(new Set(server.sent).size).toBe(4)
  expect(server.snapshot.data.actions[0].status).toBe('todo')
  await page.reload(); await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
})

test('confirmed parent retries compact projection after one failed write without blocking its queued child', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50)
  await start(page)
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    for (const [commandId, minutes] of [['capacity-parent', 300], ['capacity-child', 240]] as const)
      await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId, kind: 'set_date_capacity', date: '2026-10-01', minutes })
    const put = IDBObjectStore.prototype.put; let armed = true
    IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'commandInteractions' && (args[0] as any).state === 'confirmed' && armed) { armed = false; throw new Error('Synthetic first acknowledgement write failure') }
      return put.apply(this, args)
    }
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    try {
      await client.recoverInstantInteraction('instant-owner', 'capacity-parent')
      if ((await api.readCommandInteraction('instant-owner', 'capacity-parent'))?.state !== 'projection_pending') throw new Error('Missing injected projection failure')
      await client.recoverInstantInteraction('instant-owner', 'capacity-parent')
      await client.recoverInstantInteraction('instant-owner', 'capacity-child')
    } finally { IDBObjectStore.prototype.put = put }
  })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toEqual(['capacity-parent', 'capacity-child'])
  expect(server.snapshot.data.timePlanning?.dateOverrides?.['2026-10-01']).toBe(240)
  await page.reload(); await expect(page.locator('.tsui-capacity summary')).toContainText('4 小时')
})

test('rejected child restores the confirmed parent server fields instead of its optimistic preimage', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(700); server.setNow(new Date(INSTANT_NOW.getTime() + 1000))
  await start(page)
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'accepted-parent', kind: 'set_date_capacity', date: '2026-10-01', minutes: 300 })
  })
  await page.clock.setFixedTime(new Date(INSTANT_NOW.getTime() + 2000))
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'denied-child', kind: 'set_date_capacity', date: '2026-10-01', minutes: 240 })
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    ;(window as any).replay = (await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')).replayAccountPendingOperations('instant-owner')
  })
  await expect.poll(() => server.sent.length).toBe(1)
  server.denyNext()
  await page.evaluate(() => (window as any).replay)
  await expect.poll(() => pendingCount(page)).toBe(0)
  const local = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data.timePlanning)
  expect(local).toEqual(server.snapshot.data.timePlanning)
  await page.reload(); await expect(page.locator('.tsui-capacity summary')).toContainText('5 小时')
  expect(server.sent).toEqual(['accepted-parent', 'denied-child'])
})

test('quarantined predecessor rejects a later dependent and resumes safe rollback when reads return', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50)
  await start(page); server.denyNext()
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    for (const [commandId, minutes] of [['reject-parent', 300], ['reject-child', 240]] as const)
      await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId, kind: 'set_date_capacity', date: '2026-10-01', minutes })
    const getAll = IDBIndex.prototype.getAll; let armed = true
    IDBIndex.prototype.getAll = function(...args: Parameters<IDBIndex['getAll']>) {
      if (this.name === 'by-account-state' && armed) { armed = false; throw new Error('Synthetic rejection journal read failure') }
      return getAll.apply(this, args)
    }
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    try { await client.recoverInstantInteraction('instant-owner', 'reject-parent') } finally { IDBIndex.prototype.getAll = getAll }
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'reject-later', kind: 'set_date_capacity', date: '2026-10-01', minutes: 540 })
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    await client.recoverInstantInteraction('instant-owner', 'reject-later')
    await client.recoverInstantInteraction('instant-owner', 'reject-parent')
    await client.recoverInstantInteraction('instant-owner', 'reject-child')
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'safe-next', kind: 'set_date_capacity', date: '2026-10-01', minutes: 480 })
  })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toEqual(['reject-parent', 'safe-next'])
  await expect(page.locator('.tsui-capacity summary')).toContainText('8 小时')
})

for (const kind of ['command', 'undo'] as const) test(`receipt-first ${kind} crash reservation hydrates only a proven cleared cache`, async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50)
  await start(page)
  if (kind === 'undo') {
    await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
    await expect.poll(() => pendingCount(page)).toBe(0)
  }
  await page.evaluate(async kind => {
    const api = await import('/pjsdas/src/db.ts'), auth = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
    const target = kind === 'undo' ? (await api.readCommandInteractions('instant-owner')).find(item => item.state === 'confirmed') : undefined
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    auth.journalConnectedInteraction('instant-owner', { commandId: `cleared-${kind}`, baseRevision: 1204,
      ...(target ? { targetCommandId: target.commandId } : { command: { type: 'domain', value: { commandId: `cleared-${kind}`, kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' } } }) })
    const local = await api.exportLocalSnapshot()
    const data: any = { ...local.data }
    for (const key of Object.keys(data)) data[key] = Array.isArray(data[key]) ? [] : undefined
    await api.replaceLocalSnapshotFromCloud({ ...local, data })
    const empty = await api.exportLocalSnapshot()
    const fingerprint = await (await import('/pjsdas/src/cloud/workspaceFingerprint.ts')).fingerprintWorkspace(empty)
    ;(await import('/pjsdas/src/cloud/syncState.ts')).patchAccountCheckpoint('instant-owner', { clearedCacheFingerprint: fingerprint })
  }, kind)
  await page.reload()
  await expect.poll(() => pendingCount(page), { timeout: 20000 }).toBe(0)
  expect(server.sent.at(-1)).toBe(`cleared-${kind}`)
  expect(server.sent).toHaveLength(kind === 'undo' ? 2 : 1)
  expect(server.snapshot.data.actions[0].status).toBe(kind === 'undo' ? 'todo' : 'done')
  if (kind === 'undo') await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
  else await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
})

test('failed Undo journal read and mirror removal leave a durable non-replayable tombstone', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50)
  await start(page)
  await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
  await expect.poll(() => pendingCount(page)).toBe(0)
  const result = await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    const target = (await api.readCommandInteractions('instant-owner')).find(item => item.state === 'confirmed')!
    const get = IDBObjectStore.prototype.get, remove = Storage.prototype.removeItem
    IDBObjectStore.prototype.get = function(...args: Parameters<IDBObjectStore['get']>) { if (this.name === 'commandInteractions') throw new Error('Synthetic target journal inaccessible'); return get.apply(this, args) }
    Storage.prototype.removeItem = function(key: string) { if (key.includes('pjsdas-cgr01-pending:')) throw new Error('Synthetic mirror removal inaccessible'); return remove.call(this, key) }
    let failed = false
    try { await client.beginInstantUndo('instant-owner', target.commandId, await api.exportLocalSnapshot()) } catch { failed = true }
    finally { IDBObjectStore.prototype.get = get; Storage.prototype.removeItem = remove }
    const pending = JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]')[0]
    await client.recoverInstantInteraction('instant-owner', pending.commandId)
    return { failed, mirror: pending.status, state: (await api.readCommandInteraction('instant-owner', pending.commandId))?.state }
  })
  expect(result).toEqual({ failed: true, mirror: 'conflict', state: 'rejected' })
  await page.reload()
  expect(server.sent).toHaveLength(1)
  expect(server.snapshot.data.actions[0].status).toBe('done')
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

test('mirror-only recovery preserves a genuine newer local edit and the original reservation', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page)
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), auth = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
    const before = await api.exportLocalSnapshot()
    const command = { commandId: 'mirror-genuine-edit', kind: 'set_action_status' as const, actionId: 'dense-action-0', status: 'done' as const }
    const projected = (await import('/pjsdas/src/cloud/interactionProjection.ts')).interactionProjection(before, command, 1204)
    auth.journalConnectedInteraction('instant-owner', { commandId: command.commandId, command: { type: 'domain', value: command }, baseRevision: 1204,
      interactionDelta: projected.delta, interactionCompensation: projected.compensation })
    const db = await api.dbPromise, row = (await db.get('actions', command.actionId))!
    await db.put('actions', { ...row, status: 'skipped' })
    await (await import('/pjsdas/src/cloud/instantCommandClient.ts')).recoverInstantInteraction('instant-owner', command.commandId)
  })
  const state = await page.evaluate(async () => ({ status: (await (await (await import('/pjsdas/src/db.ts')).dbPromise).get('actions', 'dense-action-0'))!.status,
    mirror: JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]')[0]?.status }))
  expect(state).toEqual({ status: 'skipped', mirror: 'conflict' })
  expect(server.sent).toEqual([])
  await page.reload(); expect(server.sent).toEqual([])
})

for (const parentCommitted of [false, true]) test(`retained dependency chain restores cleared cache with parent committed=${parentCommitted}`, async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page)
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    for (const [commandId, minutes] of [['cleared-parent', 300], ['cleared-child', 240]] as const)
      await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId, kind: 'set_date_capacity', date: '2026-10-01', minutes })
  })
  if (parentCommitted) {
    await page.evaluate(async () => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
      await (await import('/pjsdas/src/cloud/instantCommandClient.ts')).recoverInstantInteraction('instant-owner', 'cleared-parent')
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    })
  }
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), local = await api.exportLocalSnapshot(), data: any = { ...local.data }
    for (const key of Object.keys(data)) data[key] = Array.isArray(data[key]) ? [] : undefined
    await api.replaceLocalSnapshotFromCloud({ ...local, data })
    ;(await import('/pjsdas/src/cloud/syncState.ts')).patchAccountCheckpoint('instant-owner', { clearedCacheFingerprint:
      await (await import('/pjsdas/src/cloud/workspaceFingerprint.ts')).fingerprintWorkspace(await api.exportLocalSnapshot()) })
  })
  await page.reload()
  await expect.poll(() => pendingCount(page), { timeout: 20000 }).toBe(0)
  await expect(page.locator('.tsui-capacity summary')).toContainText('4 小时')
  expect(server.sent).toEqual(['cleared-parent', 'cleared-child'])
  expect(server.snapshot.data.timePlanning?.dateOverrides?.['2026-10-01']).toBe(240)
  const local = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data.timePlanning)
  expect(local).toEqual(server.snapshot.data.timePlanning)
})

test('rollback-pending predecessor cannot dispatch a later overlapping edit', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page); server.denyNext()
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'durable-rejected-parent', kind: 'set_date_capacity', date: '2026-10-01', minutes: 300 })
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'commandInteractions' && (args[0] as any).state === 'rejected') throw new Error('Synthetic rollback blocked; archival remains available')
      return put.apply(this, args)
    }
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    try { await client.recoverInstantInteraction('instant-owner', 'durable-rejected-parent') } finally { IDBObjectStore.prototype.put = put }
    if ((await api.readCommandInteraction('instant-owner', 'durable-rejected-parent'))?.state !== 'rollback_pending') throw new Error('Missing durable rollback disposition')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'durable-rejected-child', kind: 'set_date_capacity', date: '2026-10-01', minutes: 240 })
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    await client.recoverInstantInteraction('instant-owner', 'durable-rejected-child')
    await client.recoverInstantInteraction('instant-owner', 'durable-rejected-parent')
  })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toEqual(['durable-rejected-parent'])
  const local = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data.timePlanning)
  expect(local).toEqual(server.snapshot.data.timePlanning)
})

test('failed predecessor lookup does not archive an independent queued command as rejected', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page)
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'previous-confirmed', kind: 'set_date_capacity', date: '2026-10-01', minutes: 300 })
  })
  await expect.poll(() => pendingCount(page)).toBe(0)
  server.denyNext()
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'bad-dependent', kind: 'set_date_capacity', date: '2026-10-01', minutes: 240 })
    const root = (await api.readCommandInteraction('instant-owner', 'bad-dependent'))!
    await api.saveCommandInteraction({ ...root, predecessors: ['previous-confirmed'] })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'good-independent', kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' })
    const get = IDBObjectStore.prototype.get; let lookups = 0
    IDBObjectStore.prototype.get = function(...args: Parameters<IDBObjectStore['get']>) {
      if (this.name === 'commandInteractions' && String(args[0]).endsWith(':previous-confirmed') && ++lookups === 2) throw new Error('Synthetic rollback predecessor lookup failure')
      return get.apply(this, args)
    }
    await new Promise(resolve => setTimeout(resolve, 0))
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    try { await client.recoverInstantInteraction('instant-owner', 'bad-dependent') } finally { IDBObjectStore.prototype.get = get }
    await client.recoverInstantInteraction('instant-owner', 'bad-dependent')
    await client.recoverInstantInteraction('instant-owner', 'good-independent')
  })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toEqual(['previous-confirmed', 'bad-dependent', 'good-independent'])
  expect(server.snapshot.data.actions[0].status).toBe('done')
})

test('mirror-only child retains its original parent ordering after parent acknowledgement', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page)
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts'), auth = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'mirror-parent', kind: 'set_date_capacity', date: '2026-10-01', minutes: 300 })
    const command = { commandId: 'mirror-child', kind: 'set_date_capacity' as const, date: '2026-10-01', minutes: 240 }
    const projection = (await import('/pjsdas/src/cloud/interactionProjection.ts')).interactionProjection(await api.exportLocalSnapshot(), command, 1204)
    auth.journalConnectedInteraction('instant-owner', { commandId: command.commandId, command: { type: 'domain', value: command }, baseRevision: 1204,
      interactionDelta: projection.delta, interactionCompensation: projection.compensation, interactionPredecessors: ['mirror-parent'] })
  })
  await page.reload(); await expect.poll(() => pendingCount(page), { timeout: 20000 }).toBe(0)
  expect(server.sent).toEqual(['mirror-parent', 'mirror-child'])
  expect(server.baseRevisions).toEqual([1204, 1205])
  await expect(page.locator('.tsui-capacity summary')).toContainText('4 小时')
})

test('ordinary snapshot receipt cannot erase an outstanding optimistic interaction', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); server.setFullResponses(true); await start(page)
  const response = await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts'), auth = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'snapshot-protected-completion', kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const command = { commandId: 'snapshot-capacity', kind: 'set_date_capacity' as const, date: '2026-10-01', minutes: 240 }
    const result = await auth.executeConnectedBusinessCommand('instant-owner', { type: 'domain', value: command }, { commandId: command.commandId, allowProjectionPending: true })
    const status = (await (await api.dbPromise).get('actions', 'dense-action-0'))!.status
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    await client.recoverInstantInteraction('instant-owner', 'snapshot-protected-completion')
    await auth.replayAccountPendingOperations('instant-owner')
    return { outcome: result.outcome, projection: result.localProjection, status }
  })
  expect(response).toEqual({ outcome: 'COMMITTED', projection: 'pending', status: 'done' })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toEqual(['snapshot-capacity', 'snapshot-protected-completion'])
  expect(server.snapshot.data.actions[0].status).toBe('done')
  await page.reload(); await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
})


test('ordinary domain compact patch preserves an unrelated outstanding optimistic completion', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page)
  const result = await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts'), auth = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'compact-completion', kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const command = { commandId: 'compact-capacity', kind: 'set_date_capacity' as const, date: '2026-10-01', minutes: 240 }
    const response = await auth.executeConnectedBusinessCommand('instant-owner', { type: 'domain', value: command }, { commandId: command.commandId, allowProjectionPending: true })
    const local = await api.exportLocalSnapshot()
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    await client.recoverInstantInteraction('instant-owner', 'compact-completion')
    return { projection: response.localProjection, fullSnapshot: !!response.snapshot, status: local.data.actions.find(item => item.id === 'dense-action-0')!.status, capacity: local.data.timePlanning?.dateOverrides?.['2026-10-01'] }
  })
  expect(result).toEqual({ projection: 'applied', fullSnapshot: false, status: 'done', capacity: 240 })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toEqual(['compact-capacity', 'compact-completion'])
  expect(Math.max(...server.payloadBytes)).toBeLessThan(150000)
  await page.reload(); await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
  await expect(page.locator('.tsui-capacity summary')).toContainText('4 小时')
})

test('receiptless already-applied fact with blocked projection recovers by read without resending', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page)
  const result = await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts'), auth = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'fact-completion', kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const command = { commandId: 'already-current-capacity', kind: 'set_action_status' as const, actionId: 'dense-action-6', status: 'done' as const }
    const response = await auth.executeConnectedBusinessCommand('instant-owner', { type: 'domain', value: command }, { commandId: command.commandId, allowProjectionPending: true })
    const mirror = JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]').find((item: any) => item.commandId === command.commandId)
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    await client.recoverInstantInteraction('instant-owner', 'fact-completion')
    await auth.replayAccountPendingOperations('instant-owner')
    return { outcome: response.outcome, projection: response.localProjection, fact: mirror?.confirmedFact }
  })
  expect(result).toEqual({ outcome: 'ALREADY_APPLIED', projection: 'pending', fact: 'ALREADY_APPLIED' })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toEqual(['already-current-capacity', 'fact-completion'])
  await page.reload(); await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
})


test('three-layer retained capacity chain restores intermediate pending preimages after cache clearing', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page)
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    for (const [commandId, minutes] of [['three-parent', 300], ['three-middle', 240], ['three-child', 180]] as const)
      await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId, kind: 'set_date_capacity', date: '2026-10-01', minutes })
    await new Promise(resolve => setTimeout(resolve, 0))
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    await client.recoverInstantInteraction('instant-owner', 'three-parent')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    const local = await api.exportLocalSnapshot(), data: any = { ...local.data }
    for (const key of Object.keys(data)) data[key] = Array.isArray(data[key]) ? [] : undefined
    await api.replaceLocalSnapshotFromCloud({ ...local, data })
    ;(await import('/pjsdas/src/cloud/syncState.ts')).patchAccountCheckpoint('instant-owner', { clearedCacheFingerprint:
      await (await import('/pjsdas/src/cloud/workspaceFingerprint.ts')).fingerprintWorkspace(await api.exportLocalSnapshot()) })
  })
  await page.reload(); await expect.poll(() => pendingCount(page), { timeout: 20000 }).toBe(0)
  expect(server.sent).toEqual(['three-parent', 'three-middle', 'three-child'])
  await expect(page.locator('.tsui-capacity summary')).toContainText('3 小时')
  const local = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data.timePlanning)
  expect(local).toEqual(server.snapshot.data.timePlanning)
})

test('proven cleared cache hydrates a known rejected rollback obligation without resending', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page); server.denyNext()
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'cleared-rejected-action', kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'commandInteractions' && (args[0] as any).state === 'rejected') throw new Error('Synthetic rejected rollback storage failure')
      return put.apply(this, args)
    }
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    try { await client.recoverInstantInteraction('instant-owner', 'cleared-rejected-action') } finally { IDBObjectStore.prototype.put = put }
    if ((await api.readCommandInteraction('instant-owner', 'cleared-rejected-action'))?.state !== 'rollback_pending') throw new Error('Missing rollback disposition')
    const local = await api.exportLocalSnapshot(), data: any = { ...local.data }
    for (const key of Object.keys(data)) data[key] = Array.isArray(data[key]) ? [] : undefined
    await api.replaceLocalSnapshotFromCloud({ ...local, data })
    ;(await import('/pjsdas/src/cloud/syncState.ts')).patchAccountCheckpoint('instant-owner', { clearedCacheFingerprint:
      await (await import('/pjsdas/src/cloud/workspaceFingerprint.ts')).fingerprintWorkspace(await api.exportLocalSnapshot()) })
    await client.recoverInstantInteraction('instant-owner', 'cleared-rejected-action')
  })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toEqual(['cleared-rejected-action'])
  const row = await page.evaluate(async () => (await (await (await import('/pjsdas/src/db.ts')).dbPromise).get('actions', 'dense-action-0')))
  expect(row?.status).toBe('todo')
  await page.reload(); await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
})


test('mirror-only Undo never resurrects an already rejected predecessor', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page); server.denyNext()
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts'), auth = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'rejected-mirror-parent', kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' })
    const parent = (await api.readCommandInteraction('instant-owner', 'rejected-mirror-parent'))!
    const delta = (await import('/pjsdas/src/cloud/interactionProjection.ts')).undoInteractionProjection(await api.exportLocalSnapshot(), parent.command, parent.compensation, parent.delta, 1204)
    auth.journalConnectedInteraction('instant-owner', { commandId: 'rejected-mirror-undo', targetCommandId: parent.commandId, baseRevision: 1204,
      interactionDelta: delta, interactionPredecessors: [parent.commandId] })
    await new Promise(resolve => setTimeout(resolve, 0))
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    await client.recoverInstantInteraction('instant-owner', parent.commandId)
    await client.recoverInstantInteraction('instant-owner', 'rejected-mirror-undo')
  })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toEqual(['rejected-mirror-parent'])
  const local = await page.evaluate(async () => ({ action: await (await (await import('/pjsdas/src/db.ts')).dbPromise).get('actions', 'dense-action-0'),
    journal: await (await import('/pjsdas/src/db.ts')).readCommandInteraction('instant-owner', 'rejected-mirror-undo') }))
  expect(local.action?.status).toBe('todo'); expect(local.journal?.state).toBe('rejected')
  await page.reload(); await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
})

test('cleared-cache rejection releases a conservatively quarantined independent mirror', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page); server.denyNext()
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'cleared-quarantine-root', kind: 'set_date_capacity', date: '2026-10-01', minutes: 300 })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'cleared-quarantine-dependent', kind: 'set_date_capacity', date: '2026-10-01', minutes: 240 })
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId: 'cleared-quarantine-independent', kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const getAll = IDBIndex.prototype.getAll; let armed = true
    IDBIndex.prototype.getAll = function(...args: Parameters<IDBIndex['getAll']>) {
      if (this.name === 'by-account-state' && armed) { armed = false; throw new Error('Synthetic rejection journal unavailable') }
      return getAll.apply(this, args)
    }
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    try { await client.recoverInstantInteraction('instant-owner', 'cleared-quarantine-root') } finally { IDBIndex.prototype.getAll = getAll }
    const mirrors = JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]')
    if (mirrors.find((item: any) => item.commandId === 'cleared-quarantine-independent')?.status !== 'rollback_pending') throw new Error('Independent quarantine not reproduced')
    const local = await api.exportLocalSnapshot(), data: any = { ...local.data }
    for (const key of Object.keys(data)) data[key] = Array.isArray(data[key]) ? [] : undefined
    await api.replaceLocalSnapshotFromCloud({ ...local, data })
    ;(await import('/pjsdas/src/cloud/syncState.ts')).patchAccountCheckpoint('instant-owner', { clearedCacheFingerprint:
      await (await import('/pjsdas/src/cloud/workspaceFingerprint.ts')).fingerprintWorkspace(await api.exportLocalSnapshot()) })
    await client.recoverInstantInteraction('instant-owner', 'cleared-quarantine-root')
    await client.recoverInstantInteraction('instant-owner', 'cleared-quarantine-independent')
  })
  await expect.poll(() => pendingCount(page)).toBe(0)
  expect(server.sent).toEqual(['cleared-quarantine-root', 'cleared-quarantine-independent'])
  const local = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()))
  expect(local.data.actions.find(action => action.id === 'dense-action-0')?.status).toBe('done')
  expect(local.data.timePlanning).toEqual(server.snapshot.data.timePlanning)
})


test('continuous settled commands defer passive full reads while explicit refresh remains available', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50)
  await start(page)
  await page.waitForTimeout(150)
  const initialReads = server.readCount
  for (let index = 0; index < 3; index++) {
    await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
    await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
    await expect.poll(() => pendingCount(page)).toBe(0)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
    await expect.poll(() => pendingCount(page)).toBe(0)
    const deferred = await page.evaluate(async () => (await import('/pjsdas/src/cloud/authoritativeReadModelClient.ts'))
      .refreshConnectedAuthoritativeCache('instant-owner', { passive: true }))
    expect(deferred.state).toBe('pending_operations')
  }
  expect(server.readCount).toBe(initialReads)
  const explicit = await page.evaluate(async () => (await import('/pjsdas/src/cloud/authoritativeReadModelClient.ts'))
    .refreshConnectedAuthoritativeCache('instant-owner'))
  expect(explicit.state).toBe('updated')
  expect(explicit.workspaceVersion).toBe('txn:1210')
  await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
  expect(server.readCount).toBe(initialReads + 1)
  expect(server.sent).toHaveLength(6)
  expect(server.snapshot.data.actions[0].status).toBe('todo')
})

for (const state of ['rejected', 'conflict'] as const) test(`terminal ${state} journal reconciles a pending mirror after a crash`, async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page)
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }))
  const result = await page.evaluate(async state => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    const { reverseWorkspaceDelta } = await import('/pjsdas/src/workspaceDelta.ts')
    const commandId = await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), {
      commandId: `terminal-crash-${state}`, kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' })
    const record = (await api.readCommandInteraction('instant-owner', commandId))!
    await new Promise(resolve => setTimeout(resolve, 0))
    // Tab stops after the atomic rollback/journal commit, before mirror cleanup.
    await api.persistInteractionProjection({ ...record, state }, () => undefined, reverseWorkspaceDelta(record.delta))
    await client.recoverInstantInteraction('instant-owner', record.commandId)
    const summary = (await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')).pendingCommandSummary('instant-owner')
    return { unresolved: summary.count - summary.conflict, status: (await (await api.dbPromise).get('actions', 'dense-action-0'))!.status,
      journal: (await api.readCommandInteraction('instant-owner', record.commandId))!.state }
  }, state)
  expect(result).toEqual({ unresolved: 0, status: 'todo', journal: state })
  expect(server.sent).toEqual([])
  await page.reload()
  await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
  expect(server.sent).toEqual([])
})

for (const disposition of ['rejected', 'conflict'] as const) test(`already rolled-back ${disposition} root releases an independent paused mirror without reversing or replaying rejection`, async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page)
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }))
  await page.evaluate(async disposition => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    const queue = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
    const { reverseWorkspaceDelta } = await import('/pjsdas/src/workspaceDelta.ts')
    const rootId = await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), {
      commandId: 'terminal-root', kind: 'set_date_capacity', date: '2026-10-01', minutes: 300 })
    const root = (await api.readCommandInteraction('instant-owner', rootId))!
    await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), {
      commandId: 'terminal-independent', kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' })
    await new Promise(resolve => setTimeout(resolve, 0))
    await api.persistInteractionProjection({ ...root, state: disposition }, () => undefined, reverseWorkspaceDelta(root.delta))
    for (const id of ['terminal-root', 'terminal-independent']) queue.settleConnectedInteraction('instant-owner', id, 'rollback_pending', 'Rejected root', 'terminal-root')
    await client.recoverInstantInteraction('instant-owner', root.commandId)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    window.dispatchEvent(new Event('online'))
  }, disposition)
  await expect.poll(() => page.evaluate(async () => { const summary = (await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')).pendingCommandSummary('instant-owner'); return summary.count - summary.conflict })).toBe(0)
  expect(server.sent).toEqual(['terminal-independent'])
  expect(server.snapshot.data.actions[0].status).toBe('done')
  const local = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data)
  expect(local.timePlanning).toEqual(server.snapshot.data.timePlanning)
  expect(local.actions.find(action => action.id === 'dense-action-0')!.status).toBe('done')
})

test('mirror cleanup failure after atomic dependent rollback never rewrites terminal journals', async ({ page, context }) => {
  const server = await setup(context); server.setDelay(50); await start(page)
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }))
  await page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    for (const [commandId, minutes] of [['cleanup-parent', 300], ['cleanup-child', 240]] as const)
      await client.beginInstantCommand('instant-owner', await api.exportLocalSnapshot(), { commandId, kind: 'set_date_capacity', date: '2026-10-01', minutes })
    await new Promise(resolve => setTimeout(resolve, 0))
    const original = Storage.prototype.setItem
    let armed = true
    Storage.prototype.setItem = function(key, value) {
      if (armed && key === 'pjsdas-cgr01-pending:instant-owner' && JSON.parse(value).length < 2) {
        armed = false; throw new Error('Synthetic post-commit mirror failure')
      }
      return original.call(this, key, value)
    }
    ;(window as any).restoreMirror = () => { Storage.prototype.setItem = original }
  })
  server.denyNext()
  const result = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    const api = await import('/pjsdas/src/db.ts'), client = await import('/pjsdas/src/cloud/instantCommandClient.ts')
    try {
      await client.recoverInstantInteraction('instant-owner', 'cleanup-parent')
      const journals = await Promise.all(['cleanup-parent', 'cleanup-child'].map(id => api.readCommandInteraction('instant-owner', id)))
      await client.recoverInstantInteraction('instant-owner', 'cleanup-parent')
      await client.recoverInstantInteraction('instant-owner', 'cleanup-child')
      return { states: journals.map(item => item!.state), planning: (await api.exportLocalSnapshot()).data.timePlanning }
    } finally { (window as any).restoreMirror() }
  })
  expect(result.states).toEqual(['rejected', 'rejected'])
  expect(result.planning).toEqual(server.snapshot.data.timePlanning)
  expect(await pendingCount(page)).toBe(0)
  expect(server.sent).toEqual(['cleanup-parent'])
  await page.reload()
  await expect(page.locator('.tsui-capacity summary')).toContainText('6 小时')
  expect(server.sent).toEqual(['cleanup-parent'])
})

import { expect, test, type Page } from '@playwright/test'
import { historyActionWorkspace, HISTORY_NOW } from '../tests/fixtures/historyActionWorkspace.js'
import { applyDomainCompensation, applyUserDomainCommand, type DomainCompensation } from '../src/domainCommands.js'
import { seedSession, BACKEND, cors, health } from './fixtures/todayWorkspace.js'

async function rows(page: Page, store: string) {
  return page.evaluate(async (store) => {
    const db = await (await import('/pjsdas/src/db.ts')).dbPromise
    return db.getAll(store as any)
  }, store)
}
async function checkHistory(page: Page, before: ReturnType<typeof historyActionWorkspace>) {
  const nodes = await rows(page, 'scheduleNodes')
  for (const prior of before.data.scheduleNodes!) {
    const actual = nodes.find((item) => item.id === prior.id)!
    expect(actual).toMatchObject({ state: prior.state, updatedAt: prior.updatedAt, temporal: prior.temporal })
    expect(actual.completedAt).toBe(prior.completedAt)
    for (const ref of prior.evidenceRefs) expect(actual.evidenceRefs).toContain(ref)
    for (const ref of prior.sourceVersionRefs) expect(actual.sourceVersionRefs).toContain(ref)
  }
  expect((await rows(page, 'timeline')).find((item) => item.id === 'retained-history')).toEqual(before.data.timeline![0])
  expect((await rows(page, 'actions')).find((item) => item.id === before.data.actions[0].id)?.status).toBe('todo')
}

for (const [connected, application] of [[false, false], [true, false], [true, true]]) test(`${connected ? 'connected' : 'local'} ${application ? 'application submission' : 'history detail completion'} Undo restores only its changed nodes through durable reload/restart`, async ({ page, context }) => {
  await page.clock.install({ time: HISTORY_NOW })
  const before = historyActionWorkspace()
  if (application) {
    before.data.actions[0].id = 'apply:history-job'; before.data.actions[0].kind = 'apply'
    for (const node of before.data.scheduleNodes!) node.relatedActionIds = ['apply:history-job']
  }
  const state = { snapshot: structuredClone(before), revision: 7, compensation: undefined as DomainCompensation | undefined }
  const commands: string[] = []
  if (connected) {
    await seedSession(context)
    await context.route(BACKEND + '/**', async (route) => {
      if (route.request().method() === 'OPTIONS') return cors(route, {}, 204)
      const url = new URL(route.request().url())
      if (url.pathname === '/api/health') return cors(route, health())
      if (url.pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)
      const body = route.request().postDataJSON()
      const read = () => ({ workspaceId: 'ws-history', workspaceVersion: 'txn:' + state.revision, revision: state.revision, schemaVersion: state.snapshot.version, snapshot: state.snapshot })
      if (body.action === 'read') return cors(route, read())
      if (body.action === 'command' && body.command?.type === 'domain') {
        expect(body.baseRevision).toBe(state.revision)
        commands.push(body.command.value.kind)
        const result = applyUserDomainCommand(state.snapshot, body.command.value, HISTORY_NOW)
        if (result.status !== 'APPLIED' || !result.compensation) throw Error('Expected reversible completion')
        state.compensation = JSON.parse(JSON.stringify(result.compensation)); state.snapshot = result.snapshot
      } else if (body.action === 'undo') {
        commands.push('undo')
        state.snapshot = applyDomainCompensation(JSON.parse(JSON.stringify(state.snapshot)), state.compensation!, HISTORY_NOW)
      } else return cors(route, { code: 'UNEXPECTED_WRITE' }, 400)
      state.revision += 1
      return cors(route, { ...read(), outcome: 'COMMITTED', receipt: { commandId: body.commandId, receiptId: 'receipt:' + body.commandId, status: 'COMMITTED', revision: state.revision,
        undoAvailable: true, affectedObjects: [{ type: 'action', id: 'history-task' }], result: { type: 'domain', status: 'APPLIED', summary: 'Updated history task' } } })
    })
  } else {
    await page.goto('/'); await expect(page.locator('.tsui-primary-nav')).toBeVisible()
    await page.evaluate(async (snapshot) => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(snapshot), before)
  }
  await page.goto('/pjsdas/schedule?view=past')
  await page.locator('.tsui-schedule-row').filter({ hasText: 'Historical job' }).click()
  await page.getByRole('button', { name: /查看岗位详情|View job details/ }).click()
  if (application) await page.getByRole('button', { name: /我已投递|I applied/ }).click()
  else await page.locator('.opportunity-detail-action-list article').filter({ hasText: 'History task' }).getByRole('button', { name: /标记完成|Mark done/ }).click()
  await expect(page.locator('.action-undo-toast').getByRole('button', { name: /撤销|Undo/ })).toBeVisible()
  expect((await rows(page, 'scheduleNodes')).find((item) => item.id === 'history-node-6')?.state).toBe('completed')
  await page.locator('.action-undo-toast').getByRole('button', { name: /撤销|Undo/ }).click()
  await expect(page.locator('.action-undo-toast')).toHaveCount(0)
  await checkHistory(page, before)
  // The completion audit is retained after compensation, not deleted by Undo.
  const retainedTimeline = await rows(page, 'timeline')
  expect(retainedTimeline.some((item) => application ? item.kind === 'application_submitted' : item.actionId === 'history-task' && item.changes?.status?.after === 'done')).toBe(true)
  for (const [path, selector] of [['today', '[data-testid="cgr02-today"]'], ['schedule', '.tsui-schedule-page'], ['library/history-job', '.job-detail-page']]) {
    await page.goto('/pjsdas/' + path); await expect(page.locator(selector)).toBeVisible()
    await page.reload(); await expect(page.locator(selector)).toBeVisible()
    await checkHistory(page, before)
  }
  const restarted = await context.newPage(); await restarted.goto('/pjsdas/today'); await page.close()
  await expect(restarted.getByTestId('cgr02-today')).toBeVisible(); await checkHistory(restarted, before)
  expect(await rows(restarted, 'timeline')).toEqual(retainedTimeline)
  if (connected) expect(commands).toEqual([application ? 'record_application_submission' : 'set_action_status', 'undo'])
})

test('queued action completion becomes confirmed with Undo after automatic reconnect', async ({ page, context }) => {
  await page.clock.setFixedTime(HISTORY_NOW)
  await seedSession(context)
  const state = { snapshot: historyActionWorkspace(), revision: 7, commands: [] as string[] }
  await context.route(BACKEND + '/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return cors(route, {}, 204)
    const url = new URL(route.request().url())
    if (url.pathname === '/api/health') return cors(route, health())
    if (url.pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)
    const body = route.request().postDataJSON()
    const read = () => ({ workspaceId: 'ws-history', workspaceVersion: 'txn:' + state.revision,
      revision: state.revision, schemaVersion: state.snapshot.version, snapshot: state.snapshot })
    if (body.action === 'read') return cors(route, read())
    if (body.action === 'receipt') return cors(route, { ...read(), found: false })
    if (body.action !== 'command' || body.command?.type !== 'domain') return cors(route, { code: 'UNEXPECTED_WRITE' }, 400)
    state.commands.push(body.commandId)
    const applied = applyUserDomainCommand(state.snapshot, body.command.value, HISTORY_NOW)
    expect(applied.status).toBe('APPLIED')
    state.snapshot = applied.snapshot
    state.revision += 1
    return cors(route, { ...read(), outcome: 'COMMITTED', receipt: {
      commandId: body.commandId, receiptId: 'receipt:' + body.commandId, status: 'COMMITTED',
      revision: state.revision, undoAvailable: true, result: { type: 'domain', status: 'APPLIED' },
    } })
  })
  await page.goto('/pjsdas/schedule?view=past')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') || '{}').accounts?.['account-a']?.lastSyncedVersion)).toBe('txn:7')
  await page.locator('.tsui-schedule-row').filter({ hasText: 'Historical job' }).click()
  await page.getByRole('button', { name: /查看岗位详情|View job details/ }).click()
  await context.setOffline(true)
  await page.locator('.opportunity-detail-action-list article').filter({ hasText: 'History task' }).getByRole('button', { name: /标记完成|Mark done/ }).click()
  await expect(page.locator('.action-undo-toast')).toContainText(/待同步|Pending/)
  expect(state.commands).toHaveLength(0)
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('.action-undo-toast').getByRole('button', { name: /撤销|Undo/ })).toBeVisible()
  expect(state.commands).toHaveLength(1)
  expect((await rows(page, 'actions')).find((item) => item.id === 'history-task')?.status).toBe('done')
})

test('local durable completion evidence rejects a later occurrence edit atomically', async ({ page }) => {
  await page.clock.install({ time: HISTORY_NOW })
  await page.goto('/'); await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  const evidence = await page.evaluate(async (before) => {
    const module = await import('/pjsdas/src/db.ts')
    await module.replaceLocalSnapshotFromCloud(before)
    const applied = await module.applyActionStatusChangeSet('history-task', 'done')
    const undo = JSON.parse(JSON.stringify(applied!.actionCompensations![0]))
    const db = await module.dbPromise
    const node = (await db.get('scheduleNodes', 'history-node-6'))!
    await db.put('scheduleNodes', { ...node, state: 'superseded', supersededByNodeId: 'later-occurrence' })
    const raw = await module.exportLocalRecoveryArchive()
    let rejected = false
    try { await module.undoActionStatusChange(undo) } catch { rejected = true }
    return { rejected, before: raw.stores, after: (await module.exportLocalRecoveryArchive()).stores }
  }, historyActionWorkspace())
  expect(evidence.rejected).toBe(true)
  expect(evidence.after).toEqual(evidence.before)
})

test('legacy projected event action can complete and Undo without losing its event or prior occurrence state', async ({ page }) => {
  await page.clock.install({ time: HISTORY_NOW })
  await page.goto('/'); await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  const evidence = await page.evaluate(async (input) => {
    const module = await import('/pjsdas/src/db.ts')
    const event = { id: 'legacy-invite', opportunityId: 'history-job', company: 'History company', role: 'Engineer',
      type: 'written_test_invite' as const, occurredAt: '2026-09-20T00:00:00.000Z', dueAt: '2026-09-29T10:00:00+08:00',
      duePrecision: 'datetime' as const, source: 'manual' as const, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' }
    input.data.actions = []; input.data.scheduleNodes = []; input.data.processEvents = [event]
    await module.replaceLocalSnapshotFromCloud(input)
    const before = await module.exportLocalSnapshot()
    const applied = await module.applyActionStatusChangeSet('event-action:legacy-invite', 'done')
    await module.undoActionStatusChange(JSON.parse(JSON.stringify(applied!.actionCompensations![0])))
    return { before: before.data.scheduleNodes, after: (await module.exportLocalSnapshot()).data.scheduleNodes,
      actions: await module.getAllActions(), events: await (await module.dbPromise).getAll('processEvents') }
  }, historyActionWorkspace())
  expect(evidence.actions.find((item) => item.id === 'event-action:legacy-invite')?.status).toBe('todo')
  expect(evidence.events).toHaveLength(1)
  for (const node of evidence.before!) {
    const after = evidence.after!.find((item) => item.id === node.id)!
    expect(after).toMatchObject({ state: node.state, updatedAt: node.updatedAt, temporal: node.temporal })
    expect(after.completedAt).toBe(node.completedAt)
  }
})

test('a real second-connection status race is checked inside the local mutation transaction', async ({ page }) => {
  await page.clock.install({ time: HISTORY_NOW })
  await page.goto('/'); await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  const evidence = await page.evaluate(async (input) => {
    const module = await import('/pjsdas/src/db.ts')
    await module.replaceLocalSnapshotFromCloud(input)
    const db = await module.dbPromise
    const before = await db.getAll('scheduleNodes')
    const action = (await db.get('actions', 'history-task'))!
    const other = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('pjsdas'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
    })
    const original = db.transaction.bind(db)
    let intercepted = false
    ;(db as any).transaction = (...args: any[]) => {
      if (!intercepted && args[1] === 'readwrite' && Array.isArray(args[0]) && args[0].includes('actions')) {
        intercepted = true
        other.transaction('actions', 'readwrite').objectStore('actions').put({ ...action, status: 'doing', updatedAt: '2026-09-28T12:00:01.000Z' })
      }
      return (original as any)(...args)
    }
    let rejected = false
    try { await module.applyActionStatusChangeSet('history-task', 'done') } catch { rejected = true }
    finally { (db as any).transaction = original; other.close() }
    return { intercepted, rejected, before, after: await db.getAll('scheduleNodes'), action: await db.get('actions', 'history-task') }
  }, historyActionWorkspace())
  expect(evidence.intercepted).toBe(true); expect(evidence.rejected).toBe(true)
  expect(evidence.action?.status).toBe('doing')
  expect(evidence.after).toEqual(evidence.before)
})

for (const state of ['completed', 'elapsed_unresolved', 'scheduled'] as const) test(`deleting an event with ${state} historical evidence refuses atomically and every route remains usable`, async ({ page, context }) => {
  await page.clock.install({ time: HISTORY_NOW })
  await page.goto('/'); await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  const evidence = await page.evaluate(async ({ input, state }) => {
    const module = await import('/pjsdas/src/db.ts')
    const event = { id: 'retained-event', opportunityId: 'history-job', company: 'History company', role: 'Engineer',
      type: 'written_test_invite' as const, occurredAt: '2026-09-20T00:00:00.000Z', dueAt: '2026-09-20T01:00:00.000Z',
      duePrecision: 'datetime' as const, source: 'manual' as const, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' }
    input.data.processEvents = [event]
    input.data.actions[0].processEventId = event.id
    input.data.scheduleNodes = [{ ...input.data.scheduleNodes![0], state, processEventId: event.id }]
    await module.replaceLocalSnapshotFromCloud(input)
    const before = (await module.exportLocalRecoveryArchive()).stores
    let error = ''
    try { await module.deleteProcessEvent(event.id) } catch (caught) { error = String(caught) }
    return { error, before, after: (await module.exportLocalRecoveryArchive()).stores }
  }, { input: historyActionWorkspace(), state })
  expect(evidence.error).toMatch(/historical|历史/)
  expect(evidence.after).toEqual(evidence.before)
  for (const [path, selector] of [['today', '[data-testid="cgr02-today"]'], ['schedule', '.tsui-schedule-page'], ['library/history-job', '.job-detail-page']]) {
    await page.goto('/pjsdas/' + path); await page.reload(); await expect(page.locator(selector)).toBeVisible()
  }
  const restarted = await context.newPage(); await restarted.goto('/pjsdas/today'); await page.close()
  await expect(restarted.getByTestId('cgr02-today')).toBeVisible()
})

test('reimport cannot commit a retained historical node with a removed process reference', async ({ page }) => {
  await page.clock.install({ time: HISTORY_NOW })
  await page.goto('/'); await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  const evidence = await page.evaluate(async (input) => {
    const module = await import('/pjsdas/src/db.ts')
    const job = { ...input.data.opportunities[0], locallyManaged: false }
    const process = { id: 'historical-import-process', opportunityId: job.id, company: job.company, role: job.role, stage: 'not_applied' as const, stageLabel: '待投递', progress: 'not_started' as const, result: 'pending' as const, participationState: 'active' as const, lastProgressAt: '2026-09-20T00:00:00.000Z' }
    input.data.opportunities = [job]; input.data.processes = [process]
    input.data.scheduleNodes = [{ ...input.data.scheduleNodes![0], processId: process.id }]
    await module.replaceLocalSnapshotFromCloud(input)
    const before = (await module.exportLocalRecoveryArchive()).stores
    let refused = false
    try {
      await module.replaceImportedData({ opportunities: [job], processes: [], actions: [], prep: [], applicationGroups: [],
        summary: { filename: 'unsafe-process-removal.xlsx', importedAt: '2026-09-28T12:00:00.000Z', opportunities: 1, pending: 0, processes: 0, prep: 0, applicationGroups: 0, actions: 0 } })
    } catch { refused = true }
    return { refused, before, after: (await module.exportLocalRecoveryArchive()).stores }
  }, historyActionWorkspace())
  expect(evidence.refused).toBe(true)
  expect(evidence.after).toEqual(evidence.before)
  await page.reload(); await expect(page.getByTestId('cgr02-today')).toBeVisible()
})

for (const state of ['elapsed_unresolved', 'scheduled'] as const) test(`reimport preserves ${state} past legacy occurrence evidence instead of deleting it`, async ({ page }) => {
  await page.clock.install({ time: HISTORY_NOW })
  await page.goto('/'); await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  const evidence = await page.evaluate(async ({ input, state }) => {
    const module = await import('/pjsdas/src/db.ts')
    const job = { ...input.data.opportunities[0], locallyManaged: false }
    const node = { ...input.data.scheduleNodes![0], state, completedAt: undefined }
    input.data.opportunities = [job]; input.data.scheduleNodes = [node]
    await module.replaceLocalSnapshotFromCloud(input)
    const rawNode = (await (await module.dbPromise).get('scheduleNodes', node.id))!
    await module.replaceImportedData({ opportunities: [job], processes: [], actions: [], prep: [], applicationGroups: [],
      summary: { filename: 'safe-history-retention.xlsx', importedAt: '2026-09-28T12:00:00.000Z', opportunities: 1, pending: 0, processes: 0, prep: 0, applicationGroups: 0, actions: 0 } })
    return { before: rawNode, after: await (await module.dbPromise).get('scheduleNodes', node.id), snapshot: await module.exportLocalSnapshot() }
  }, { input: historyActionWorkspace(), state })
  expect(evidence.after).toEqual(evidence.before)
  await page.reload(); await expect(page.getByTestId('cgr02-today')).toBeVisible()
})

for (const marker of [true, false]) test(`reimport repairs an already missing process without losing historical evidence (baseline ${marker})`, async ({ page }) => {
  await page.clock.install({ time: HISTORY_NOW })
  await page.goto('/'); await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  const evidence = await page.evaluate(async ({ input, marker }) => {
    const module = await import('/pjsdas/src/db.ts')
    const job = { ...input.data.opportunities[0], locallyManaged: false }
    const process = { id: 'restorable-process', opportunityId: job.id, company: job.company, role: job.role,
      stage: 'not_applied' as const, stageLabel: '待投递', progress: 'not_started' as const, result: 'pending' as const,
      participationState: 'active' as const, lastProgressAt: '2026-09-20T00:00:00.000Z' }
    input.data.opportunities = [job]; input.data.processes = [process]
    input.data.scheduleNodes = [{ ...input.data.scheduleNodes![0], processId: process.id }]
    await module.replaceLocalSnapshotFromCloud(input)
    const db = await module.dbPromise
    if (marker) await module.saveDecisionRules(await module.getDecisionRules())
    await db.delete('processes', process.id) // Old released import failure, actual durable invalid stores.
    const before = (await module.exportLocalRecoveryArchive()).stores
    let invalidBefore = false
    try { await module.exportLocalSnapshot() } catch { invalidBefore = true }
    await module.replaceImportedData({ opportunities: [job], processes: [process], actions: [], prep: [], applicationGroups: [],
      summary: { filename: 'restore-missing-process.xlsx', importedAt: '2026-09-28T12:00:00.000Z', opportunities: 1, pending: 0, processes: 1, prep: 0, applicationGroups: 0, actions: 0 } })
    return { invalidBefore, before, after: (await module.exportLocalRecoveryArchive()).stores, snapshot: await module.exportLocalSnapshot() }
  }, { input: historyActionWorkspace(), marker })
  expect(evidence.invalidBefore).toBe(true)
  expect(evidence.snapshot.data.processes.some(p => p.id === 'restorable-process')).toBe(true)
  for (const node of evidence.before.scheduleNodes) expect(evidence.after.scheduleNodes).toContainEqual(node)
  for (const row of evidence.before.timeline) expect(evidence.after.timeline).toContainEqual(row)
  await page.reload(); await expect(page.getByTestId('cgr02-today')).toBeVisible()
})

for (const status of ['done', 'skipped'] as const) test(`first reimport retains undated ${status} action history even when omitted`, async ({ page }) => {
  await page.clock.install({ time: HISTORY_NOW }); await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const result = await page.evaluate(async ({ input, status }) => {
    const db = await import('/pjsdas/src/db.ts')
    const job = { ...input.data.opportunities[0], locallyManaged: false }
    input.data.opportunities = [job]; input.data.scheduleNodes = []; input.data.timeline = []
    input.data.actions = [{ ...input.data.actions[0], status, dueAt: undefined, duePrecision: undefined, sourceLabel: 'Excel' }]
    await db.replaceLocalSnapshotFromCloud(input)
    await db.replaceImportedData({ opportunities: [job], processes: [], actions: [], prep: [], applicationGroups: [],
      summary: { filename: 'omitted-terminal.xlsx', importedAt: '2026-09-28T12:00:00.000Z', opportunities: 1, pending: 0, processes: 0, prep: 0, applicationGroups: 0, actions: 0 } })
    return (await db.exportLocalRecoveryArchive()).stores.timeline
  }, { input: historyActionWorkspace(), status })
  expect(result.some((r: any) => r.kind === 'action_status_changed' && r.actionId === 'history-task' && r.changes?.status?.after === status)).toBe(true)
})

for (const kind of ['manual', 'apply'] as const) test(`reimport versions a moved ${kind} deadline without erasing elapsed occurrence`, async ({ page }) => {
  await page.clock.install({ time: HISTORY_NOW }); await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const result = await page.evaluate(async ({ input, kind }) => {
    const db = await import('/pjsdas/src/db.ts')
    const job = { ...input.data.opportunities[0], locallyManaged: false, deadline: kind === 'apply' ? '2026-09-20' : undefined, deadlinePrecision: 'date' as const }
    const action = { ...input.data.actions[0], kind, status: 'todo' as const, dueAt: '2026-09-20', duePrecision: 'date' as const, sourceLabel: 'Excel' }
    input.data.opportunities = [job]; input.data.actions = [action]; input.data.scheduleNodes = []
    await db.replaceLocalSnapshotFromCloud(input)
    const before = (await db.exportLocalSnapshot()).data.scheduleNodes!
    const bundle = { opportunities: [{ ...job, deadline: kind === 'apply' ? '2026-10-20' : undefined }], processes: [],
      actions: [{ ...action, dueAt: '2026-10-20' }], prep: [], applicationGroups: [],
      summary: { filename: 'moved-deadline.xlsx', importedAt: '2026-09-28T12:00:00.000Z', opportunities: 1, pending: 0, processes: 0, prep: 0, applicationGroups: 0, actions: 1 } }
    await db.replaceImportedData(bundle)
    const after = await db.exportLocalSnapshot()
    await db.replaceImportedData(bundle)
    return { before, after, again: await db.exportLocalSnapshot() }
  }, { input: historyActionWorkspace(), kind })
  expect(result.after.data.actions[0].dueAt).toBe('2026-10-20')
  for (const old of result.before) {
    const retained = result.after.data.scheduleNodes!.find(n => n.id === old.id)!
    expect(retained.temporal).toEqual(old.temporal); expect(retained.state).toBe('superseded')
    const next = result.after.data.scheduleNodes!.find(n => n.id === retained.supersededByNodeId)!
    expect(next.temporal.date).toBe('2026-10-20'); expect(next.version).toBe(old.version + 1)
  }
  expect(result.again.data.scheduleNodes).toEqual(result.after.data.scheduleNodes)
  await page.reload(); await expect(page.getByTestId('cgr02-today')).toBeVisible()
})

for (const kind of ['manual', 'apply'] as const) test(`reimport clears and reintroduces ${kind} deadline with an auditable version chain`, async ({ page }) => {
  await page.clock.install({ time: HISTORY_NOW }); await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const result = await page.evaluate(async ({ input, kind }) => {
    const db = await import('/pjsdas/src/db.ts')
    const job = { ...input.data.opportunities[0], locallyManaged: false, deadline: kind === 'apply' ? '2026-09-20' : undefined, deadlinePrecision: 'date' as const }
    const action = { ...input.data.actions[0], kind, status: 'todo' as const, dueAt: '2026-09-20', duePrecision: 'date' as const, sourceLabel: 'Excel' }
    input.data.opportunities = [job]; input.data.actions = [action]; input.data.scheduleNodes = []
    await db.replaceLocalSnapshotFromCloud(input)
    const before = (await db.exportLocalSnapshot()).data.scheduleNodes!
    const bundle = { opportunities: [{ ...job, deadline: undefined }], processes: [], actions: [{ ...action, dueAt: undefined }], prep: [], applicationGroups: [],
      summary: { filename: 'cleared-deadline.xlsx', importedAt: '2026-09-28T12:00:00.000Z', opportunities: 1, pending: 0, processes: 0, prep: 0, applicationGroups: 0, actions: 1 } }
    await db.replaceImportedData(bundle)
    const cleared = await db.exportLocalSnapshot()
    await db.replaceImportedData(bundle)
    const repeat = await db.exportLocalSnapshot()
    await db.replaceImportedData({ ...bundle, opportunities: [{ ...job, deadline: kind === 'apply' ? '2026-10-20' : undefined }], actions: [{ ...action, dueAt: '2026-10-20' }] })
    const restored = await db.exportLocalSnapshot()
    const active = restored.data.scheduleNodes!.find(n => n.state === 'scheduled')!
    const cancel = (await import('/pjsdas/src/domainCommands.ts')).applyUserDomainCommand(restored,
      { commandId: 'real-user-cancel', kind: 'cancel_occurrence', occurrenceId: active.occurrenceId }, new Date('2026-09-28T12:01:00.000Z'))
    if (cancel.status !== 'APPLIED') throw Error('Expected actual cancellation')
    await db.replaceLocalSnapshotFromCloud(cancel.snapshot)
    await db.replaceImportedData({ ...bundle, opportunities: [{ ...job, deadline: kind === 'apply' ? '2026-11-20' : undefined }], actions: [{ ...action, dueAt: '2026-11-20' }] })
    return { before, cleared, repeat, restored, cancelled: cancel.snapshot, afterCancelImport: await db.exportLocalSnapshot() }
  }, { input: historyActionWorkspace(), kind })
  expect(result.cleared.data.actions[0].dueAt).toBeUndefined()
  expect(result.cleared.data.opportunities[0].deadline).toBeUndefined()
  expect(result.repeat.data.scheduleNodes).toEqual(result.cleared.data.scheduleNodes)
  for (const old of result.before) {
    const retained = result.cleared.data.scheduleNodes!.find(n => n.id === old.id)!
    expect(retained.temporal).toEqual(old.temporal); expect(retained.state).toBe('superseded')
    const withdrawn = result.cleared.data.scheduleNodes!.find(n => n.id === retained.supersededByNodeId)!
    expect(withdrawn.state).toBe('cancelled'); expect(withdrawn.temporal).toEqual(old.temporal)
    const latest = result.restored.data.scheduleNodes!.find(n => n.version === withdrawn.version + 1)!
    expect(latest.temporal.date).toBe('2026-10-20'); expect(latest.supersedesNodeId).toBe(withdrawn.id)
  }
  expect(result.restored.data.actions[0].dueAt).toBe('2026-10-20')
  expect(result.afterCancelImport.data.scheduleNodes).toEqual(result.cancelled.data.scheduleNodes)
  await page.reload(); await expect(page.getByTestId('cgr02-today')).toBeVisible()
})

 test('versioned import omission and reappearance preserve every occurrence link', async ({ page }) => {
  await page.clock.install({ time: HISTORY_NOW }); await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const result = await page.evaluate(async (input) => {
    const db = await import('/pjsdas/src/db.ts')
    const job = { ...input.data.opportunities[0], locallyManaged: false, deadline: undefined }
    const action = { ...input.data.actions[0], kind: 'manual' as const, status: 'todo' as const, dueAt: '2026-10-10', duePrecision: 'date' as const, sourceLabel: 'Excel' }
    input.data.opportunities = [job]; input.data.actions = [action]; input.data.scheduleNodes = []
    await db.replaceLocalSnapshotFromCloud(input)
    const bundle = { opportunities: [job], processes: [], actions: [{ ...action, dueAt: '2026-10-20' }], prep: [], applicationGroups: [],
      summary: { filename: 'omission.xlsx', importedAt: '2026-09-28T12:00:00.000Z', opportunities: 1, pending: 0, processes: 0, prep: 0, applicationGroups: 0, actions: 1 } }
    await db.replaceImportedData(bundle)
    const moved = await db.exportLocalSnapshot()
    await db.replaceImportedData({ ...bundle, actions: [] })
    const omitted = await db.exportLocalSnapshot()
    await db.replaceImportedData(bundle)
    return { moved, omitted, restored: await db.exportLocalSnapshot() }
  }, historyActionWorkspace())
  expect(result.omitted.data.scheduleNodes).toEqual(result.moved.data.scheduleNodes)
  expect(result.restored.data.scheduleNodes).toEqual(result.moved.data.scheduleNodes)
  expect(result.restored.data.scheduleNodes!.some(n => n.state === 'scheduled' && n.version === 2)).toBe(true)
  for (const node of result.restored.data.scheduleNodes!) if (node.supersededByNodeId) {
    expect(result.restored.data.scheduleNodes!.some(n => n.id === node.supersededByNodeId)).toBe(true)
  }
  await page.reload(); await expect(page.getByTestId('cgr02-today')).toBeVisible()
})

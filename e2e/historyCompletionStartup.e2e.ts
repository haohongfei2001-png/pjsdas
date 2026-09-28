import { expect, test, type Page } from '@playwright/test'
import { action, opportunity, seedSession, BACKEND, cors, health } from './fixtures/todayWorkspace.js'
import { upgradeSnapshotToLatest } from '../src/snapshot.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import type { ScheduleNode } from '../src/model.js'

const NOW = new Date('2026-09-28T12:00:00.000Z')
const OLD = '2026-09-20T00:00:00.000Z'
const job = opportunity('history-job', 'History startup company', 'Engineer')
const task = action('history-task', 'History task', job.id)
const offsetTask = { ...action('offset-task', 'Offset task', job.id), dueAt: '2026-09-29T10:00:00+08:00', duePrecision: 'datetime' as const }
const history = { id: 'prior-history', kind: 'opportunity_added' as const, category: 'data' as const, source: 'user_action' as const,
  opportunityId: job.id, title: 'Historical job', occurredAt: OLD, recordedAt: OLD }

function historicalNodes(actionId: string): ScheduleNode[] {
  return ['elapsed_unresolved', 'completed', 'superseded', 'legacy', 'completed_unknown'].map((state, index) => ({
    id: `history-node-${index}`, occurrenceId: `history-occurrence-${index}`, version: 1,
    opportunityId: job.id, kind: 'follow_up', state: state === 'legacy' ? 'scheduled' : state === 'completed_unknown' ? 'completed' : state as ScheduleNode['state'],
    temporal: { shape: 'deadline', precision: 'datetime', timezone: 'source-offset', deadlineAt: '2026-09-20T10:00:00+08:00',
      resolutionBasis: state === 'legacy' ? 'legacy_projection' : 'source_explicit' },
    completedAt: state === 'completed' ? OLD : undefined,
    evidenceRefs: ['retained:source'], sourceVersionRefs: ['retained:version'], relatedActionIds: [actionId], relatedPrepIds: [],
    constraintKind: 'user_soft', createdAt: OLD, updatedAt: OLD,
  }))
}

async function readStore(page: Page, store: string) {
  return page.evaluate(async (store) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('pjsdas', 11); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const result = await new Promise<any[]>((resolve, reject) => { const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    db.close(); return result
  }, store)
}
async function putRows(page: Page, records: Record<string, unknown[]>) {
  await page.evaluate(async (records) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('pjsdas', 11); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const tx = db.transaction(Object.keys(records), 'readwrite')
    for (const [store, rows] of Object.entries(records)) for (const row of rows) tx.objectStore(store).put(row)
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) }); db.close()
  }, records)
}
async function openHistoricalJob(page: Page) {
  await page.goto('/pjsdas/schedule?view=past')
  await page.locator('.tsui-schedule-row').filter({ hasText: 'Historical job' }).click()
  await page.getByRole('button', { name: /查看岗位详情|View job details/ }).click()
}
async function assertStartup(page: Page) {
  for (const [path, locator] of [['today', '[data-testid="cgr02-today"]'], ['schedule', '.tsui-schedule-page'], ['library/history-job', '.job-detail-page']]) {
    await page.goto('/pjsdas/' + path)
    await expect(page.locator(locator)).toBeVisible()
    await page.reload()
    await expect(page.locator(locator)).toBeVisible()
  }
}

test('past entry ordinary completion keeps terminal/elapsed/legacy/multiple occurrences intact across durable restart', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.clock.install({ time: NOW })
  await page.goto('/')
  await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  const nodes = historicalNodes(task.id)
  await putRows(page, { opportunities: [job], actions: [task, offsetTask], timeline: [history], scheduleNodes: nodes })
  await openHistoricalJob(page)
  const before = (await readStore(page, 'scheduleNodes')).filter((node) => node.id.startsWith('history-node-'))
  await page.locator('.opportunity-detail-action-list article').filter({ hasText: 'History task' }).getByRole('button', { name: /标记完成|Mark done/ }).click()
  await expect.poll(async () => (await readStore(page, 'actions')).find((row) => row.id === task.id)?.status).toBe('done')
  expect((await readStore(page, 'scheduleNodes')).filter((node) => node.id.startsWith('history-node-'))).toEqual(before)
  expect((await readStore(page, 'timeline')).find((row) => row.id === history.id)).toEqual(history)
  await assertStartup(page)
  // A fresh page discards React/module memory and opens the same durable IndexedDB.
  const restarted = await context.newPage()
  await restarted.goto('/pjsdas/today')
  await restarted.clock.setFixedTime(NOW)
  await page.close()
  await assertStartup(restarted)
  expect((await readStore(restarted, 'actions')).find((row) => row.id === task.id)?.status).toBe('done')
  expect((await readStore(restarted, 'scheduleNodes')).filter((node) => node.id.startsWith('history-node-'))).toEqual(before)
  expect(errors).toEqual([])
})

test('connected historical apply requires explicit I applied and persists the real domain command without rewriting history', async ({ page, context }) => {
  await seedSession(context)
  await page.clock.install({ time: NOW })
  const apply = { ...task, id: 'apply:history-job', kind: 'apply' as const, title: 'Historical application' }
  const snapshot = upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 1, exportedAt: OLD,
    data: { opportunities: [job], actions: [apply, offsetTask], processes: [], processEvents: [], prep: [], applicationGroups: [], timeline: [history], scheduleNodes: historicalNodes(apply.id) } })
  const state = { snapshot, revision: 7 }
  const commands: any[] = []
  await context.route(BACKEND + '/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return cors(route, {}, 204)
    const url = new URL(route.request().url())
    if (url.pathname === '/api/health') return cors(route, health())
    if (url.pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)
    const body = route.request().postDataJSON()
    const read = () => ({ workspaceId: 'ws-history', workspaceVersion: 'txn:' + state.revision, revision: state.revision, schemaVersion: state.snapshot.version, snapshot: state.snapshot })
    if (body.action === 'read') return cors(route, read())
    if (body.action !== 'command' || body.command?.type !== 'domain') return cors(route, { code: 'UNEXPECTED_WRITE' }, 400)
    commands.push(body.command.value)
    const applied = applyUserDomainCommand(state.snapshot, body.command.value, NOW)
    expect(applied.status).toBe('APPLIED')
    state.snapshot = applied.snapshot; state.revision += 1
    return cors(route, { ...read(), outcome: 'COMMITTED', receipt: { commandId: body.commandId, receiptId: 'receipt:' + body.commandId, status: 'COMMITTED', revision: state.revision,
      undoAvailable: true, affectedObjects: [{ type: 'opportunity', id: job.id }], result: { type: 'domain', status: 'APPLIED', summary: applied.summary } } })
  })
  await openHistoricalJob(page)
  const applyRow = page.locator('.opportunity-detail-action-list article').filter({ hasText: apply.title })
  await expect(applyRow).toContainText(/待做|待办|To do/)
  await expect(applyRow.getByRole('button', { name: /标记完成|Mark done/ })).toHaveCount(0)
  const before = structuredClone(state.snapshot.data.scheduleNodes!.filter((node) => node.id.startsWith('history-node-')))
  await page.getByRole('button', { name: /我已投递|I applied/ }).click()
  await expect.poll(() => commands.length).toBe(1)
  expect(commands[0]).toMatchObject({ kind: 'record_application_submission', opportunityId: job.id })
  expect(state.snapshot.data.scheduleNodes!.filter((node) => node.id.startsWith('history-node-'))).toEqual(before)
  await expect.poll(async () => (await readStore(page, 'actions')).find((row) => row.id === apply.id)?.status).toBe('done')
  await assertStartup(page)
  const restarted = await context.newPage(); await restarted.goto('/pjsdas/today'); await restarted.clock.setFixedTime(NOW); await page.close()
  await assertStartup(restarted)
  expect(commands).toHaveLength(1)
  expect(state.snapshot.data.timeline!.find((row) => row.id === history.id)).toEqual(history)
})

for (const trigger of ['initial', 'reload'] as const) test(`startup recovery catches ${trigger} snapshot error, exports every raw record and retries without data loss`, async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  await putRows(page, { opportunities: [job], actions: [task, offsetTask],
    processes: [{ id: 'legacy-process', opportunityId: job.id, company: job.company, role: job.role, stage: 'not_applied', stageLabel: '待投递', lastProgressAt: OLD }],
    timeline: [{ ...history, source: 'invalid-legacy-source' }] })
  const originalStores = Object.fromEntries(await Promise.all(['actions', 'processes', 'scheduleNodes', 'timeline'].map(async (store) => [store, await readStore(page, store)])))
  if (trigger === 'initial') await page.reload()
  else await page.evaluate(() => window.dispatchEvent(new Event('pjsdas:workspace-replaced')))
  await expect(page.getByRole('heading', { name: /Workspace could not open/ })).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /Download recovery backup/ }).click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  let contents = ''; for await (const bytes of stream!) contents += bytes.toString()
  const archive = JSON.parse(contents)
  for (const [store, rows] of Object.entries(originalStores)) {
    expect(archive.stores[store]).toEqual(rows)
    expect(await readStore(page, store)).toEqual(rows)
  }
  expect(archive.stores.timeline.find((row: any) => row.id === history.id).source).toBe('invalid-legacy-source')
  expect(archive.stores.actions.find((row: any) => row.id === task.id)).toEqual(task)
  expect((await readStore(page, 'timeline'))[0].source).toBe('invalid-legacy-source')
  await putRows(page, { timeline: [history] })
  await page.getByRole('button', { name: /重试.*Retry/ }).click()
  await expect(page.getByTestId('cgr02-today')).toBeVisible()
  expect((await readStore(page, 'actions')).find((row) => row.id === task.id)).toEqual(task)
})

test('root boundary contains selector/render exception and retry remounts without deleting durable records', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  await putRows(page, { actions: [task] })
  await page.evaluate(async () => {
    const harness = await import('/pjsdas/e2e/fixtures/startupRecoveryHarness.tsx')
    harness.mount()
  })
  const host = page.locator('#startup-recovery-test')
  await expect(host.getByRole('heading', { name: /Workspace could not open/ })).toBeVisible()
  await page.evaluate(() => { (window as any).__recoveryThrow = false })
  await host.getByRole('button', { name: /重试.*Retry/ }).click()
  await expect(host).toContainText('Recovered render')
  expect((await readStore(page, 'actions')).find((row) => row.id === task.id)).toEqual(task)
})

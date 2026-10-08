import { expect, test, type Page } from '@playwright/test'
import { BACKEND, cors, health, seedSession, session, workspace } from './fixtures/todayWorkspace.js'
import { MOCK_TARGET_AUTH_ORIGIN } from './support/mockCloudTargets.js'
import { applySemanticCompensation, applySemanticIntake } from '../src/semanticIntake.js'
import { applyDomainCompensation, applyUserDomainCommand } from '../src/domainCommands.js'
import { canonicalWorkspaceJson, equivalentReadProjection } from '../src/cloud/workspaceFingerprint.js'
import { semanticIntakeSchema } from '../gateway/semanticIntake.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

// All endpoint evidence in this file is synthetic. The browser runs real Auth,
// cache admission, IndexedDB, interpretation, command, projection, and Undo code.
const NOW = new Date('2026-10-08T02:00:00Z')
const OWNER = 'write-admission-owner'
const JOB = 'A-opp-1'
const JOB_PATH = `/pjsdas/opportunities/${JOB}`
const CAPTURE_TEXT = 'A公司 产品经理 已投递成功。'
const AUTH_MODULE = '**/src/aiAccess/supabaseClient.ts*'
test.use({ timezoneId: 'Asia/Shanghai' })

async function syntheticAuthority(page: Page) {
  let snapshot = workspace('2026-10-08'), revision = 1
  snapshot.data.opportunities = [snapshot.data.opportunities[0]]
  snapshot.data.actions = [snapshot.data.actions[0]]; snapshot.data.scheduleNodes = []; snapshot.data.timeline = []
  const receipts = new Map<string, { input: string; response: any; compensation?: any }>()
  const mutations: Array<{ commandId: string; action: string; type?: string; kind?: string }> = []
  const unexpected: string[] = []
  let reads = 0
  await page.route(`${MOCK_TARGET_AUTH_ORIGIN}/**`, route => route.abort())
  await page.route(BACKEND + '/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (path === '/api/health') return cors(route, health())
    if (path === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: `${OWNER}@example.test` })
    const body = request.postDataJSON()
    const base = () => ({ workspaceId: 'synthetic-write-admission', revision, workspaceVersion: `txn:${revision}`, schemaVersion: snapshot.version, snapshot })
    if (path === '/api/automation-settings' && body?.action === 'read') return cors(route, {
      googleEmail: `${OWNER}@example.test`, gmailScopeGranted: false, gmailEnabled: false, discoveryEnabled: false,
      discoveryReadiness: { profileConfigured: false, budgetState: 'approval_required' },
    })
    if (path === '/api/workspace' && body?.action === 'read') { reads++; return cors(route, base()) }
    if (path === '/api/workspace' && body?.action === 'receipt') {
      const prior = receipts.get(body.commandId)
      return cors(route, { ...base(), found: Boolean(prior), ...(prior?.response ?? {}) })
    }
    if (path === '/api/workspace' && (body?.action === 'command' || body?.action === 'undo')) {
      // Count attempts before validation, so a rejected server request cannot
      // make the blocked-write assertion appear to pass.
      mutations.push({ commandId: body.commandId, action: body.action, type: body.command?.type, kind: body.command?.value?.kind })
      const input = JSON.stringify(body.command ?? body.targetCommandId)
      const prior = receipts.get(body.commandId)
      if (prior) return prior.input === input
        ? cors(route, { ...base(), ...prior.response, outcome: 'ALREADY_APPLIED' })
        : cors(route, { code: 'COMMAND_ID_REUSED' }, 409)
      if (body.action === 'command' && body.baseRevision !== revision) return cors(route, { code: 'CONFLICT' }, 409)
      try {
        let compensation: any, result: any
        if (body.action === 'undo') {
          const original = receipts.get(body.targetCommandId)?.compensation
          if (!original) return cors(route, { code: 'UNDO_NOT_AVAILABLE' }, 409)
          snapshot = original.operation === 'semantic_batch'
            ? applySemanticCompensation(snapshot, original, NOW)
            : applyDomainCompensation(snapshot, original, NOW)
          result = { status: 'APPLIED', summary: 'Undone.' }
        } else if (body.command.type === 'semantic_intake') {
          const evaluated = applySemanticIntake(snapshot, semanticIntakeSchema.parse(body.command.value), { authorized: true, workspaceRevision: `txn:${revision}`, now: NOW })
          snapshot = evaluated.snapshot; compensation = evaluated.compensation
          result = { status: evaluated.status, summary: evaluated.summary, semanticReceiptId: evaluated.receipt?.id, decisionRequestIds: evaluated.decisionRequests.map(item => item.id) }
        } else if (body.command.type === 'domain') {
          const evaluated = applyUserDomainCommand(snapshot, body.command.value, NOW)
          snapshot = evaluated.snapshot; compensation = 'compensation' in evaluated ? evaluated.compensation : undefined
          result = { status: evaluated.status, summary: evaluated.summary }
        } else return cors(route, { code: 'UNSUPPORTED_SYNTHETIC_COMMAND' }, 422)
        revision++
        const response = { outcome: 'COMMITTED', result, receipt: { commandId: body.commandId, receiptId: `receipt:${body.commandId}`,
          status: 'COMMITTED', revision, undoAvailable: Boolean(compensation), undoCompensation: compensation, result } }
        receipts.set(body.commandId, { input, response, compensation })
        return cors(route, { ...base(), ...response })
      } catch (error) { return cors(route, { code: 'INVALID_COMMAND', message: String(error) }, 422) }
    }
    unexpected.push(`${request.method()} ${path}`)
    return cors(route, { code: 'UNEXPECTED_SYNTHETIC_REQUEST' }, 409)
  })
  return { mutations, receipts, unexpected, get snapshot() { return snapshot }, get revision() { return revision }, get reads() { return reads },
    setSnapshot(next: PJSDASSnapshot) { snapshot = structuredClone(next) } }
}
type SyntheticAuthority = Awaited<ReturnType<typeof syntheticAuthority>>

async function admission(page: Page) {
  return page.evaluate(async () => {
    const auth = await import('/pjsdas/src/cloud/accountCacheLease.ts')
    const sync = await import('/pjsdas/src/cloud/syncState.ts')
    return { resolved: auth.isAccountCacheSessionResolved(), account: auth.currentAccountCacheSession() ?? null,
      owner: sync.getCloudDeviceState().workspaceOwnerUserId ?? null }
  })
}

async function localSnapshot(page: Page): Promise<PJSDASSnapshot> {
  return page.evaluate(async () => (await import('/pjsdas/src/db.ts')).exportLocalSnapshot())
}

async function durableEvidence(page: Page) {
  return page.evaluate(async () => {
    const api = await import('/pjsdas/src/db.ts')
    const fingerprints = await import('/pjsdas/src/cloud/workspaceFingerprint.ts')
    const snapshot = await api.exportLocalSnapshot()
    const db = await api.dbPromise
    const stores = [...db.objectStoreNames]
    const tx = db.transaction(stores, 'readonly')
    // Read raw stores rather than the account-filtered recovery export: a
    // newly anonymous Auth state must not hide retained journal rows here.
    const rows = await Promise.all(stores.map(async store => [store, await tx.objectStore(store).getAll()]))
    await tx.done
    const outbox = Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('pjsdas-cgr01-pending:'))
      .sort().map(key => [key, localStorage.getItem(key)]))
    return { canonical: fingerprints.canonicalWorkspaceJson(snapshot), stores: Object.fromEntries(rows), outbox,
      binding: localStorage.getItem('pjsdas-google-drive-sync-state-v2'),
      provenance: localStorage.getItem('todayaction-mock-cache-provenance-v1') }
  })
}

async function bootstrapBoundAccount(page: Page) {
  await seedSession(page.context(), OWNER, 'synthetic-write-admission-token')
  await page.clock.setFixedTime(NOW)
  const server = await syntheticAuthority(page)
  await page.goto(JOB_PATH)
  await expect(page.getByRole('heading', { name: '产品经理', exact: true })).toBeVisible()
  await expect.poll(() => admission(page)).toEqual({ resolved: true, account: OWNER, owner: OWNER })
  await expect.poll(() => page.evaluate(owner => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.[owner]?.lastSyncedVersion, OWNER)).toBe('txn:1')
  await expect.poll(() => page.evaluate(async () => {
    const proof = await import('/pjsdas/src/cloud/mockCacheBoundary.ts')
    const sync = await import('/pjsdas/src/cloud/syncState.ts')
    return proof.canMountMockAccountCache(localStorage, sync.getCloudDeviceState)
  })).toBe(true)
  expect((await localSnapshot(page)).data.opportunities.find(item => item.id === JOB)?.processStage).toBe('not_applied')
  expect(server.mutations).toEqual([])
  return server
}

async function delayAuthModule(page: Page) {
  let signalEntered!: () => void, release!: (outcome: 'continue' | 'abort') => void
  const entered = new Promise<void>(resolve => { signalEntered = resolve })
  const gate = new Promise<'continue' | 'abort'>(resolve => { release = resolve })
  let requests = 0
  await page.route(AUTH_MODULE, async route => {
    requests++
    signalEntered()
    const outcome = await gate
    if (outcome === 'abort') await route.abort('failed')
    else await route.continue()
  })
  return { entered, release, get requests() { return requests } }
}

async function attemptBlockedWrites(page: Page, before: Awaited<ReturnType<typeof durableEvidence>>, server: SyntheticAuthority) {
  await expect(page.getByRole('heading', { name: '产品经理', exact: true })).toBeVisible()
  await expect.poll(() => admission(page)).toEqual({ resolved: false, account: null, owner: OWNER })
  await page.getByRole('button', { name: '我已投递', exact: true }).click()
  await expect(page.locator('.job-detail-page').getByRole('alert')).toContainText('Account not confirmed')
  await expect(page.locator('.job-detail-page').getByRole('status').filter({ hasText: /已记录投递|Application recorded/ })).toHaveCount(0)
  await expect(page.locator('.action-undo-toast')).toHaveCount(0)
  await expect(page.locator('.job-detail-page').getByRole('button', { name: '撤销', exact: true })).toHaveCount(0)
  expect(await durableEvidence(page)).toEqual(before)
  expect(server.mutations).toEqual([])

  const task = page.locator('.opportunity-detail-action-list article').filter({ hasText: 'A第一任务' })
  await task.getByRole('button', { name: '标记完成', exact: true }).click()
  await expect(page.locator('.action-undo-toast')).toContainText('Account not confirmed')
  await expect(page.locator('.action-undo-toast strong')).toHaveText('操作未确认')
  await expect(page.locator('.action-undo-toast').getByRole('button', { name: '撤销', exact: true })).toHaveCount(0)
  expect((await localSnapshot(page)).data.actions.find(item => item.id === 'A-action-1')?.status).toBe('todo')
  expect(await durableEvidence(page)).toEqual(before)
  expect(server.mutations).toEqual([])

  await page.locator('.tsui-primary-nav').getByRole('button', { name: '今天', exact: true }).click()
  const capacity = page.locator('.tsui-capacity')
  const summary = capacity.locator('summary')
  await expect(summary).toBeVisible()
  const priorCapacity = await summary.innerText()
  await summary.click()
  await capacity.getByRole('spinbutton', { name: '今天可用小时', exact: true }).fill('5')
  await capacity.getByRole('spinbutton', { name: '今天可用小时', exact: true }).blur()
  await expect(capacity.getByRole('alert')).toContainText('Account not confirmed')
  await expect(summary).toHaveText(priorCapacity)
  expect(await durableEvidence(page)).toEqual(before)
  expect(server.mutations).toEqual([])

  await page.getByRole('button', { name: '＋ 告诉 TodayAction', exact: true }).click()
  await page.getByRole('textbox', { name: '要告诉 TodayAction 的内容' }).fill(CAPTURE_TEXT)
  await page.getByRole('button', { name: '确认并保存', exact: true }).click()
  await expect(page.locator('.cgr-capture-error')).toContainText('账号尚未确认')
  await expect(page.locator('.cgr-capture-receipt')).toHaveCount(0)
  await expect(page.locator('.cgr-capture-sheet').getByRole('button', { name: '撤销', exact: true })).toHaveCount(0)
  await expect(page.locator('.cgr-understanding [data-state]')).toHaveAttribute('data-state', 'auth_unconfirmed')
  await expect(page.getByRole('textbox', { name: '要告诉 TodayAction 的内容' })).toHaveValue(CAPTURE_TEXT)
  expect(await durableEvidence(page)).toEqual(before)
  expect(server.mutations).toEqual([])
  expect(server.snapshot.data.opportunities[0].processStage).toBe('not_applied')
}

async function authoritativeReadback(page: Page, server: SyntheticAuthority, stage: 'not_applied' | 'screening') {
  await expect.poll(() => page.evaluate(owner => JSON.parse(localStorage.getItem(`pjsdas-cgr01-pending:${owner}`) ?? '[]').length, OWNER)).toBe(0)
  const readsBefore = server.reads
  const remote = await page.evaluate(async owner => (await import('/pjsdas/src/cloud/connectedWorkspaceRepository.ts')).fetchConnectedRemoteWorkspace(owner), OWNER)
  expect(server.reads).toBeGreaterThan(readsBefore)
  expect(remote.version).toBe(`txn:${server.revision}`)
  expect(canonicalWorkspaceJson(remote.snapshot)).toBe(canonicalWorkspaceJson(server.snapshot))
  expect(remote.snapshot.data.opportunities.find(item => item.id === JOB)?.processStage).toBe(stage)
  await expect.poll(async () => equivalentReadProjection(await localSnapshot(page), remote.snapshot)).toBe(true)
}

test('bound cache rejects job and capture while both Auth imports wait, then retries authoritative commit and Undo', async ({ page }) => {
  const server = await bootstrapBoundAccount(page)
  const before = await durableEvidence(page)
  const delayed = await delayAuthModule(page)
  try {
    // Supabase is dynamically imported by both getSession and subscription.
    // DOMContentLoaded allows the real app UI to render while those stay pending.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await delayed.entered
    expect(delayed.requests).toBeGreaterThan(0)
    await attemptBlockedWrites(page, before, server)
    await page.locator('.cgr-capture-sheet').getByRole('button', { name: '关闭', exact: true }).click()
    delayed.release('continue')
    await expect.poll(() => admission(page)).toEqual({ resolved: true, account: OWNER, owner: OWNER })

    await page.goto(JOB_PATH)
    await expect.poll(() => admission(page)).toEqual({ resolved: true, account: OWNER, owner: OWNER })

    await page.getByRole('button', { name: '我已投递', exact: true }).click()
    const instantUndo = page.locator('.action-undo-toast').getByRole('button', { name: '撤销', exact: true })
    await expect(instantUndo).toBeVisible()
    await expect.poll(() => server.mutations.length).toBe(1)
    expect(server.mutations[0]).toMatchObject({ action: 'command', type: 'domain', kind: 'record_application_submission' })
    await authoritativeReadback(page, server, 'screening')
    await instantUndo.click()
    await expect.poll(() => server.mutations.length).toBe(2)
    expect(server.mutations[1].action).toBe('undo')
    await authoritativeReadback(page, server, 'not_applied')

    await page.getByRole('button', { name: '＋ 告诉 TodayAction', exact: true }).click()
    await page.getByRole('textbox', { name: '要告诉 TodayAction 的内容' }).fill(CAPTURE_TEXT)
    await page.getByRole('button', { name: '确认并保存', exact: true }).click()
    await expect(page.locator('.cgr-capture-receipt')).toContainText('已记录明确事实')
    await expect.poll(() => server.mutations.length).toBe(3)
    expect(server.mutations[2]).toMatchObject({ action: 'command', type: 'semantic_intake' })
    await authoritativeReadback(page, server, 'screening')
    await page.locator('.cgr-capture-receipt').getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.locator('.cgr-capture-receipt')).toContainText('已撤销')
    await expect.poll(() => server.mutations.length).toBe(4)
    expect(server.mutations[3].action).toBe('undo')
    await authoritativeReadback(page, server, 'not_applied')
    expect(server.receipts.size).toBe(4)
    expect(server.unexpected).toEqual([])
  } finally { delayed.release('continue') }
})

test('failed Auth module never becomes anonymous write permission or clears the bound cache', async ({ page }) => {
  const server = await bootstrapBoundAccount(page)
  const before = await durableEvidence(page)
  const delayed = await delayAuthModule(page)
  const failed = page.waitForEvent('requestfailed', request => request.url().includes('/src/aiAccess/supabaseClient.ts'))
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await delayed.entered
    delayed.release('abort')
    expect((await failed).failure()).not.toBeNull()
    await attemptBlockedWrites(page, before, server)
    expect(await durableEvidence(page)).toEqual(before)
    expect(server.revision).toBe(1)
    expect(server.receipts.size).toBe(0)
    expect(server.unexpected).toEqual([])
  } finally { delayed.release('abort') }
})

test('confirmed anonymous unbound workspace still supports local capture and Undo without a server mutation', async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  const server = await syntheticAuthority(page)
  await page.goto('/pjsdas/today/capture')
  await expect.poll(() => admission(page)).toEqual({ resolved: true, account: null, owner: null })
  const before = await localSnapshot(page)
  const text = '明天 15:00 准备材料'
  await page.getByRole('textbox', { name: '要告诉 TodayAction 的内容' }).fill(text)
  await page.getByRole('button', { name: '确认并保存', exact: true }).click()
  await expect(page.locator('.cgr-capture-receipt')).toContainText('已记录明确事实')
  let local = await localSnapshot(page)
  expect(local.data.actions.find(item => item.title === text)?.scheduledTemporal?.startAt).toBe('2026-10-09T15:00:00+08:00')
  expect(local.data.semanticReceipts?.some(item => item.status === 'committed' && item.undoAvailable)).toBe(true)
  await page.locator('.cgr-capture-receipt').getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.locator('.cgr-capture-receipt')).toContainText('已撤销')
  local = await localSnapshot(page)
  expect(local.data.actions).toEqual(before.data.actions)
  expect(local.data.opportunities).toEqual(before.data.opportunities)
  expect(local.data.semanticReceipts?.some(item => item.status === 'undone' && !item.undoAvailable)).toBe(true)
  expect(await admission(page)).toEqual({ resolved: true, account: null, owner: null })
  const evidence = await durableEvidence(page)
  expect(evidence.outbox).toEqual({})
  expect(evidence.stores.commandInteractions).toEqual([])
  expect(evidence.stores.projectionDeltas).toEqual([])
  expect(server.mutations).toEqual([])
  expect(server.reads).toBe(0)
  expect(server.unexpected).toEqual([])
})

test('anonymous completion Undo cannot restore an action after real login binds the same completed postimage', async ({ page }) => {
  // Freeze Date only. The real eight-second toast timer and normal Auth timers
  // remain unchanged; login and the stale click happen immediately after completion.
  await page.clock.setFixedTime(NOW)
  const server = await syntheticAuthority(page)
  await page.route(`${MOCK_TARGET_AUTH_ORIGIN}/auth/v1/user`, route => route.request().method() === 'OPTIONS'
    ? cors(route, {}, 204) : cors(route, session(OWNER, 'synthetic-user-fixture').user))
  await page.goto('/pjsdas/today')
  await expect.poll(() => admission(page)).toEqual({ resolved: true, account: null, owner: null })
  await page.evaluate(async snapshot => {
    await (await import('/pjsdas/src/db.ts')).restoreLocalSnapshot(snapshot)
    window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
  }, server.snapshot)
  await page.goto(JOB_PATH)
  await expect.poll(() => admission(page)).toEqual({ resolved: true, account: null, owner: null })
  const task = page.locator('.opportunity-detail-action-list article').filter({ hasText: 'A第一任务' })
  await task.getByRole('button', { name: '标记完成', exact: true }).click()
  const toast = page.locator('.action-undo-toast')
  const oldUndo = toast.getByRole('button', { name: '撤销', exact: true })
  await expect(toast.locator('strong')).toHaveText('已完成')
  await expect(oldUndo).toBeVisible()
  const completed = await localSnapshot(page)
  expect(completed.data.actions.find(item => item.id === 'A-action-1')?.status).toBe('done')
  expect(server.mutations).toEqual([])
  // The existing server postimage agrees with the anonymous completion, so
  // normal login can bind it without clearing data or manufacturing a command.
  server.setSnapshot(completed)
  await page.evaluate(async ({ owner, issuer }) => {
    const { pjsdasSupabase } = await import('/pjsdas/src/aiAccess/supabaseClient.ts')
    const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
    const access_token = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ sub: owner, iss: issuer, exp: Math.floor(Date.now() / 1000) + 3600, aud: 'authenticated' })}.${encode('synthetic-signature')}`
    const result = await pjsdasSupabase.auth.setSession({ access_token, refresh_token: 'synthetic-write-admission-refresh' })
    if (result.error) throw result.error
  }, { owner: OWNER, issuer: `${MOCK_TARGET_AUTH_ORIGIN}/auth/v1` })
  await expect.poll(() => admission(page)).toEqual({ resolved: true, account: OWNER, owner: OWNER })
  await expect.poll(() => page.evaluate(async () => {
    const proof = await import('/pjsdas/src/cloud/mockCacheBoundary.ts')
    const sync = await import('/pjsdas/src/cloud/syncState.ts')
    return proof.canMountMockAccountCache(localStorage, sync.getCloudDeviceState)
  })).toBe(true)
  // Require the actual old toast to survive long enough to exercise its handler;
  // expiry alone must not turn this regression into a false passing test.
  await expect(oldUndo).toBeVisible()
  const beforeUndo = await durableEvidence(page)
  expect(beforeUndo.canonical).toBe(canonicalWorkspaceJson(completed))
  await oldUndo.click()
  await expect(oldUndo).toHaveCount(0)
  await expect(toast.filter({ hasText: /已撤销|Undone/ })).toHaveCount(0)
  expect(await durableEvidence(page)).toEqual(beforeUndo)
  expect((await localSnapshot(page)).data.actions.find(item => item.id === 'A-action-1')?.status).toBe('done')
  expect(server.snapshot.data.actions.find(item => item.id === 'A-action-1')?.status).toBe('done')
  expect(server.mutations).toEqual([])
  expect(server.receipts.size).toBe(0)
  expect(server.revision).toBe(1)
  expect(server.unexpected).toEqual([])
})

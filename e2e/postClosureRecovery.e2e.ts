import { freezeTodayFixture } from './support/consumerFixtureClock.js'
import { installAccountClearFault } from './support/accountClearFault.js'
import { expect, test } from '@playwright/test'
import { AUTH_KEY, BACKEND, cors, health, session, workspace } from './fixtures/todayWorkspace.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

test.beforeEach(async ({ page }) => { await freezeTodayFixture(page) })

for (const trigger of ['auth-expiry', 'settings-sign-out'] as const)
for (const failure of ['partial-clear-throw', 'transaction-abort'] as const) test(`${trigger} ${failure} reaches lossless recovery without leaving the expired account interactive`, async ({ page }, info) => {
  const snapshot = workspace()
  const requests: Array<{ token: string; action: string }> = []
  await page.addInitScript(({ key, value }) => {
    if (!localStorage.getItem('pcr-auth-seeded')) {
      localStorage.setItem(key, JSON.stringify(value))
      localStorage.setItem('pcr-auth-seeded', '1')
    }
  }, { key: AUTH_KEY, value: session('account-a', 'token-a') })
  await page.route('https://*.supabase.co/auth/v1/**', route => cors(route, {}, 200))
  await page.route(BACKEND + '/**', route => {
    if (route.request().method() === 'OPTIONS') return cors(route, {}, 204)
    if (new URL(route.request().url()).pathname === '/api/health') return cors(route, health())
    if (new URL(route.request().url()).pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)
    const body = route.request().postDataJSON()
    requests.push({ token: route.request().headers().authorization ?? '', action: body.action })
    if (body.action !== 'read') return cors(route, { code: 'UNEXPECTED_WRITE' }, 409)
    return cors(route, { workspaceId: 'ws-a', workspaceVersion: 'txn:7', revision: 7, schemaVersion: snapshot.version, snapshot })
  })
  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['account-a']?.lastSyncedVersion)).toBe('txn:7')
  if (trigger === 'settings-sign-out') {
    await page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ }).click()
    await page.getByLabel('管理账号与同步', { exact: true }).click()
    await expect(page.getByRole('button', { name: '退出 TodayAction' })).toBeVisible()
    // Exercise sign-out recovery after the control is stable. Expiry cases
    // retain automatic synchronization and their independent auth trigger.
    await page.getByLabel('自动同步', { exact: true }).uncheck()
    await expect(page.getByRole('button', { name: '退出 TodayAction' })).toBeEnabled()
  }
  const before = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalRecoveryArchive()).stores)
  // Snapshot replacement also clears stores, but includes commandInteractions.
  // Account clearing intentionally preserves those journals. Match its complete
  // transaction scope so a background/pre-sign-out refresh cannot consume the fault.
  const expectedStores = Object.keys(before).filter(name => name !== 'commandInteractions')
  await page.evaluate(installAccountClearFault, { expectedStores, failure, authKey: AUTH_KEY })
  await page.evaluate(async () => {
    const { pjsdasSupabase } = await import('/pjsdas/src/aiAccess/supabaseClient.ts')
    ;(window as any).__pcrAuthEvents = []
    const { data } = pjsdasSupabase.auth.onAuthStateChange((event, session) => {
      ;(window as any).__pcrAuthEvents.push({ event, account: session?.user.id ?? null })
    })
    ;(window as any).__restorePcrAuthProbe = () => data.subscription.unsubscribe()
  })
  let reachedBoundary: { clear: unknown; authEvents: unknown } | undefined
  try {
    if (trigger === 'settings-sign-out') await page.getByRole('button', { name: '退出 TodayAction' }).click()
    else await page.evaluate(async () => {
      // Real auth event, bypassing the UI guard as expiry/another context can do.
      const { pjsdasSupabase } = await import('/pjsdas/src/aiAccess/supabaseClient.ts')
      const result = await pjsdasSupabase.auth.signOut({ scope: 'local' })
      if (result.error) throw result.error
    })
    await Promise.all([
      expect.poll(() => page.evaluate(() => (window as any).__pcrAuthEvents.some((event: any) => event.event === 'SIGNED_OUT' && event.account === null))).toBe(true),
      expect(page.getByRole('heading', { name: /Workspace could not open/ })).toBeVisible(),
    ])
    reachedBoundary = await page.evaluate(() => ({ clear: (window as any).__pcrClearWitness, authEvents: (window as any).__pcrAuthEvents }))
    expect(reachedBoundary.clear).toMatchObject({
      activated: true, scope: [...expectedStores].sort(), authPresentAtFault: false,
    })
    expect(reachedBoundary.authEvents).toContainEqual({ event: 'SIGNED_OUT', account: null })
    await expect(page.getByRole('heading', { name: 'A第一任务' })).toHaveCount(0)
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /Download recovery backup/ }).click()
    const stream = await (await downloadPromise).createReadStream()
    let bytes = ''; for await (const chunk of stream!) bytes += chunk.toString()
    expect(JSON.parse(bytes).stores).toEqual(before)
    expect(await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalRecoveryArchive()).stores)).toEqual(before)
    await page.evaluate(() => (window as any).__restorePcrClear())
    await page.getByRole('button', { name: /Retry/ }).click()
    await expect(page.locator('.startup-recovery')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalRecoveryArchive()).stores.actions.length)).toBe(0)
    await page.goto('/pjsdas/today')
    await expect(page.getByTestId('cgr02-today')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'A第一任务' })).toHaveCount(0)
    expect(requests.every(request => request.action === 'read' && request.token === 'Bearer token-a')).toBe(true)
    await page.reload()
    await expect(page.getByTestId('cgr02-today')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'A第一任务' })).toHaveCount(0)
  } finally {
    // Preserve whether the boundary was reached, rather than only a missing heading.
    const diagnostic = await page.evaluate(() => ({ clear: (window as any).__pcrClearWitness,
      authEvents: (window as any).__pcrAuthEvents,
      guardErrors: Array.from(document.querySelectorAll('.cloud-error')).map(node => node.textContent),
      recoveryVisible: Boolean(document.querySelector('.startup-recovery')),
    })).catch(error => ({ diagnosticError: String(error) }))
    await info.attach('account-clear-boundary.json', { body: JSON.stringify({ ...diagnostic, reachedBoundary }, null, 2), contentType: 'application/json' })
    await page.evaluate(() => { (window as any).__restorePcrClear?.(); (window as any).__restorePcrAuthProbe?.() }).catch(() => undefined)
  }
})

for (const version of [1, 2, 3] as const) test(`legacy snapshot v${version} restores and starts every daily surface after durable restart`, async ({ page, context }) => {
  const snapshot: PJSDASSnapshot = workspace()
  snapshot.version = version
  delete snapshot.data.reminderIntents
  delete snapshot.data.reminderOutbox
  if (version < 3) {
    delete snapshot.data.decisionRequests
    delete snapshot.data.semanticReceipts
  }
  if (version < 2) delete snapshot.data.scheduleNodes
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/pjsdas/today')
  await expect(page.getByTestId('cgr02-today')).toBeVisible()
  await page.evaluate(async snapshot => (await import('/pjsdas/src/db.ts')).restoreLocalSnapshot(snapshot), snapshot)
  const persisted = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalRecoveryArchive()).stores)
  for (const [path, selector] of [['today', '[data-testid="cgr02-today"]'], ['schedule', '.tsui-schedule-page'], ['library/A-opp-1', '.job-detail-page']]) {
    await page.goto('/pjsdas/' + path)
    await expect(page.locator(selector)).toBeVisible()
    await page.reload()
    await expect(page.locator(selector)).toBeVisible()
  }
  const restarted = await context.newPage()
  await freezeTodayFixture(restarted)
  restarted.on('pageerror', error => errors.push(error.message))
  await page.close()
  await restarted.goto('/pjsdas/today')
  await expect(restarted.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  expect(await restarted.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalRecoveryArchive()).stores)).toEqual(persisted)
  expect(errors).toEqual([])
})

import { expect, test } from '@playwright/test'
import { AUTH_KEY, BACKEND, cors, health, session, workspace } from './fixtures/todayWorkspace.js'

test('stale owner conflict follows the latest revision and equivalent cache converges without a click', async ({ page }) => {
  const snapshot = workspace()
  let revision = 843
  let reads = 0
  let holdRead = false
  let releaseRead: (() => void) | undefined
  await page.addInitScript(({ key, value }) => {
    if (!localStorage.getItem('owner-interaction-seeded')) {
      localStorage.setItem(key, JSON.stringify(value))
      localStorage.setItem('owner-interaction-seeded', '1')
    }
  }, { key: AUTH_KEY, value: session('account-a', 'token-a') })
  await page.route('https://*.supabase.co/auth/v1/**', route => cors(route, {}, 200))
  await page.route(`${BACKEND}/**`, async route => {
    if (route.request().method() === 'OPTIONS') return cors(route, {}, 204)
    if (new URL(route.request().url()).pathname === '/api/health') return cors(route, health())
    const body = route.request().postDataJSON()
    expect(body.action).toBe('read')
    reads += 1
    if (holdRead) {
      holdRead = false
      await new Promise<void>(resolve => { releaseRead = resolve })
    }
    return cors(route, { workspaceId: 'ws-a', revision, workspaceVersion: `txn:${revision}`,
      schemaVersion: snapshot.version, snapshot })
  })

  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}')
    .accounts?.['account-a']?.lastSyncedVersion)).toBe('txn:843')
  await page.evaluate(async () => {
    const { patchAccountCheckpoint } = await import('/pjsdas/src/cloud/syncState.ts')
    patchAccountCheckpoint('account-a', { conflict: {
      remoteVersion: 'txn:843', remoteFingerprint: 'old-fingerprint', remoteUpdatedAt: '2026-09-20T00:00:00Z',
    } })
  })
  snapshot.data.actions.reverse()
  revision = 1004
  await page.reload()
  await expect.poll(() => page.evaluate(() => {
    const checkpoint = JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['account-a']
    return [checkpoint?.lastSyncedVersion, Boolean(checkpoint?.conflict)]
  })).toEqual(['txn:1004', false])

  holdRead = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => reads).toBeGreaterThan(1)
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await expect(page.locator('.tsui-status')).toHaveCount(0)
  releaseRead?.()
})

test('a real local edit stays intact while a Settings conflict tracks newer remote revisions', async ({ page }) => {
  const snapshot = workspace()
  let revision = 843
  let reads = 0
  await page.addInitScript(({ key, value }) => {
    if (!localStorage.getItem('owner-interaction-seeded')) {
      localStorage.setItem(key, JSON.stringify(value))
      localStorage.setItem('owner-interaction-seeded', '1')
    }
  }, { key: AUTH_KEY, value: session('account-a', 'token-a') })
  await page.route('https://*.supabase.co/auth/v1/**', route => cors(route, {}, 200))
  await page.route(`${BACKEND}/**`, async route => {
    if (route.request().method() === 'OPTIONS') return cors(route, {}, 204)
    if (new URL(route.request().url()).pathname === '/api/health') return cors(route, health())
    expect(route.request().postDataJSON().action).toBe('read')
    reads += 1
    return cors(route, { workspaceId: 'ws-a', revision, workspaceVersion: `txn:${revision}`,
      schemaVersion: snapshot.version, snapshot })
  })
  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}')
    .accounts?.['account-a']?.lastSyncedVersion)).toBe('txn:843')
  await page.evaluate(async () => {
    const { dbPromise } = await import('/pjsdas/src/db.ts')
    const db = await dbPromise
    const action = await db.get('actions', 'A-action-1')
    if (!action) throw Error('Missing fixture action')
    await db.put('actions', { ...action, title: 'My unsynced edit' })
    const { patchAccountCheckpoint } = await import('/pjsdas/src/cloud/syncState.ts')
    patchAccountCheckpoint('account-a', { conflict: {
      remoteVersion: 'txn:843', remoteFingerprint: 'old-fingerprint', remoteUpdatedAt: '2026-09-20T00:00:00Z',
    } })
  })
  revision = 1000
  await page.goto('/pjsdas/settings')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}')
    .accounts?.['account-a']?.conflict?.remoteVersion)).toBe('txn:1000')
  revision = 1004
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}')
    .accounts?.['account-a']?.conflict?.remoteVersion)).toBe('txn:1004')
  expect(await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).dbPromise)
    .get('actions', 'A-action-1'))).toMatchObject({ title: 'My unsynced edit' })
  const afterFocusReads = reads
  await page.waitForTimeout(1_800)
  expect(reads - afterFocusReads).toBeLessThanOrEqual(1)
})

test('Settings recovers an old verified cache after a separate authoritative update without a retry click', async ({ page }) => {
  const snapshot = workspace()
  let revision = 843
  await page.addInitScript(({ key, value }) => {
    if (!localStorage.getItem('owner-interaction-seeded')) {
      localStorage.setItem(key, JSON.stringify(value))
      localStorage.setItem('owner-interaction-seeded', '1')
    }
  }, { key: AUTH_KEY, value: session('account-a', 'token-a') })
  await page.route('https://*.supabase.co/auth/v1/**', route => cors(route, {}, 200))
  await page.route(`${BACKEND}/**`, route => {
    if (route.request().method() === 'OPTIONS') return cors(route, {}, 204)
    if (new URL(route.request().url()).pathname === '/api/health') return cors(route, health())
    expect(route.request().postDataJSON().action).toBe('read')
    return cors(route, { workspaceId: 'ws-a', revision, workspaceVersion: `txn:${revision}`,
      schemaVersion: snapshot.version, snapshot })
  })

  await page.goto('/pjsdas/settings')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}')
    .accounts?.['account-a']?.lastSyncedVersion)).toBe('txn:843')
  await page.evaluate(async () => {
    const { patchAccountCheckpoint } = await import('/pjsdas/src/cloud/syncState.ts')
    patchAccountCheckpoint('account-a', { conflict: {
      remoteVersion: 'txn:843', remoteFingerprint: 'old-fingerprint', remoteUpdatedAt: '2026-09-20T00:00:00Z',
    } })
  })
  const action = snapshot.data.actions.find(item => item.id === 'A-action-1')
  if (!action) throw new Error('Missing owner fixture action')
  action.title = '服务器新增事实后的任务'
  revision = 1004
  await page.reload()
  await expect.poll(() => page.evaluate(() => {
    const checkpoint = JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['account-a']
    return [checkpoint?.lastSyncedVersion, Boolean(checkpoint?.conflict)]
  })).toEqual(['txn:1004', false])
  expect(await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).dbPromise)
    .get('actions', 'A-action-1'))).toMatchObject({ title: '服务器新增事实后的任务' })
})

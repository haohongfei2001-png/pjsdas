import { expect, test } from '@playwright/test'
import { AUTH_KEY, BACKEND, cors, health, session, workspace } from './fixtures/todayWorkspace.js'

for (const scenario of ['sign-out', 'local-edit', 'command-sign-out', 'command-local-edit', 'order-only', 'overlapping-read', 'account-aba'] as const) test(`a delayed authoritative read preserves ${scenario} boundary`, async ({ page }) => {
  const snapshot = workspace()
  let revision = 7
  let commandCalls = 0
  let holdNext = false
  let release: (() => void) | undefined
  await page.addInitScript(({ key, value }) => {
    if (!localStorage.getItem('pcr-race-seeded')) {
      localStorage.setItem(key, JSON.stringify(value))
      localStorage.setItem('pcr-race-seeded', '1')
    }
  }, { key: AUTH_KEY, value: session('account-a', 'token-a') })
  await page.route('https://*.supabase.co/auth/v1/**', route => cors(route, {}, 200))
  await page.route(BACKEND + '/**', async route => {
    if (route.request().method() === 'OPTIONS') return cors(route, {}, 204)
    if (new URL(route.request().url()).pathname === '/api/health') return cors(route, health())
    const body = route.request().postDataJSON()
    if (!['read', 'command'].includes(body.action)) return cors(route, { code: 'UNEXPECTED_WRITE' }, 409)
    if (body.action === 'command') { commandCalls += 1; snapshot.data.actions[0].status = 'done' }
    const responseSnapshot = structuredClone(snapshot), responseRevision = revision
    if (holdNext) {
      holdNext = false
      await new Promise<void>(resolve => { release = resolve })
    }
    return cors(route, { outcome: 'COMMITTED', receipt: { commandId: body.commandId, status: 'COMMITTED' }, workspaceId: 'ws-a', workspaceVersion: `txn:${responseRevision}`, revision: responseRevision, schemaVersion: responseSnapshot.version, snapshot: responseSnapshot })
  })
  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['account-a']?.lastSyncedVersion)).toBe('txn:7')
  revision = 8
  if (scenario === 'order-only') {
    snapshot.data = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data)
    snapshot.data.actions.reverse(); snapshot.data.opportunities.reverse()
    const result = await page.evaluate(async () => {
      const { patchAccountCheckpoint } = await import('/pjsdas/src/cloud/syncState.ts')
      patchAccountCheckpoint('account-a', { lastReadProjectionFingerprint: 'legacy-order-baseline' })
      return (await import('/pjsdas/src/cloud/authoritativeReadModelClient.ts')).refreshConnectedAuthoritativeCache('account-a')
    })
    expect(result).toMatchObject({ state: 'updated', workspaceVersion: 'txn:8' })
    await page.reload(); await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
    await expect(page.getByText(/Authoritative state changed|本机还有尚未同步/)).toHaveCount(0)
    return
  }
  snapshot.data.actions[0].title = 'Late private A task'
  holdNext = true
  await page.evaluate(async (scenario) => {
    if (scenario.startsWith('command')) {
      const { executeConnectedBusinessCommand } = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
      ;(window as any).__pcrRead = executeConnectedBusinessCommand('account-a', { type: 'domain', value: { commandId: 'race-command', kind: 'set_action_status', actionId: 'A-action-1', status: 'done' } }).catch(error => ({ error: String(error) }))
      return
    }
    const module = await import('/pjsdas/src/cloud/authoritativeReadModelClient.ts')
    ;(window as any).__pcrRead = module.refreshConnectedAuthoritativeCache('account-a').catch(error => ({ error: String(error) }))
  }, scenario)
  await expect.poll(() => Boolean(release)).toBe(true)
  if (scenario === 'overlapping-read') {
    revision = 9
    snapshot.data.actions[0].title = 'Newest authoritative task'
    await page.evaluate(async () => (await import('/pjsdas/src/cloud/authoritativeReadModelClient.ts')).refreshConnectedAuthoritativeCache('account-a'))
  } else if (scenario === 'account-aba') {
    await page.evaluate(async () => {
      const { setAccountCacheSession } = await import('/pjsdas/src/cloud/accountCacheLease.ts')
      setAccountCacheSession('account-b'); setAccountCacheSession('account-a')
    })
  } else if (scenario.endsWith('sign-out')) {
  await page.evaluate(async () => {
    const { pjsdasSupabase } = await import('/pjsdas/src/aiAccess/supabaseClient.ts')
    const result = await pjsdasSupabase.auth.signOut({ scope: 'local' })
    if (result.error) throw result.error
  })
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toHaveCount(0)
  } else {
    await page.evaluate(async () => {
      const db = await (await import('/pjsdas/src/db.ts')).dbPromise
      const tx = db.transaction('actions', 'readwrite')
      const row = await tx.store.get('A-action-1'); if (!row) throw Error('Missing fixture')
      row.title = 'Preserved genuine local edit'; await tx.store.put(row); await tx.done
    })
  }
  release!()
  await page.evaluate(async () => { await (window as any).__pcrRead })
  const stores = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalRecoveryArchive()).stores)
  if (scenario.endsWith('sign-out')) expect(stores.actions).toEqual([])
  else if (scenario === 'overlapping-read') {
    expect(stores.actions.find((a: any) => a.id === 'A-action-1')?.title).toBe('Newest authoritative task')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['account-a']?.lastSyncedVersion)).toBe('txn:9')
  } else if (scenario === 'account-aba') {
    expect(stores.actions.find((a: any) => a.id === 'A-action-1')?.title).toBe('A第一任务')
  } else {
    expect(stores.actions.find((a: any) => a.id === 'A-action-1')?.title).toBe('Preserved genuine local edit')
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['account-a']?.lastSyncedVersion)).toBe('txn:7')
  }
  await expect(page.getByRole('heading', { name: 'Late private A task' })).toHaveCount(0)
  expect(commandCalls).toBe(scenario.startsWith('command') ? 1 : 0)
  if (scenario === 'command-local-edit') {
    const retry = await page.evaluate(async () => (await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')).confirmConnectedCommand('account-a', 'race-command').then(() => 'unexpected').catch(() => 'preserved'))
    expect(retry).toBe('preserved')
    expect(commandCalls).toBe(1)
  }
})

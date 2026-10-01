import { expect, test } from '@playwright/test'
import { freezeTodayFixture } from './support/consumerFixtureClock.js'
import { AUTH_KEY, BACKEND, cors, health, session, workspace } from './fixtures/todayWorkspace.js'

test.beforeEach(async ({ page }) => { await freezeTodayFixture(page) })

for (const scenario of ['sign-out', 'local-edit', 'command-sign-out', 'command-local-edit', 'order-only', 'overlapping-read', 'account-aba', 'cloud-recovery', 'account-return', 'account-return-edited', 'account-return-read', 'checkpoint-interruption', 'checkpoint-interruption-edited'] as const) test(`a delayed authoritative read preserves ${scenario} boundary`, async ({ page }) => {
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
    if (!['read', 'command', 'receipt'].includes(body.action)) return cors(route, { code: 'UNEXPECTED_WRITE' }, 409)
    if (body.action === 'command') { commandCalls += 1; snapshot.data.actions[0].status = 'done' }
    const responseSnapshot = structuredClone(snapshot), responseRevision = revision
    if (holdNext) {
      holdNext = false
      await new Promise<void>(resolve => { release = resolve })
    }
    return cors(route, { found: body.action === 'receipt', outcome: 'COMMITTED', receipt: { commandId: body.commandId, status: 'COMMITTED' }, workspaceId: 'ws-a', workspaceVersion: `txn:${responseRevision}`, revision: responseRevision, schemaVersion: responseSnapshot.version, snapshot: responseSnapshot })
  })
  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['account-a']?.lastSyncedVersion)).toBe('txn:7')
  revision = 8
  if (scenario.startsWith('checkpoint-interruption')) {
    const interrupted = await page.evaluate(async () => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        if (key === 'pjsdas-google-drive-sync-state-v2' && value.includes('txn:8')) throw Error('Injected checkpoint interruption after durable projection')
        return original.call(this, key, value)
      }
      try {
        await (await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')).executeConnectedBusinessCommand('account-a', { type: 'domain', value: { commandId: 'interrupted', kind: 'set_action_status', actionId: 'A-action-1', status: 'done' } })
      } catch { /* Simulate restart after persistence failed. */ }
      finally { Storage.prototype.setItem = original }
      return { status: (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data.actions.find(a => a.id === 'A-action-1')?.status,
        checkpoint: JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2')!).accounts['account-a'].lastSyncedVersion }
    })
    expect(interrupted).toEqual({ status: 'done', checkpoint: 'txn:7' })
    if (scenario === 'checkpoint-interruption-edited') await page.evaluate(async () => {
      const db = await (await import('/pjsdas/src/db.ts')).dbPromise
      const action = await db.get('actions', 'A-action-1')
      if (!action) throw Error('Missing committed action')
      await db.put('actions', { ...action, title: 'Genuine post-projection edit' })
    })
    revision = 9
    snapshot.data.actions[1].title = 'Newer remote change'
    await page.reload()
    if (scenario === 'checkpoint-interruption-edited') {
      await expect.poll(() => page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data.actions.find(a => a.id === 'A-action-1')?.title)).toBe('Genuine post-projection edit')
      expect(await page.evaluate(() => localStorage.getItem('pjsdas-cgr01-pending:account-a'))).not.toBeNull()
      expect(commandCalls).toBe(1)
      return
    }
    await expect.poll(() => page.evaluate(() => localStorage.getItem('pjsdas-cgr01-pending:account-a'))).toBeNull()
    await expect.poll(() => page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data.actions.some(a => a.title === 'Newer remote change'))).toBe(true)
    expect(commandCalls).toBe(1)
    return
  }
  if (scenario.startsWith('account-return')) {
    await page.evaluate(async (scenario) => {
      if (scenario !== 'account-return-read') localStorage.setItem('pjsdas-cgr01-pending:account-a', JSON.stringify([{ commandId: 'committed-before-signout', action: 'command', status: 'unknown', createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z' }]))
      const { pjsdasSupabase } = await import('/pjsdas/src/aiAccess/supabaseClient.ts')
      await pjsdasSupabase.auth.signOut({ scope: 'local' })
    }, scenario)
    await expect.poll(() => page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalRecoveryArchive()).stores.actions.length)).toBe(0)
    if (scenario === 'account-return-edited') {
      await page.evaluate(async (local) => {
        local.data.actions[0].title = 'New local data after clear'
        await (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(local)
      }, snapshot)
    }
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: AUTH_KEY, value: session('account-a', 'token-a') })
    await page.reload()
    if (scenario === 'account-return-edited') {
      await expect.poll(() => page.evaluate(async () => {
        try { return (await (await import('/pjsdas/src/db.ts')).exportLocalRecoveryArchive()).stores.actions[0]?.title }
        catch (error) {
          if (error instanceof (await import('/pjsdas/src/cloud/accountCacheLease.ts')).AccountCacheChangedError) return undefined
          throw error
        }
      })).toBe('New local data after clear')
      expect(await page.evaluate(() => localStorage.getItem('pjsdas-cgr01-pending:account-a'))).not.toBeNull()
    } else {
      await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
      await expect.poll(() => page.evaluate(() => localStorage.getItem('pjsdas-cgr01-pending:account-a'))).toBeNull()
    }
    expect(commandCalls).toBe(0)
    return
  }
  if (scenario === 'cloud-recovery') {
    snapshot.data = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data)
    snapshot.data.actions.reverse(); snapshot.data.opportunities.reverse()
    const result = await page.evaluate(async () => {
      const { resolveConflictUseCloud } = await import('/pjsdas/src/cloud/cloudSync.ts')
      const { executeConnectedBusinessCommand, confirmConnectedCommand } = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
      await resolveConflictUseCloud('account-a')
      const command = await executeConnectedBusinessCommand('account-a', { type: 'domain', value: { commandId: 'after-cloud', kind: 'set_action_status', actionId: 'A-action-1', status: 'done' } })
      const receipt = await confirmConnectedCommand('account-a', 'after-cloud')
      return { command: command.outcome, receipt: receipt.outcome }
    })
    expect(result).toEqual({ command: 'COMMITTED', receipt: 'ALREADY_APPLIED' })
    expect(commandCalls).toBe(1)
    return
  }
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
    const retry = await page.evaluate(async () => (await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')).confirmConnectedCommand('account-a', 'race-command', { allowProjectionPending: true }))
    expect(retry).toMatchObject({ outcome: 'ALREADY_APPLIED', localProjection: 'pending' })
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:account-a') ?? '[]')[0]?.status)).toBe('projection_pending')
    expect(commandCalls).toBe(1)
  }
})

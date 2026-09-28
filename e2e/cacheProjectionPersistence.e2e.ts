import { expect, test } from '@playwright/test'
import { denseDecisionWorkspace } from '../tests/fixtures/denseDecisionWorkspace.js'

test('dense entity ordering converges without changing wire fingerprints or real edits', async ({ page }) => {
  await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const result = await page.evaluate(async snapshot => {
    const { replaceLocalSnapshotFromCloud, exportLocalSnapshot } = await import('/pjsdas/src/db.ts')
    const { equivalentReadProjection, fingerprintWorkspace } = await import('/pjsdas/src/cloud/workspaceFingerprint.ts')
    await replaceLocalSnapshotFromCloud(snapshot)
    const server = await exportLocalSnapshot()
    server.data.actions.reverse(); server.data.opportunities.reverse(); server.data.decisionRequests!.reverse()
    await replaceLocalSnapshotFromCloud(server)
    const local = await exportLocalSnapshot()
    const same = equivalentReadProjection(local, server)
    const wireDifferent = await fingerprintWorkspace(local) !== await fingerprintWorkspace(server)
    const changed = structuredClone(server); changed.data.actions[0].title += ' actual user edit'
    return { same, wireDifferent, editEquivalent: equivalentReadProjection(local, changed), decisions: local.data.decisionRequests!.length }
  }, denseDecisionWorkspace())
  expect(result).toEqual({ same: true, wireDifferent: true, editEquivalent: false, decisions: 358 })
  await page.reload(); await page.locator('.tsui-primary-nav').waitFor()
  expect(await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data.decisionRequests!.length)).toBe(358)
})

for (const failure of ['synchronous-put', 'transaction-abort'] as const) test(`guarded cloud projection is atomic after ${failure}`, async ({ page }) => {
  await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const result = await page.evaluate(async ({ snapshot, failure }) => {
    const db = await import('/pjsdas/src/db.ts')
    const { canonicalWorkspaceJson } = await import('/pjsdas/src/cloud/workspaceFingerprint.ts')
    await db.replaceLocalSnapshotFromCloud(snapshot)
    const before = await db.exportLocalSnapshot(), incoming = structuredClone(before)
    incoming.data.actions[0].title = 'Must not partially persist'
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'actions') {
        if (failure === 'transaction-abort') this.transaction.abort()
        throw new Error('Injected projection store failure')
      }
      return original.apply(this, args)
    }
    let rejected = false
    try { await db.replaceLocalSnapshotFromCloud(incoming, { expectedLocal: before, assertCurrent: () => {} }) } catch { rejected = true }
    finally { IDBObjectStore.prototype.put = original }
    return { rejected, unchanged: canonicalWorkspaceJson(before) === canonicalWorkspaceJson(await db.exportLocalSnapshot()) }
  }, { snapshot: denseDecisionWorkspace(), failure })
  expect(result).toEqual({ rejected: true, unchanged: true })
  await page.reload(); await page.locator('.tsui-primary-nav').waitFor()
  expect(await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data.actions.some(a => a.title === 'Must not partially persist'))).toBe(false)
})

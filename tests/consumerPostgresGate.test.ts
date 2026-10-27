import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { consumerCases, createConsumerManifest, extraPaths, safeConsumerRequests, verifyConsumerManifest } from './sql/consumer-pg-source.mjs'
import { consumerAuthClaims, consumerPostgresWorkspace } from './fixtures/consumerPostgresWorkspace.js'
import { verifyConsumerResults, verifyConsumerRun } from './sql/consumer-pg-results.mjs'
import { canMountMockAccountCache, markVerifiedMockCache, MOCK_CACHE_PROVENANCE_KEY } from '../src/cloud/mockCacheBoundary.js'
import { captureAccountCacheLease, setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
import { MOCK_AUTH_STORAGE_KEY } from '../src/cloud/runtimeCloudMode.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'

const owned: string[] = []
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); vi.unstubAllEnvs(); setAccountCacheSession(undefined) })
function source() {
  const base = mkdtempSync(join(tmpdir(), 'consumer-source-test-')); owned.push(base)
  for (const path of extraPaths) { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), `synthetic:${path}`) }
  return base
}
describe('consumer browser to native PostgreSQL acceptance contract', () => {
  it('has three distinct real-UI recovery cases, not a durable-v2 admission claim', () => {
    expect(consumerCases).toEqual(['offline-ui-done-undo-new-page-auto-recovery', 'lost-ack-new-page-auto-receipt', 'lost-ack-real-60s-automatic-receipt'])
    expect(Object.isFrozen(consumerCases)).toBe(true)
    const fixture = consumerPostgresWorkspace(new Date('2030-01-01T00:00:00Z'))
    expect(fixture.data.actions.map(action => action.status)).toEqual(['todo', 'todo'])
    expect(fixture.data.timeline).toEqual([])
    expect(fixture.data.actions.every(action => action.plannedDate === '2030-01-01')).toBe(true)
    expect(selectTodayWeb(fixture, { availableMinutes: 60 }, { now: new Date('2030-01-01T12:00:00Z'), timezone: 'UTC' }).visibleActions.map(action => action.actionId)).toEqual(['consumer-task', 'unrelated-task'])
  })
  it('pins actual browser/config/HTML/health inputs to the original native manifest digest', () => {
    const base = source(), digest = 'a'.repeat(64), manifest = createConsumerManifest(digest, { base })
    expect(verifyConsumerManifest(manifest, digest, { base })).toEqual(manifest)
    expect(() => verifyConsumerManifest(manifest, 'b'.repeat(64), { base })).toThrow()
    writeFileSync(join(base, 'index.html'), 'changed')
    expect(() => verifyConsumerManifest(manifest, digest, { base })).toThrow()
  })
  it('rejects reduced coverage, extra unapproved paths and source symlinks', () => {
    const base = source(), digest = 'a'.repeat(64), manifest = createConsumerManifest(digest, { base })
    const reduced = structuredClone(manifest); delete reduced.sha256['api/health.ts']
    expect(() => verifyConsumerManifest(reduced, digest, { base })).toThrow()
    expect(() => verifyConsumerManifest({ ...manifest, sha256: { ...manifest.sha256, '../private': digest } }, digest, { base })).toThrow()
    rmSync(join(base, 'api/health.ts')); symlinkSync(join(base, 'index.html'), join(base, 'api/health.ts'))
    expect(() => createConsumerManifest(digest, { base })).toThrow()
  })
  it('does not call recovery/replay/command APIs or install a fake browser clock in its UI journeys', () => {
    const code = readFileSync(new URL('../e2e/consumerPostgresRecovery.consumer-pg.ts', import.meta.url), 'utf8')
    expect(code).not.toMatch(/\.(?:recoverInstantInteraction|replayAccountPendingOperations|beginInstantCommand|beginInstantUndo|queueConnectedBusinessCommand)\s*\(/)
    expect(code).not.toMatch(/\.clock\.|dispatchEvent\s*\(/)
    expect(code).toContain("context.setOffline(true)")
    expect(code).toContain(".tsui-done-action').click()")
    expect(code).toContain("name: '撤销'")
    expect(code).toContain('toBeGreaterThanOrEqual(50_000)')
    const config = readFileSync(new URL('../playwright.consumer-pg.config.mts', import.meta.url), 'utf8')
    expect(config).toContain("retries: 0")
    expect(config).toContain("trace: 'off', video: 'off', screenshot: 'off'")
    expect(config).toContain('consumerPostgresRecovery.consumer-pg.ts')
    const ordinary = readFileSync(new URL('../playwright.config.mts', import.meta.url), 'utf8')
    expect(ordinary).toContain("testMatch: '**/*.e2e.ts'")
    expect(code).toContain('import type { consumerHttpFixture }')
  })
  it('accepts only the fixture JWT with the correct mock issuer for actual cache provenance', async () => {
    vi.stubEnv('VITE_PJSDAS_CLOUD_MODE', 'mock')
    const account = 'consumer-synthetic-owner'
    setAccountCacheSession(account)
    const claims = consumerAuthClaims(account)
    expect(claims).toEqual({ role: 'authenticated', sub: account, iss: 'https://todayaction-auth.invalid/auth/v1' })
    for (const issuer of [undefined, claims.iss, 'https://not-mock.invalid/auth/v1']) {
      const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
      const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ ...claims, iss: issuer, exp: 4102444800 })}`
      const token = `${unsigned}.${createHmac('sha256', 'synthetic-unit-key').update(unsigned).digest('base64url')}`
      storage.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify({ access_token: token, expires_at: 4102444800, user: { id: account } }))
      const state = { version: 2 as const, deviceId: 'synthetic-device', autoSync: false, workspaceOwnerUserId: account,
        accounts: { [account]: { lastSyncedFingerprint: 'f'.repeat(64), lastSyncedVersion: 'txn:0' } } }
      await markVerifiedMockCache(storage, () => state, account, captureAccountCacheLease(account).assertCurrent)
      expect(Boolean(storage.getItem(MOCK_CACHE_PROVENANCE_KEY))).toBe(issuer === claims.iss)
      expect(await canMountMockAccountCache(storage, () => state)).toBe(issuer === claims.iss)
    }
  })
  it('keeps transport diagnostics allowlisted and credential/body/query free', () => {
    const canary = 'synthetic-secret-do-not-serialize'
    const summary = safeConsumerRequests([{ path: '/api/workspace', method: 'POST', action: 'read', status: 200,
      authorizationMatched: true, originMatched: true, headers: { authorization: canary }, rawBody: canary, commandId: canary },
      { path: '/unexpected?' + canary, method: canary, action: canary }])
    expect(summary).toEqual([{ path: '/api/workspace', method: 'POST', action: 'read', status: 200,
      authorizationMatched: true, originMatched: true }, { path: 'unapproved', method: 'other', action: 'other' }])
    expect(JSON.stringify(summary)).not.toContain(canary)
  })
  it('fails closed on incomplete, stale, unsafe or misattributed browser acceptance results', () => {
    const directory = mkdtempSync(join(tmpdir(), 'consumer-result-test-')); owned.push(directory)
    const identity = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), prHeadSha: 'c'.repeat(40) }
    const report = (label: string) => ({ contract: 'consumer-ui-real-pg-recovery-v1', label, status: 'PASS',
      sourceCommit: identity.commit, sourceTree: identity.tree, prHead: identity.prHeadSha, browserName: 'chromium',
      uiCreatedCommands: true, mountedConsumer: true, httpBridgeClosed: true,
      clockMocked: false, explicitRecoveryCalls: 0, durableV2Admission: false,
      automaticIntervalCertified: true, observedRecoveryElapsedMs: 50_000,
      newPageAutomaticRecovery: true, commitProvenBeforeAckLoss: true })
    const cleanup = { contract: 'ta-native-owned-cleanup-v1', status: 'PASS', databaseCreated: true, authenticatorCreated: true }
    for (const label of consumerCases) {
      mkdirSync(join(directory, label))
      writeFileSync(join(directory, label, 'result.json'), JSON.stringify(report(label)))
      writeFileSync(join(directory, label, 'cleanup.json'), JSON.stringify(cleanup))
    }
    expect(verifyConsumerResults(directory, identity)).toHaveLength(3)
    expect(verifyConsumerRun(directory, identity, '0')).toHaveLength(3)
    // Even three passing cases cannot mask a rejecting-proxy/global teardown
    // failure, an interrupted runner, or a missing overall process result.
    for (const runner of ['1', '130', undefined, '']) expect(() => verifyConsumerRun(directory, identity, runner)).toThrow()
    const label = consumerCases[2], resultPath = join(directory, label, 'result.json')
    for (const mutation of [{ status: 'RUNNING' }, { sourceCommit: 'd'.repeat(40) }, { sourceTree: 'd'.repeat(40) },
      { prHead: 'd'.repeat(40) }, { browserName: 'node' }, { uiCreatedCommands: false }, { mountedConsumer: false },
      { httpBridgeClosed: false }, { clockMocked: true }, { explicitRecoveryCalls: 1 }, { durableV2Admission: true },
      { automaticIntervalCertified: false }, { observedRecoveryElapsedMs: 49_999 }, { observedRecoveryElapsedMs: '50000' },
      { commitProvenBeforeAckLoss: false }]) {
      writeFileSync(resultPath, JSON.stringify({ ...report(label), ...mutation }))
      expect(() => verifyConsumerResults(directory, identity), JSON.stringify(mutation)).toThrow()
    }
    writeFileSync(resultPath, JSON.stringify(report(label)))
    const cleanupPath = join(directory, label, 'cleanup.json')
    writeFileSync(cleanupPath, JSON.stringify({ ...cleanup, status: 'FAIL' }))
    expect(() => verifyConsumerResults(directory, identity)).toThrow()
    writeFileSync(cleanupPath, JSON.stringify(cleanup))
    const newPageLabel = consumerCases[0]
    writeFileSync(join(directory, newPageLabel, 'result.json'), JSON.stringify({ ...report(newPageLabel), newPageAutomaticRecovery: false }))
    expect(() => verifyConsumerResults(directory, identity)).toThrow()
    rmSync(join(directory, newPageLabel), { recursive: true })
    expect(() => verifyConsumerResults(directory, identity)).toThrow()
  })
})

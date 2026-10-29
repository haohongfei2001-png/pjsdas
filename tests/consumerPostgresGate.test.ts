import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { consumerCases, consumerStopFollowingCase, consumerProjectionEvidence, observeConsumerProjection, createConsumerManifest, extraPaths, safeConsumerRequests, verifyConsumerManifest } from './sql/consumer-pg-source.mjs'
import { consumerAuthClaims, consumerPostgresWorkspace, consumerStopFollowingWorkspace, initializeConsumerStopTimeline } from './fixtures/consumerPostgresWorkspace.js'
import { isUnreadJob } from '../src/jobReadState.js'
import { buildTimelineBackfill, TIMELINE_BACKFILL_MARKER_ID } from '../src/timeline.js'
import { installConsumerBrowserBootstrap } from './fixtures/consumerBrowserBootstrap.js'
import { verifyConsumerResults, verifyConsumerRun } from './sql/consumer-pg-results.mjs'
import { canMountMockAccountCache, markVerifiedMockCache, MOCK_CACHE_PROVENANCE_KEY } from '../src/cloud/mockCacheBoundary.js'
import { captureAccountCacheLease, setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
import { MOCK_AUTH_STORAGE_KEY } from '../src/cloud/runtimeCloudMode.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'

const owned: string[] = []
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); setAccountCacheSession(undefined) })
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
  it('adds only already-read small business facts for the full-App Stop delta case', () => {
    expect(consumerStopFollowingCase).toBe('job-stop-following-delta-reload-original-undo')
    const snapshot = consumerStopFollowingWorkspace(new Date('2030-01-01T00:00:00.000Z'))
    expect(snapshot.data.opportunities).toHaveLength(2)
    expect(snapshot.data.opportunities.every(job => !isUnreadJob(job) && job.discoveryRead?.viewedAt)).toBe(true)
    expect(snapshot.data.actions).toHaveLength(5)
    expect(snapshot.data.actions.filter(action => action.opportunityId === 'consumer-stop-job').map(action => action.status)).toEqual(['todo', 'doing', 'done'])
    expect(snapshot.data.processes).toHaveLength(1); expect(snapshot.data.processEvents).toHaveLength(1)
    const canonical = buildTimelineBackfill({ processEvents: snapshot.data.processEvents, actions: snapshot.data.actions, now: snapshot.exportedAt })
    expect(snapshot.data.timeline).toEqual([expect.objectContaining({ id: 'consumer-retained-history' }), ...canonical])
    expect(snapshot.data.timeline).toHaveLength(4)
    expect(snapshot.data.timeline?.every(record => !record.commandId)).toBe(true)
    expect(snapshot.data.semanticReceipts ?? []).toEqual([])
    expect(selectTodayWeb(snapshot, { availableMinutes: 60 }, { now: new Date('2030-01-01T12:00:00Z'), timezone: 'UTC' }).visibleActions.some(action => action.actionId === 'consumer-task')).toBe(true)
    const fixture = readFileSync(new URL('./sql/consumer-pg-http-fixture.mjs', import.meta.url), 'utf8')
    expect(fixture).toContain("PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION:'0'")
    expect(fixture).toContain('async assertNoLargeResources()')
    for (const table of ['large_command_intent', 'large_stage', 'large_document_reservation', 'ta_resource_reservations.reservation', 'ta_resource_reservations.rpc_scope']) expect(fixture).toContain(table)
    expect(fixture).not.toMatch(/\.reserve\s*\(|insert\s+into/i)
    const code = readFileSync(new URL('../e2e/consumerPostgresRecovery.consumer-pg.ts', import.meta.url), 'utf8')
    expect(code).toContain("page.locator('.tsui-job-open[data-opportunity-id=\"consumer-stop-job\"]').click()")
    expect(code).toContain("name: '不再跟进'"); expect(code).toContain("name: '撤销不再跟进'")
    expect(code).not.toMatch(/\.(?:stopFollowing|undoStopFollowing|inspectStopFollowing)\s*\(/)
  })
  it('initializes canonical timeline idempotently without overwriting history or seeding operations', () => {
    const at = '2030-01-01T00:00:00.000Z', initialized = consumerStopFollowingWorkspace(new Date(at))
    const pristine = structuredClone(initialized)
    expect(initializeConsumerStopTimeline(initialized)).toBe(initialized)
    expect(initializeConsumerStopTimeline(initializeConsumerStopTimeline(initialized))).toEqual(pristine)
    expect(initialized).toEqual(pristine)
    // A missing marker is not silently accepted. Reinitialization supplements
    // only missing canonical IDs, never duplicates or replaces existing rows.
    const missingMarker = structuredClone(initialized)
    missingMarker.data.timeline = missingMarker.data.timeline!.filter(record => record.id !== TIMELINE_BACKFILL_MARKER_ID)
    const before = structuredClone(missingMarker)
    expect(missingMarker.data.timeline).not.toEqual(initialized.data.timeline)
    const repaired = initializeConsumerStopTimeline(missingMarker)
    expect(repaired).toEqual(initialized); expect(missingMarker).toEqual(before)
    expect(repaired.data.timeline?.filter(record => record.id === TIMELINE_BACKFILL_MARKER_ID)).toHaveLength(1)
    expect(repaired.data.timeline?.find(record => record.id === TIMELINE_BACKFILL_MARKER_ID)).toMatchObject({
      kind: 'baseline_backfill', source: 'system', occurredAt: at, recordedAt: at,
    })
    const retained = before.data.timeline!.find(record => record.id === 'consumer-retained-history')!
    expect(repaired.data.timeline?.find(record => record.id === retained.id)).toEqual(retained)
    const changedHistory = structuredClone(before)
    changedHistory.data.timeline![0].title = 'Synthetic prior history must not be overwritten'
    expect(initializeConsumerStopTimeline(changedHistory).data.timeline?.[0]).toEqual(changedHistory.data.timeline![0])
    expect(repaired.data.timeline?.every(record => !record.commandId && !record.commandOperation)).toBe(true)
    expect(repaired.data.semanticReceipts ?? []).toEqual([])
    for (const key of ['commands', 'pending', 'commandInteractions', 'projectionDeltas', 'locator']) expect(Object.hasOwn(repaired.data, key)).toBe(false)
  })
  it('observes actual delta metadata without leaking bodies/unknown strings or breaking OPTIONS 204', () => {
    expect(observeConsumerProjection('OPTIONS', undefined, '')).toBeUndefined()
    expect(() => observeConsumerProjection('POST', {}, '')).toThrow()
    expect(() => observeConsumerProjection('POST', {}, '{')).toThrow()
    const projection = consumerProjectionEvidence({ projection: 'delta-v1' }, { revision: 1,
      delta: { contract: 'delta-v1', baseRevision: 0, changes: [{ secret: 'do-not-copy' }] },
      receipt: { operation: 'domain:abandon_opportunity', contractVersion: 5, private: 'do-not-copy' } })
    expect(projection).toEqual({ requestProjection: 'delta-v1', responseHasSnapshot: false, responseHasDelta: true,
      responseDeltaContract: 'delta-v1', responseRevision: 1, responseBaseRevision: 0, deltaChangeCount: 1,
      receiptOperation: 'domain:abandon_opportunity', receiptContractVersion: 5 })
    const canary = 'synthetic-secret-do-not-copy'
    const unsafe = { ...projection, requestProjection: canary, responseDeltaContract: canary, receiptOperation: canary,
      responseRevision: -1, responseBaseRevision: Infinity, deltaChangeCount: canary, receiptContractVersion: canary, private: canary }
    const safe = safeConsumerRequests([{ path: '/api/workspace', method: 'POST', action: 'command', projection: unsafe }])
    expect(JSON.stringify(safe)).not.toContain(canary)
    expect(safe[0]).toEqual({ path: '/api/workspace', method: 'POST', action: 'command', requestProjection: 'other',
      responseDeltaContract: 'other', receiptOperation: 'other', responseHasSnapshot: false, responseHasDelta: true })
    expect(consumerProjectionEvidence({ projection: 'snapshot' }, { revision: 1, snapshot: {} })).toMatchObject({ responseHasSnapshot: true, responseHasDelta: false })
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
  it('waits for actual new-page account adoption before observing scoped journals without swallowing lease errors', () => {
    const code = readFileSync(new URL('../e2e/consumerPostgresRecovery.consumer-pg.ts', import.meta.url), 'utf8')
    const settled = code.slice(code.indexOf('async function assertSettled('), code.indexOf('\nfor (const label'))
    expect(settled).toContain('lease.isAccountCacheSessionResolved() && lease.currentAccountCacheSession() === account')
    expect(settled.indexOf('lease.isAccountCacheSessionResolved()')).toBeLessThan(settled.indexOf('await state(page, h.account)'))
    expect(settled).not.toMatch(/catch\s*(?:\(|\{)|\.catch\(/)
    expect(settled).not.toMatch(/setAccountCacheSession|replayAccountPendingOperations|recoverInstantInteraction/)
  })
  it.each(['null', 'https://unapproved.invalid'])('does not touch storage or crypto while bootstrap runs at %s', origin => {
    const storage = vi.fn(() => { throw new DOMException('Opaque document', 'SecurityError') })
    const crypto = vi.fn(() => { throw new Error('Unexpected crypto access') })
    vi.stubGlobal('window', Object.defineProperties({ location: { origin } }, {
      localStorage: { get: storage }, crypto: { get: crypto },
    }))
    installConsumerBrowserBootstrap({ origin: 'http://127.0.0.1:4176', authKey: 'synthetic-auth', session: { access_token: 'synthetic-token' } })
    expect(storage).not.toHaveBeenCalled(); expect(crypto).not.toHaveBeenCalled()
  })
  it('writes only the original synthetic login and initial preference at the approved origin, preserving reload state', () => {
    const values = new Map<string, string>(), origin = 'http://127.0.0.1:4176'
    const localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }
    const randomUUID = vi.fn(() => 'synthetic-device')
    vi.stubGlobal('window', { location: { origin }, localStorage, crypto: { randomUUID } })
    const input = { origin, authKey: 'synthetic-auth', session: { access_token: 'synthetic-token' } }
    installConsumerBrowserBootstrap(input)
    expect([...values.keys()]).toEqual(['synthetic-auth', 'pjsdas-google-drive-sync-state-v2'])
    expect(JSON.parse(values.get('synthetic-auth')!)).toEqual(input.session)
    expect(JSON.parse(values.get('pjsdas-google-drive-sync-state-v2')!)).toEqual({ version: 2, deviceId: 'synthetic-device', autoSync: false, accounts: {} })
    const existing = JSON.stringify({ version: 2, deviceId: 'existing-device', accounts: { 'synthetic-owner': { lastSyncedVersion: 'txn:2' } } })
    values.set('pjsdas-google-drive-sync-state-v2', existing)
    installConsumerBrowserBootstrap(input)
    expect(values.get('pjsdas-google-drive-sync-state-v2')).toBe(existing)
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })
  it('does not suppress storage SecurityError at the approved origin or relax pageerror acceptance', () => {
    const origin = 'http://127.0.0.1:4176', failure = new DOMException('Storage denied', 'SecurityError')
    vi.stubGlobal('window', Object.defineProperty({ location: { origin } }, 'localStorage', { get: () => { throw failure } }))
    expect(() => installConsumerBrowserBootstrap({ origin, authKey: 'synthetic-auth', session: {} })).toThrow(failure)
    const code = readFileSync(new URL('../e2e/consumerPostgresRecovery.consumer-pg.ts', import.meta.url), 'utf8')
    expect(code).toContain('expect(pageErrors).toEqual([])')
    expect(code).not.toMatch(/pageErrors\.filter|seedSession\(/)
  })
  it('fails closed on incomplete, stale, unsafe or misattributed browser acceptance results', () => {
    const directory = mkdtempSync(join(tmpdir(), 'consumer-result-test-')); owned.push(directory)
    const identity = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), prHeadSha: 'c'.repeat(40) }
    const report = (label: string) => ({ contract: 'consumer-ui-real-pg-recovery-v1', label, status: 'PASS',
      sourceCommit: identity.commit, sourceTree: identity.tree, prHead: identity.prHeadSha, browserName: 'chromium',
      uiCreatedCommands: true, mountedConsumer: true, httpBridgeClosed: true,
      clockMocked: false, explicitRecoveryCalls: 0, durableV2Admission: false,
      automaticIntervalCertified: true, observedRecoveryElapsedMs: 50_000,
      newPageAutomaticRecovery: true, commitProvenBeforeAckLoss: true,
      ...(label === consumerStopFollowingCase ? { contract: 'consumer-ui-stop-following-real-pg-v1',
        initialBusinessOnly: true, realDeltaForward: true, realDeltaUndo: true, reloadOriginalReceipt: true,
        originalUndoTarget: true, nativeIdbProjection: true, businessAndRetainedFacts: true,
        reloadWriteCount: 0, forwardRevision: 1, undoRevision: 2,
        largeResourceCounts: { intents: 0, stages: 0, document_reservations: 0, resource_reservations: 0, resource_owners: 0, resource_enrollments: 0 },
        pageErrors: [], transportErrors: [], commandIdHashes: ['1'.repeat(64), '2'.repeat(64)],
        transport: [...[0, 1].map(index => ({ path: '/api/workspace', method: 'POST', status: 200, authorizationMatched: true, originMatched: true,
          action: index ? 'undo' : 'command', requestProjection: 'delta-v1', responseHasSnapshot: false, responseHasDelta: true,
          responseDeltaContract: 'delta-v1', responseBaseRevision: index, responseRevision: index + 1, receiptContractVersion: 5,
          receiptOperation: index ? 'undo_command' : 'domain:abandon_opportunity', deltaChangeCount: 1 })),
            { path: '/api/workspace', method: 'POST', status: 200, action: 'receipt', requestProjection: 'snapshot', responseHasSnapshot: true }],
      } : {}) })
    const cleanup = { contract: 'ta-native-owned-cleanup-v1', status: 'PASS', databaseCreated: true, authenticatorCreated: true }
    for (const label of [...consumerCases, consumerStopFollowingCase]) {
      mkdirSync(join(directory, label))
      writeFileSync(join(directory, label, 'result.json'), JSON.stringify(report(label)))
      writeFileSync(join(directory, label, 'cleanup.json'), JSON.stringify(cleanup))
    }
    expect(verifyConsumerResults(directory, identity)).toHaveLength(4)
    expect(verifyConsumerRun(directory, identity, '0')).toHaveLength(4)
    // Even four passing cases cannot mask a rejecting-proxy/global teardown
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
    const stopPath = join(directory, consumerStopFollowingCase, 'result.json'), validStop = report(consumerStopFollowingCase)
    for (const mutation of [{ status: 'RUNNING' }, { sourceCommit: 'd'.repeat(40) }, { sourceTree: 'd'.repeat(40) }, { prHead: 'd'.repeat(40) },
      ...['initialBusinessOnly', 'realDeltaForward', 'realDeltaUndo', 'reloadOriginalReceipt', 'originalUndoTarget', 'nativeIdbProjection', 'businessAndRetainedFacts', 'httpBridgeClosed'].map(key => ({ [key]: false })),
      { reloadWriteCount: 1 }, { forwardRevision: 0 }, { undoRevision: 3 }, { largeResourceCounts: undefined },
      { pageErrors: ['Error'] }, { transportErrors: [{ name: 'Error' }] }, { commandIdHashes: ['1'.repeat(64), '1'.repeat(64)] },
      { transport: [] }, { transport: validStop.transport!.slice(0, 2) }]) {
      writeFileSync(stopPath, JSON.stringify({ ...validStop, ...mutation }))
      expect(() => verifyConsumerResults(directory, identity), JSON.stringify(mutation)).toThrow()
    }
    for (const [key, value] of Object.entries({ requestProjection: 'snapshot', responseHasSnapshot: true, responseHasDelta: false,
      responseDeltaContract: 'other', responseBaseRevision: 9, responseRevision: 9, receiptContractVersion: 4,
      receiptOperation: 'other', deltaChangeCount: 0, authorizationMatched: false, originMatched: false, status: 500 })) {
      for (const index of [0, 1]) {
        const changed = structuredClone(validStop)
        Object.assign(changed.transport![index], { [key]: value })
        writeFileSync(stopPath, JSON.stringify(changed))
        expect(() => verifyConsumerResults(directory, identity), key).toThrow()
      }
    }
    writeFileSync(stopPath, JSON.stringify(validStop))
    const stopCleanup = join(directory, consumerStopFollowingCase, 'cleanup.json')
    writeFileSync(stopCleanup, JSON.stringify({ ...cleanup, status: 'FAIL' }))
    expect(() => verifyConsumerResults(directory, identity)).toThrow()
    writeFileSync(stopCleanup, JSON.stringify(cleanup))
    rmSync(stopPath)
    expect(() => verifyConsumerResults(directory, identity)).toThrow()
    writeFileSync(stopPath, JSON.stringify(validStop))
    const newPageLabel = consumerCases[0]
    writeFileSync(join(directory, newPageLabel, 'result.json'), JSON.stringify({ ...report(newPageLabel), newPageAutomaticRecovery: false }))
    expect(() => verifyConsumerResults(directory, identity)).toThrow()
    rmSync(join(directory, newPageLabel), { recursive: true })
    expect(() => verifyConsumerResults(directory, identity)).toThrow()
  })
})

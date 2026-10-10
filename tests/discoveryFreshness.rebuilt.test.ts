import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransactionalWorkspaceStore } from '../gateway/transactionalWorkspaceStore.js'
import { AT, AUTOMATION, LedgerHarness, SOURCE, USER, clone, command, scheduler } from './fixtures/b2Ledger.rebuilt.js'

beforeEach(() => { vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'transactional'); vi.stubEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY', 'synthetic-unused-key') })
afterEach(() => vi.unstubAllEnvs())
const factWrites = (db: LedgerHarness) => db.writes.filter(row => row.target_operation === 'ingest_verified_discovery')
const factAttempts = (db: LedgerHarness) => db.attempts.filter(row => row.target_operation === 'ingest_verified_discovery')
const claimWrites = (db: LedgerHarness) => db.writes.filter(row => row.target_operation === 'checkpoint_discovery_search')

describe('B2 rebuilt authoritative scheduler freshness (offline, new coverage)', () => {
  it.each(['deleted', 'future', 'backdated', 'edited run ID'] as const)('ignores %s timeline freshness on a later cadence bucket before the real interval elapsed', async manipulation => {
    const db = new LedgerHarness(), work = scheduler(db)
    const initial = await work.run()
    expect(initial.completedSourceCount).toBe(4)
    expect(factWrites(db)).toHaveLength(4); expect(claimWrites(db)).toHaveLength(4); expect(work.search).toHaveBeenCalledTimes(4); expect(work.generateTextImpl).toHaveBeenCalledTimes(4)
    const receipts = clone([...db.rows.values()])
    for (const item of db.snapshot.data.timeline ?? []) if (item.ingestionRun) {
      if (manipulation === 'future') item.ingestionRun.completedAt = '2099-01-01T00:00:00.000Z'
      if (manipulation === 'backdated') item.ingestionRun.completedAt = '2000-01-01T00:00:00.000Z'
      if (manipulation === 'edited run ID') item.ingestionRun.runId = `edited:${item.ingestionRun.runId}`
    }
    if (manipulation === 'deleted') db.snapshot.data.timeline = []
    db.revision += 1; db.now = new Date('2026-10-08T00:01:00.000Z')
    const result = await work.run()
    expect(result).toMatchObject({ state: 'checked_not_due', dueSourceCount: 0, completedSourceCount: 0 })
    expect(work.search).toHaveBeenCalledTimes(4); expect(work.generateTextImpl).toHaveBeenCalledTimes(4)
    expect(work.reserveSearch).toHaveBeenCalledTimes(4); expect(work.reserveSpend).toHaveBeenCalledTimes(4)
    expect(factWrites(db)).toHaveLength(4); expect([...db.rows.values()]).toEqual(receipts); expect(db.unexpectedUrls).toEqual([])
  })

  it('starts the next daily run only after the original receipt age reaches cadence, despite future timeline dates', async () => {
    const db = new LedgerHarness(), work = scheduler(db)
    await work.run(); const original = clone([...db.rows.values()])
    for (const item of db.snapshot.data.timeline ?? []) if (item.ingestionRun) item.ingestionRun.completedAt = '2099-01-01T00:00:00.000Z'
    db.now = new Date('2026-10-08T19:59:59.999Z')
    expect((await work.run()).state).toBe('checked_not_due'); expect(work.search).toHaveBeenCalledTimes(4)
    db.now = new Date('2026-10-08T20:00:00.000Z')
    expect((await work.run()).completedSourceCount).toBe(4)
    expect(work.search).toHaveBeenCalledTimes(8); expect(factWrites(db)).toHaveLength(8)
    expect([...db.rows.values()].slice(0, original.length)).toEqual(original)
  })

  it.each([false, true])('same-run replay (force=%s) does not reserve, retrieve, interpret, write or advance original time', async force => {
    const db = new LedgerHarness(), work = scheduler(db)
    await work.run(); const before = clone(db.snapshot), rows = clone([...db.rows.values()])
    db.now = new Date('2026-10-07T23:00:00.000Z')
    expect(await work.run(force)).toMatchObject({ state: 'checked_not_due', completedSourceCount: 0 })
    expect(work.reserveSearch).toHaveBeenCalledTimes(4); expect(work.search).toHaveBeenCalledTimes(4)
    expect(work.reserveSpend).toHaveBeenCalledTimes(4); expect(work.generateTextImpl).toHaveBeenCalledTimes(4)
    expect(db.snapshot).toEqual(before); expect([...db.rows.values()]).toEqual(rows); expect(factWrites(db)).toHaveLength(4)
  })

  it.each(['deleted', 'edited run ID'] as const)('forced same-bucket replay consults its original ledger after the timeline is %s', async manipulation => {
    const db = new LedgerHarness(), work = scheduler(db)
    await work.run(); const rows = clone([...db.rows.values()])
    if (manipulation === 'deleted') db.snapshot.data.timeline = []
    else for (const item of db.snapshot.data.timeline ?? []) if (item.ingestionRun) item.ingestionRun.runId = `edited:${item.ingestionRun.runId}`
    db.revision += 1; db.now = new Date('2026-10-07T23:00:00.000Z')
    // A fail-closed reconciliation error is acceptable; duplicate paid work is not.
    await work.run(true).catch(() => undefined)
    expect.soft(work.reserveSearch).toHaveBeenCalledTimes(4); expect.soft(work.search).toHaveBeenCalledTimes(4)
    expect.soft(work.reserveSpend).toHaveBeenCalledTimes(4); expect.soft(work.generateTextImpl).toHaveBeenCalledTimes(4)
    expect.soft([...db.rows.values()]).toEqual(rows); expect.soft(factWrites(db)).toHaveLength(4)
  })

  it('a future original ledger timestamp cannot establish freshness or authorize new retrieval', async () => {
    const db = new LedgerHarness(), work = scheduler(db)
    await work.run()
    for (const row of db.rows.values()) { row.created_at = '2099-01-01T00:00:00.000Z'; row.receipt.committedAt = row.created_at }
    db.now = new Date('2026-10-08T00:01:00.000Z')
    await expect(work.run()).rejects.toMatchObject({ code: 'DISCOVERY_COMMIT_UNVERIFIED' })
    expect(work.search).toHaveBeenCalledTimes(4); expect(work.reserveSearch).toHaveBeenCalledTimes(4); expect(factWrites(db)).toHaveLength(4)
  })

  it('does not replay a snapshot completion marker when its original receipt is missing', async () => {
    const db = new LedgerHarness(), work = scheduler(db)
    await work.run(); db.rows.clear()
    await expect(work.run(true)).rejects.toMatchObject({ code: 'DISCOVERY_COMMIT_UNVERIFIED' })
    expect(work.search).toHaveBeenCalledTimes(4); expect(work.generateTextImpl).toHaveBeenCalledTimes(4)
    expect(work.reserveSearch).toHaveBeenCalledTimes(4); expect(work.reserveSpend).toHaveBeenCalledTimes(4); expect(factWrites(db)).toHaveLength(4)
  })

  it('scope change during search aborts before another reservation, model invocation or commit', async () => {
    const db = new LedgerHarness(), work = scheduler(db)
    work.search.mockImplementationOnce(async () => {
      db.snapshot.data.discoveryProfile!.targetRoleQueries = ['Different Role']; db.revision += 1
      return { providerRequestId: 'scope-race', results: [{ url: 'https://example.test/job', title: 'Synthetic hit' }] }
    })
    const result = await work.run()
    expect(result.completedSourceCount).toBe(0); expect(result.skippedSourceCount).toBe(4)
    expect(work.search).toHaveBeenCalledTimes(1); expect(work.reserveSearch).toHaveBeenCalledTimes(1)
    expect(work.generateTextImpl).not.toHaveBeenCalled(); expect(work.reserveSpend).not.toHaveBeenCalled()
    expect(factAttempts(db)).toEqual([]); expect(factWrites(db)).toEqual([])
  })

  it('consent revocation during search prevents subsequent model spending and commit', async () => {
    const db = new LedgerHarness(), work = scheduler(db)
    work.search.mockImplementationOnce(async () => {
      db.liveAuthorization = { ...AUTOMATION, consentGeneration: '99999999-9999-4999-8999-999999999999' }
      return { providerRequestId: 'consent-race', results: [{ url: 'https://example.test/job', title: 'Synthetic hit' }] }
    })
    const result = await work.run()
    expect(result.sourceErrors?.[0]?.code).toBe('AUTH_FORBIDDEN'); expect(result.completedSourceCount).toBe(0)
    expect(work.search).toHaveBeenCalledTimes(1); expect(work.generateTextImpl).not.toHaveBeenCalled(); expect(work.reserveSpend).not.toHaveBeenCalled()
    expect(factWrites(db)).toEqual([]); expect(claimWrites(db)).toHaveLength(1); expect(db.rows.size).toBe(1)
  })

  it('a commit CAS retry reuses retrieved search/model evidence without another spend reservation', async () => {
    const db = new LedgerHarness(), work = scheduler(db)
    const winner = await command({ runId: 'independent-cas-winner', company: 'Concurrent verified job', postingId: '6c9b2f55-2319-479b-8703-541b96f48d8f' })
    let winnerRow: unknown, winnerJob: unknown
    db.beforeCommit = body => {
      if (body.target_operation !== 'ingest_verified_discovery') return
      db.beforeCommit = undefined
      winnerRow = db.seedWinner(winner)
      winnerJob = clone(db.snapshot.data.opportunities[0])
    }
    expect((await work.run()).completedSourceCount).toBe(4)
    expect(factAttempts(db)).toHaveLength(5); expect(factWrites(db)).toHaveLength(4)
    expect(work.search).toHaveBeenCalledTimes(4); expect(work.generateTextImpl).toHaveBeenCalledTimes(4)
    expect(work.reserveSearch).toHaveBeenCalledTimes(4); expect(work.reserveSpend).toHaveBeenCalledTimes(4)
    expect(factAttempts(db)[0].target_command_id).toBe(factAttempts(db)[1].target_command_id)
    expect(factAttempts(db)[0].target_payload_hash).toBe(factAttempts(db)[1].target_payload_hash)
    expect(db.snapshot.data.opportunities).toEqual([winnerJob])
    expect(db.rows.get(winner.commandId)).toEqual(winnerRow)
    expect(db.rows.size).toBe(9)
    expect(db.snapshot.data.timeline?.filter(item => item.ingestionRun?.producer === 'server_scheduler')).toHaveLength(4)
  })
})

describe('B2 rebuilt authoritative freshness lookup', () => {
  it('queries exact account/source/scope/producer and reads original creation order', async () => {
    const db = new LedgerHarness(), value = await command({ scheduled: true }); const original = db.seedWinner(value)
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://offline.invalid', serviceRoleKey: 'synthetic-unused-key', fetchImpl: db.fetch })
    expect(await store.readLatestDiscoveryCommandForUser(USER, SOURCE, value.scopeFingerprint!)).toMatchObject({ commandId: value.commandId, payloadHash: value.inputFingerprint, resultingRevision: 2, receipt: original.receipt, createdAt: AT })
    const params = db.calls.at(-1)!.url.searchParams
    expect(Object.fromEntries(params)).toMatchObject({ user_id: `eq.${USER}`, operation: 'eq.ingest_verified_discovery', status: 'eq.COMMITTED', principal_kind: 'eq.automation',
      'provenance->>sourceId': `eq.${SOURCE}`, 'provenance->>scopeFingerprint': `eq.${value.scopeFingerprint}`, 'provenance->>producer': 'eq.server_scheduler', order: 'created_at.desc,resulting_revision.desc', limit: '1' })
  })

  it.each(['user', 'source', 'scope', 'producer', 'principal', 'server time'] as const)('rejects a returned row with wrong %s even if the backend ignored its filter', async corruption => {
    const db = new LedgerHarness(), value = await command({ scheduled: true }); db.seedWinner(value)
    db.ledgerTransform = rows => rows.map(row => {
      if (corruption === 'user') row.user_id = 'foreign-user'
      if (corruption === 'source') row.provenance.sourceId = 'foreign-source'
      if (corruption === 'scope') row.provenance.scopeFingerprint = 'f'.repeat(64)
      if (corruption === 'producer') row.provenance.producer = 'mcp_trusted_ingestion'
      if (corruption === 'principal') row.principal_kind = 'delegated_mcp'
      if (corruption === 'server time') row.created_at = '2026-10-08T00:00:00.000Z'
      return row
    })
    await expect(db.source().readLatestDiscoveryReceipt!(SOURCE, value.scopeFingerprint!)).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' })
    expect(factAttempts(db)).toEqual([])
  })
})

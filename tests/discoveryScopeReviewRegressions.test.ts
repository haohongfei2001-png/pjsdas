import { WorkspaceSourceError } from '../gateway/workspaceSource.js'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATION, LedgerHarness, scheduler } from './fixtures/b2Ledger.rebuilt.js'
import { createPerplexityDiscoverySearchProvider } from '../gateway/perplexityDiscoverySearch.js'

beforeEach(() => { vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'transactional'); vi.stubEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY', 'synthetic-unused-key') })
afterEach(() => vi.unstubAllEnvs())

describe('independent B2 uncertain provider audit', () => {
 it.each([500, 502, 503, 504])('treats raw-provider HTTP%s as uncertain and never resends on a later cadence', async status => {
  const db = new LedgerHarness(), work = scheduler(db)
  const fetchImpl = vi.fn(async () => new Response('Synthetic gateway failure after possible provider acceptance', { status }))
  const searchProvider = createPerplexityDiscoverySearchProvider({ apiKey: 'synthetic-not-a-real-key', fetchImpl })
  expect((await work.run(false, { searchProvider })).uncertainSourceCount).toBe(4)
  const requests = fetchImpl.mock.calls.length, reservations = work.reserveSearch.mock.calls.length
  expect(requests).toBe(4)
  expect([...db.rows.values()].every(row => row.provenance.searchPhase === 'claimed')).toBe(true)
  db.now = new Date('2027-10-09T20:00:00Z')
  expect((await work.run(true, { searchProvider })).uncertainSourceCount).toBe(4)
  expect(fetchImpl).toHaveBeenCalledTimes(requests); expect(work.reserveSearch).toHaveBeenCalledTimes(reservations)
 })
 it.each(['search reservation', 'model reservation', 'model response'] as const)('keeps an unknown %s unresolved across cadence and force', async boundary => {
  const db = new LedgerHarness(), work = scheduler(db)
  if (boundary === 'search reservation') work.reserveSearch.mockRejectedValueOnce(new Error('Synthetic reservation accepted, response lost'))
  if (boundary === 'model reservation') work.reserveSpend.mockRejectedValueOnce(new Error('Synthetic model budget hold accepted, response lost'))
  if (boundary === 'model response') work.generateTextImpl.mockRejectedValueOnce(new Error('Synthetic paid model accepted, response lost'))
  const first = await work.run()
  expect(first.uncertainSourceCount).toBe(1)
  const sourceId = first.sourceErrors!.find(item => item.code === 'DISCOVERY_SEARCH_RESULT_UNCERTAIN')!.sourceId
  const beforeSearch = work.reserveSearch.mock.calls.filter(call => call[0].sourceId === sourceId).length
  const beforeModel = work.reserveSpend.mock.calls.filter(call => call[0].sourceId === sourceId).length
  const originalClaim = structuredClone([...db.rows.values()].find(row => row.provenance.sourceId === sourceId)!)
  expect([...db.rows.values()].filter(row => row.provenance.sourceId === sourceId)).toHaveLength(1)
  expect(originalClaim.provenance.searchPhase).toBe('claimed')
  db.now = new Date('2027-10-09T20:00:00Z')
  expect((await work.run(true)).uncertainSourceCount).toBe(1)
  expect(work.reserveSearch.mock.calls.filter(call => call[0].sourceId === sourceId)).toHaveLength(beforeSearch)
  expect(work.reserveSpend.mock.calls.filter(call => call[0].sourceId === sourceId)).toHaveLength(beforeModel)
  expect(db.rows.get(originalClaim.command_id)).toEqual(originalClaim)
 })

 it.each(['scope', 'expiry'] as const)('rechecks %s after the model reservation and before generation', async change => {
  const db = new LedgerHarness(), work = scheduler(db)
  let modelReserved = false
  const reserve = work.reserveSpend.getMockImplementation()!
  work.reserveSpend.mockImplementation(async request => {
   const receipt = await reserve(request)
   modelReserved = true
   if (change === 'scope') db.snapshot.data.discoveryProfile!.targetRoleQueries = ['New explicit scope']
   return receipt
  })
  const authorize = work.authorize.getMockImplementation()!
  work.authorize.mockImplementation(async () => {
   await authorize()
   if (modelReserved && change === 'expiry') db.now = new Date('2100-01-01T00:00:00Z')
  })
  await work.run()
  expect(work.generateTextImpl).not.toHaveBeenCalled()
  expect(work.reserveSpend).toHaveBeenCalledTimes(1)
  expect(db.writes.filter(row => row.target_operation === 'ingest_verified_discovery')).toEqual([])
 })
 it.each([0, 1, 3])('does not resume any source after source position %s exhausts the same policy', async position => {
  const db = new LedgerHarness(), work = scheduler(db)
  work.search.mockImplementation(async () => ({ providerRequestId: 'empty-confirmed', results: [] }))
  const reserve=work.reserveSearch.getMockImplementation()!
  for (let i = 0; i < position; i++) work.reserveSearch.mockImplementationOnce(reserve)
  work.reserveSearch.mockRejectedValueOnce(new WorkspaceSourceError('DISCOVERY_BUDGET_EXHAUSTED','Spent'))
  const first=await work.run(); expect(first.budgetExhausted).toBe(true)
  expect(work.reserveSearch).toHaveBeenCalledTimes(position + 1); expect(work.search).toHaveBeenCalledTimes(position)
  db.now = new Date('2027-10-09T20:00:00Z')
  const next=await work.run(true)
  expect(next.budgetExhausted).toBe(true)
  expect(next.remainingQueryCount).toBe(4 - position)
  await work.run(false)
  expect(work.reserveSearch).toHaveBeenCalledTimes(position + 1); expect(work.search).toHaveBeenCalledTimes(position)
 })

 it('does not call the paid model after consent was revoked while its reservation was pending', async () => {
  const db = new LedgerHarness(), work = scheduler(db)
  work.reserveSpend.mockImplementation(async request => {
   db.liveAuthorization = { ...AUTOMATION, consentGeneration: '99999999-9999-4999-8999-999999999999' }
   return { ...request, reservationId: 'reserved-before-revoke', reservedUsd: 1, expiresAt: '2099-01-01T00:00:00.000Z' }
  })
  const result = await work.run()
  expect(work.generateTextImpl).not.toHaveBeenCalled()
 })

 it('does not pay or resend after a provider accepted request but lost its response', async () => {
  const db = new LedgerHarness(), work = scheduler(db)
  let lostQuery: unknown
  work.search.mockImplementationOnce(async (request: any) => { lostQuery = request.query; throw new Error('Synthetic transport disconnected after provider accepted and charged request') })
  work.search.mockImplementation(async () => ({ providerRequestId: 'synthetic-response', results: [] }))
  const first = await work.run()
  expect(work.search).toHaveBeenCalledTimes(4)
  db.now = new Date('2027-10-09T20:00:00Z')
  const after = await work.run(true)
  const same = work.search.mock.calls.filter((call: any[])=>JSON.stringify(call[0].query)===JSON.stringify(lostQuery))
  expect(same).toHaveLength(1)
 })
})

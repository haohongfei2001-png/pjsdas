import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDiscoveryAutomationHandler } from '../gateway/discoveryAutomationHandler.js'
import { GENERATION, LedgerHarness, scheduler, USER } from './fixtures/b2Ledger.rebuilt.js'

beforeEach(() => {
  vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'transactional')
  vi.stubEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY', 'synthetic-unused-key')
})
afterEach(() => vi.unstubAllEnvs())

// Uses the actual worker, domain commits and receipt readback against an isolated
// ledger. All routes are intercepted; this is not live provider/SQL evidence.
function fixture() {
  const db = new LedgerHarness(), work = scheduler(db)
  work.search.mockImplementation(async () => ({ providerRequestId: 'offline-empty', results: [] }))
  let telemetry: () => Response = () => Response.json(true)
  const telemetryCalls = vi.fn(() => telemetry())
  const handler = createDiscoveryAutomationHandler({
    supabaseUrl: 'https://offline.invalid', supabasePublishableKey: 'synthetic-public',
    supabaseServiceRoleKey: 'synthetic-backend', tokenEncryptionKey: 'unused',
    googleClientId: 'unused', googleClientSecret: 'unused', now: () => db.now,
    reserveSearch: work.reserveSearch, reserveSpend: work.reserveSpend,
    generateTextImpl: work.generateTextImpl,
    searchProvider: { id: 'offline-only', maximumRequestCostUsd: 0.005, search: work.search },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('pjsdas_claim_enabled_discovery_automation_bindings_v2')) return Response.json([
        { user_id: USER, google_subject: 'synthetic-subject', refresh_token_ciphertext: 'unused', discovery_consent_generation: GENERATION },
      ])
      if (path.endsWith('/pjsdas_update_google_automation_state')) return telemetryCalls()
      return db.fetch(input, init)
    },
  })
  return { db, work, telemetryCalls, setTelemetry: (fn: () => Response) => { telemetry = fn },
    run: () => handler(new Request('https://gateway.invalid/api/automation-discovery', { headers: { authorization: 'Bearer synthetic-worker' } })),
  }
}

describe('discovery result survives uncertain telemetry', () => {
  it.each([
    ['server failure', () => Response.json({ error: 'private diagnostic' }, { status: 503 })],
    ['authorization rejection', () => Response.json({ error: 'private diagnostic' }, { status: 403 })],
    ['changed connection', () => Response.json(false)],
    ['lost acknowledgement', () => { throw new Error('private diagnostic') }],
  ] as const)('retains authoritative commits after %s and does not repeat search on the next tick', async (_name, fail) => {
    const f = fixture(); f.setTelemetry(fail)
    const response = await f.run(), body = await response.json()
    expect(response.status).toBe(207)
    expect(body).toMatchObject({ failedUsers: 0, successfulUsers: 1, durableCompletedUsers: 1, telemetryUnconfirmedUsers: 1,
      results: [{ status: 'committed', durableCommit: true, completedSourceCount: 4, telemetryState: 'unconfirmed',
        telemetryError: { code: 'DISCOVERY_TELEMETRY_UNCONFIRMED', retryable: false } }] })
    expect(JSON.stringify(body)).not.toContain('private diagnostic')
    expect(f.telemetryCalls).toHaveBeenCalledTimes(1)
    expect(f.work.search).toHaveBeenCalledTimes(4)
    const writes = f.db.writes.length
    expect(writes).toBeGreaterThan(0)
    f.setTelemetry(() => Response.json(true))
    const next = await f.run()
    expect(next.status).toBe(200)
    expect(await next.json()).toMatchObject({ failedUsers: 0, durableCompletedUsers: 0, telemetryUnconfirmedUsers: 0,
      results: [{ status: 'checked_not_due', durableCommit: false, telemetryState: 'recorded' }] })
    expect(f.db.writes).toHaveLength(writes)
    expect(f.work.search).toHaveBeenCalledTimes(4)
    expect(f.work.generateTextImpl).not.toHaveBeenCalled()
  })

  it('does not turn a no-work check into a failed search or invent a commit', async () => {
    const f = fixture(); await f.run()
    f.setTelemetry(() => Response.json(false))
    const response = await f.run()
    expect(response.status).toBe(207)
    expect(await response.json()).toMatchObject({ failedUsers: 0, successfulUsers: 0, durableCompletedUsers: 0, telemetryUnconfirmedUsers: 1,
      results: [{ status: 'checked_not_due', durableCommit: false, telemetryState: 'unconfirmed' }] })
    expect(f.work.search).toHaveBeenCalledTimes(4)
  })
})

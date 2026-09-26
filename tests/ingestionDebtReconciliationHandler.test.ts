import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createIngestionLedgerTimeline } from '../src/ingestion.js'
import { createSnapshot } from '../src/snapshot.js'

const state = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
}))

vi.mock('../gateway/transactionalWorkspaceSource.js', () => ({
  createTransactionalWorkspaceSource: () => ({
    read: state.read,
    write: state.write,
  }),
}))

import { createIngestionDebtReconciliationHandler } from '../gateway/ingestionDebtReconciliationHandler.js'

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function baseSnapshot() {
  const unresolved = createIngestionLedgerTimeline({
    sourceKind: 'gmail',
    sourceId: 'gmail:primary',
    sourceRecordId: 'historical-ad',
    runId: 'legacy-run',
    recordType: 'recruiting_message',
    outcome: 'unresolved',
    fingerprint: 'fp:historical-ad',
    receivedAt: '2026-08-01T00:00:00.000Z',
    accountedAt: '2026-08-01T00:00:00.000Z',
    reason: 'Generic recruiting ad / marketing newsletter; no actionable business fact.',
  })
  return createSnapshot({
    opportunities: [],
    processes: [],
    processEvents: [],
    actions: [],
    prep: [],
    applicationGroups: [],
    timeline: [unresolved],
  }, '2026-09-26T12:00:00.000Z')
}

function request(token = 'worker-token') {
  return new Request('https://example.invalid/api/automation-ingestion-reconciliation', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('ingestion debt reconciliation automation worker', () => {
  beforeEach(() => {
    state.read.mockReset().mockResolvedValue({
      snapshot: baseSnapshot(),
      context: {
        workspaceVersion: 'txn:7',
        now: new Date('2026-09-26T12:00:00.000Z'),
      },
    })
    state.write.mockReset().mockImplementation(async (input) => ({
      snapshot: input.snapshot,
      context: { workspaceVersion: 'txn:8' },
    }))
  })

  it('requires the existing automation bearer before touching Supabase', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const handler = createIngestionDebtReconciliationHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      supabaseServiceRoleKey: 'service-role',
      fetchImpl,
    })
    const response = await handler(new Request('https://example.invalid/api/automation-ingestion-reconciliation'))
    expect(response.status).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(state.read).not.toHaveBeenCalled()
  })

  it('appends auditable resolution records with CAS and does not expose workspace identity', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/rpc/pjsdas_claim_ingestion_reconciliation_users')
      expect(JSON.parse(String(init?.body))).toEqual({ worker_token: 'worker-token' })
      return json([{ user_id: '00000000-0000-0000-0000-000000000001' }])
    }) as unknown as typeof fetch

    const handler = createIngestionDebtReconciliationHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      supabaseServiceRoleKey: 'service-role',
      fetchImpl,
      now: () => new Date('2026-09-26T12:00:00.000Z'),
    })
    const response = await handler(request())
    expect(response.status).toBe(200)
    expect(state.write).toHaveBeenCalledTimes(1)
    const write = state.write.mock.calls[0]![0]
    expect(write.expectedWorkspaceVersion).toBe('txn:7')
    expect(write.command).toMatchObject({
      operation: 'ingestion_debt_reconciliation',
      provenance: {
        sourceId: 'ingestion-debt-reconciliation',
        adapterVersion: 'active-unresolved-v1',
      },
    })
    expect(write.snapshot.data.timeline.some((item: any) =>
      item.ingestionResolution?.outcome === 'ignored')).toBe(true)
    const body = await response.text()
    expect(body).not.toContain('00000000-0000-0000-0000-000000000001')
    expect(JSON.parse(body)).toMatchObject({
      processedWorkspaces: 1,
      successfulWorkspaces: 1,
      changedWorkspaces: 1,
      appendedResolutionCount: 1,
    })
  })

  it('maps a rejected worker token to 401 without a workspace read', async () => {
    const fetchImpl = vi.fn(async () => json({ code: '42501' }, 403)) as unknown as typeof fetch
    const handler = createIngestionDebtReconciliationHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      supabaseServiceRoleKey: 'service-role',
      fetchImpl,
    })
    const response = await handler(request('bad'))
    expect(response.status).toBe(401)
    expect(state.read).not.toHaveBeenCalled()
  })
})

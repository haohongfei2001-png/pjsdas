import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceSourceError } from '../gateway/workspaceSource.js'
import { requireDiscoverySpendReservation, type DiscoverySpendReservation } from '../gateway/discoveryBudgetGuard.js'
import { syntheticReserveDiscoverySpend } from './fixtures/discoveryBudget.js'
const base = { accountId: 'owner-a', sourceId: 'monitor:urgent-campus', model: 'perplexity/sonar', prompt: 'Synthetic public job request', system: 'fixture', maxOutputTokens: 5000 }
describe('TodayAction request-time paid discovery boundary', () => {
  it('does not wire a production spend adapter or infer funding from environment/plan credits', () => {
    const endpoint = readFileSync(new URL('../api/automation-discovery.ts', import.meta.url), 'utf8')
    expect(endpoint).not.toContain('reserveSpend:')
    expect(endpoint).not.toContain('BUDGET_APPROVED')
  })
  it('defaults to denial; another app budget or a model generator is not approval', async () => {
    await expect(requireDiscoverySpendReservation(base)).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_APPROVAL_REQUIRED' })
  })
  it.each(['accountId', 'sourceId'] as const)('rejects missing %s before reservation', async key => {
    const reserve = vi.fn(syntheticReserveDiscoverySpend)
    await expect(requireDiscoverySpendReservation({ ...base, [key]: undefined, reserve })).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_APPROVAL_REQUIRED' })
    expect(reserve).not.toHaveBeenCalled()
  })
  it.each([
    { application: 'hcla' }, { provider: 'other' }, { accountId: 'other' }, { sourceId: 'other' }, { model: 'other' },
    { requestId: 'old-request' }, { inputBytes: 1 }, { maxOutputTokens: 9000 }, { maxSdkAttempts: 2 },
    { reservationId: '' }, { reservedUsd: 0 }, { reservedUsd: NaN }, { expiresAt: '2020-01-01' }, { expiresAt: 'invalid' },
  ])('rejects an unbound or invalid budget receipt %#', async change => {
    await expect(requireDiscoverySpendReservation({ ...base, reserve: async request => ({ ...await syntheticReserveDiscoverySpend(request), ...change } as DiscoverySpendReservation) })).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_RESERVATION_INVALID' })
  })
  it('binds a fresh immutable request to this app/account/source/model and one SDK attempt', async () => {
    const seen: unknown[] = []
    const receipt = await requireDiscoverySpendReservation({ ...base, reserve: async request => { expect(Object.isFrozen(request)).toBe(true); seen.push(request); return syntheticReserveDiscoverySpend(request) } })
    expect(receipt).toMatchObject({ application: 'todayaction', accountId: 'owner-a', provider: 'vercel-ai-gateway', maxSdkAttempts: 1 })
    expect(seen).toHaveLength(1); expect(Object.isFrozen(receipt)).toBe(true)
  })
  it('fails closed on budget exhaustion and overlarge input without model activity', async () => {
    const reserve = vi.fn(async () => { throw new WorkspaceSourceError('DISCOVERY_BUDGET_EXHAUSTED', 'budget exhausted') })
    await expect(requireDiscoverySpendReservation({ ...base, reserve })).rejects.toThrow('budget exhausted')
    reserve.mockClear()
    await expect(requireDiscoverySpendReservation({ ...base, prompt: 'x'.repeat(262145), reserve })).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_INPUT_TOO_LARGE' })
    expect(reserve).not.toHaveBeenCalled()
  })
})

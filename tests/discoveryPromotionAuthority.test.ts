import { describe, expect, it, vi } from 'vitest'
import { applyDiscoveryPromotionCommand } from '../src/discoveryPromotionCommand.js'
import { applyDomainCompensation } from '../src/domainCommands.js'
import { createSnapshot } from '../src/snapshot.js'
import { authoritativeBusinessCommandSchema, createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'
import type { DiscoveryInboxItem } from '../src/model.js'

const time = '2026-09-24T00:00:00.000Z'
const item: DiscoveryInboxItem = {
  id: 'inbox:job-1', candidateOpportunityId: 'job-1', company: 'Example', role: 'Designer',
  roleType: 'core', sourceUrl: 'https://example.com/job/1', sourceTitle: 'Designer',
  rationale: 'Source-backed role', opportunityValue: 70, fitScore: 75,
  fitConfidence: 'medium', opportunityValueConfidence: 'medium', status: 'new',
  discoveredAt: time, createdAt: time, updatedAt: time,
}
const snapshot = () => createSnapshot({
  opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
  discoveryInbox: [structuredClone(item)], timeline: [], changeSets: [],
}, time)

describe('CGR-05 first-party Discovery promotion authority', () => {
  it('creates the reviewed Opportunity, Apply action and audit atomically with a guarded Undo', () => {
    const before = snapshot()
    const applied = applyDiscoveryPromotionCommand(before, { inboxItemId: item.id }, new Date('2026-09-24T01:00:00.000Z'))
    expect(applied.snapshot.data.discoveryInbox?.[0]).toMatchObject({ status: 'promoted', promotedOpportunityId: 'job-1' })
    expect(applied.snapshot.data.opportunities).toHaveLength(1)
    expect(applied.snapshot.data.actions).toMatchObject([{ id: 'apply:job-1', opportunityId: 'job-1' }])
    expect(applied.snapshot.data.changeSets?.[0]).toMatchObject({ status: 'applied' })
    expect(applied.snapshot.data.timeline?.map((row) => row.kind)).toContain('discovery_accepted')
    expect(before.data.opportunities).toHaveLength(0)
    const restored = applyDomainCompensation(applied.snapshot, applied.compensation!, new Date('2026-09-24T02:00:00.000Z'))
    expect(restored.data.discoveryInbox?.[0].status).toBe('new')
    expect(restored.data.opportunities).toHaveLength(0)
    expect(restored.data.actions).toHaveLength(0)
    expect(restored.data.changeSets).toEqual([])
    expect(restored.data.timeline).toEqual([])
  })

  it('rejects delegated MCP callers and does not expand its tool schema', async () => {
    const command = { commandId: 'discovery-promotion:test-0001', baseRevision: 1,
      command: { type: 'discovery_promotion', value: { inboxItemId: item.id } } }
    expect(authoritativeBusinessCommandSchema.safeParse(command).success).toBe(true)
    expect(applyUserCommandSchema.safeParse({ commandId: command.commandId, kind: 'discovery_promotion', inboxItemId: item.id }).success).toBe(false)
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const executor = createAuthoritativeCommandExecutor({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'test-service-role', fetchImpl,
    })
    await expect(executor.execute({ kind: 'delegated_mcp', userId: 'account-a' }, command)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

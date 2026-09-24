import { describe, expect, it, vi } from 'vitest'
import { applyDiscoveryStatusCommand } from '../src/discoveryStatusCommand.js'
import { applyDomainCompensation } from '../src/domainCommands.js'
import { createSnapshot } from '../src/snapshot.js'
import { authoritativeBusinessCommandSchema, createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'
import type { DiscoveryInboxItem } from '../src/model.js'

const time = '2026-09-24T00:00:00.000Z'

function candidate(status: DiscoveryInboxItem['status'] = 'new'): DiscoveryInboxItem {
  return {
    id: 'inbox:job-1', candidateOpportunityId: 'job-1', company: 'Example', role: 'Designer',
    roleType: 'core', sourceUrl: 'https://example.com/job/1', sourceTitle: 'Designer',
    rationale: 'Source-backed role', opportunityValue: 70, fitScore: 75,
    fitConfidence: 'medium', opportunityValueConfidence: 'medium', status,
    discoveredAt: time, createdAt: time, updatedAt: time,
  }
}

function snapshot(status: DiscoveryInboxItem['status'] = 'new') {
  return createSnapshot({
    opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
    discoveryInbox: [candidate(status)], timeline: [], changeSets: [],
  }, time)
}

describe('CGR-05 first-party Discovery Inbox status authority', () => {
  it('commits a scoped rejection with timeline and can compensate without changing other fields', () => {
    const before = snapshot()
    const applied = applyDiscoveryStatusCommand(before, {
      inboxItemId: 'inbox:job-1', status: 'dismissed', rejectionReason: 'location',
    }, new Date('2026-09-24T01:00:00.000Z'))
    expect(applied.snapshot.data.discoveryInbox?.[0]).toMatchObject({ status: 'dismissed', rejectionReason: 'location' })
    expect(applied.snapshot.data.timeline?.[0]).toMatchObject({ discoveryDecision: 'rejected', discoveryReasonCode: 'location' })
    expect(before.data.discoveryInbox?.[0].status).toBe('new')

    const restored = applyDomainCompensation(applied.snapshot, applied.compensation, new Date('2026-09-24T02:00:00.000Z'))
    expect(restored.data.discoveryInbox?.[0]).toMatchObject({ status: 'new', sourceUrl: 'https://example.com/job/1' })
    expect(restored.data.timeline).toEqual([])
  })

  it('rejects a promoted-item rollback without changing the input snapshot', () => {
    const before = snapshot('promoted')
    expect(() => applyDiscoveryStatusCommand(before, { inboxItemId: 'inbox:job-1', status: 'later' })).toThrow(/不能退回/)
    expect(before.data.discoveryInbox?.[0].status).toBe('promoted')
  })

  it('keeps the Web-only command outside the delegated MCP tool schema and rejects a delegated principal', async () => {
    const command = {
      commandId: 'discovery:test-0001', baseRevision: 1,
      command: { type: 'discovery_status', value: { inboxItemId: 'inbox:job-1', status: 'seen' } },
    }
    expect(authoritativeBusinessCommandSchema.safeParse(command).success).toBe(true)
    expect(applyUserCommandSchema.safeParse({ commandId: command.commandId, kind: 'discovery_status', inboxItemId: 'inbox:job-1', status: 'seen' }).success).toBe(false)
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const executor = createAuthoritativeCommandExecutor({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'test-service-role', fetchImpl,
    })
    await expect(executor.execute({ kind: 'delegated_mcp', userId: 'account-a' }, command)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

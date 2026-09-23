import { describe, expect, it, vi } from 'vitest'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { applyDiscoveryProfileCommand } from '../src/discoveryProfileCommand.js'
import { applyDomainCompensation } from '../src/domainCommands.js'
import { createSnapshot } from '../src/snapshot.js'
import { authoritativeBusinessCommandSchema, createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'

const time = '2026-09-24T00:00:00.000Z'
const empty = () => createSnapshot({
  opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
  timeline: [], changeSets: [],
}, time)

describe('CGR-05 first-party Discovery Profile authority', () => {
  it('writes only the profile and compensates to the prior value', () => {
    const before = empty()
    const profile = { ...createDefaultDiscoveryProfile(time), targetRoleQueries: ['Product Designer'] }
    const applied = applyDiscoveryProfileCommand(before, profile, new Date('2026-09-24T01:00:00.000Z'))
    expect(applied.snapshot.data.discoveryProfile?.targetRoleQueries).toEqual(['Product Designer'])
    expect(before.data.discoveryProfile).toBeUndefined()
    const restored = applyDomainCompensation(applied.snapshot, applied.compensation, new Date('2026-09-24T02:00:00.000Z'))
    expect(restored.data.discoveryProfile).toBeUndefined()
  })

  it('rejects delegated MCP callers and does not expand its tool schema', async () => {
    const profile = { ...createDefaultDiscoveryProfile(time), targetRoleQueries: ['Product Designer'] }
    const command = { commandId: 'discovery-profile:test-0001', baseRevision: 1, command: { type: 'discovery_profile', value: profile } }
    expect(authoritativeBusinessCommandSchema.safeParse(command).success).toBe(true)
    expect(applyUserCommandSchema.safeParse({ commandId: command.commandId, kind: 'discovery_profile', profile }).success).toBe(false)
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const executor = createAuthoritativeCommandExecutor({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'test-service-role', fetchImpl,
    })
    await expect(executor.execute({ kind: 'delegated_mcp', userId: 'account-a' }, command)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

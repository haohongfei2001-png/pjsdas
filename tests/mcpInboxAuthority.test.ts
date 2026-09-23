import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMcpInboxSaveCommand } from '../src/mcpInboxCommand.js'
import { createMcpProposalEnvelope } from '../src/ai/mcpProposal.js'
import { createSignedProposalToken } from '../gateway/proposalToken.js'
import { createSnapshot } from '../src/snapshot.js'
import { authoritativeBusinessCommandSchema, createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const at = new Date('2026-09-24T01:00:00.000Z')
const key = 'test-proposal-signing-secret'
const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-20260924010000-INBOX1', version: 1, source: 'mcp', status: 'pending',
  title: 'Signed discovery proposal', createdAt: at.toISOString(), updatedAt: at.toISOString(),
  expectedWorkspaceVersion: 'txn:1',
  operations: [{
    id: 'discovery:add:job-1', kind: 'add_discovered_opportunity', summary: 'Discover role',
    opportunity: {
      id: 'job-1', company: 'Example', role: 'Designer', currentStageLabel: '待投',
      processStage: 'not_applied', roleType: 'core', early: false,
      opportunityValue: 70, fitScore: 75, locallyManaged: true, importedAt: at.toISOString(),
      detail: { discovery: {
        sourceUrl: 'https://example.com/job/1', sourceTitle: 'Designer', rationale: 'Source-backed role',
        discoveredAt: at.toISOString(), fitConfidence: 'medium', opportunityValueConfidence: 'medium',
      } },
    },
  }],
}

afterEach(() => vi.unstubAllEnvs())

describe('CGR-05 signed MCP Discovery Inbox command', () => {
  it('saves only reviewed Inbox candidates and a discarded audit ChangeSet', () => {
    const before = createSnapshot({
      opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
      discoveryInbox: [], timeline: [], changeSets: [],
    }, at.toISOString())
    const proposal = createMcpProposalEnvelope(changeSet, 'txn:1', at, undefined, 'account-a')
    const saved = applyMcpInboxSaveCommand(before, proposal, new Date('2026-09-24T02:00:00.000Z'))
    expect(saved.snapshot.data.discoveryInbox).toMatchObject([{ id: 'inbox:job-1', status: 'new', sourceChangeSetId: changeSet.id }])
    expect(saved.snapshot.data.opportunities).toEqual([])
    expect(saved.snapshot.data.actions).toEqual([])
    expect(saved.snapshot.data.changeSets).toMatchObject([{ id: changeSet.id, status: 'discarded' }])
    expect(before.data.discoveryInbox).toEqual([])
    expect(applyMcpInboxSaveCommand(saved.snapshot, proposal).status).toBe('ALREADY_APPLIED')
  })

  it('rejects delegated callers and a signed token for another account before any workspace read', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', key)
    const token = await createSignedProposalToken(changeSet, 'txn:1', key, new Date(), undefined, 'account-a')
    const command = { commandId: 'mcp-save-inbox:test-0001', baseRevision: 1,
      command: { type: 'mcp_save_inbox', value: { token } } }
    expect(authoritativeBusinessCommandSchema.safeParse(command).success).toBe(true)
    expect(applyUserCommandSchema.safeParse({ kind: 'mcp_save_inbox', token }).success).toBe(false)
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const executor = createAuthoritativeCommandExecutor({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'test-service-role', fetchImpl,
    })
    await expect(executor.execute({ kind: 'delegated_mcp', userId: 'account-a' }, command)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    await expect(executor.execute({ kind: 'first_party_web', userId: 'account-b' }, command)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

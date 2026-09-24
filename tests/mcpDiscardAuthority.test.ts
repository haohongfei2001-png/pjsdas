import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMcpDiscardCommand } from '../src/mcpDiscardCommand.js'
import { createMcpProposalEnvelope } from '../src/ai/mcpProposal.js'
import { createSignedProposalToken } from '../gateway/proposalToken.js'
import { authoritativeBusinessCommandSchema, createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'
import { createSnapshot } from '../src/snapshot.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const at = new Date('2026-09-24T05:00:00.000Z')
const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-20260924050000-DISCARD', version: 1, source: 'mcp', status: 'pending',
  title: 'Synthetic discovery proposal', createdAt: at.toISOString(), updatedAt: at.toISOString(),
  expectedWorkspaceVersion: 'txn:1',
  operations: [{
    id: 'discovery:add:synthetic-job', kind: 'add_discovered_opportunity', summary: 'Synthetic job',
    opportunity: {
      id: 'synthetic-job', company: 'Example', role: 'Designer', currentStageLabel: '待投',
      processStage: 'not_applied', roleType: 'core', early: false, opportunityValue: 70,
      fitScore: 75, locallyManaged: true, importedAt: at.toISOString(),
      detail: { discovery: { sourceUrl: 'https://example.com/jobs/1', sourceTitle: 'Designer',
        rationale: 'Source-backed match', discoveredAt: at.toISOString(),
        fitConfidence: 'medium', opportunityValueConfidence: 'medium' } },
    },
  }],
}
const snapshot = () => createSnapshot({
  opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
  discoveryInbox: [], timeline: [], changeSets: [],
}, at.toISOString())

afterEach(() => vi.unstubAllEnvs())

describe('CGR-05 signed proposal discard authority', () => {
  it('records rejected feedback without applying a job, and rejects unknown review IDs', () => {
    const before = snapshot()
    const proposal = createMcpProposalEnvelope(changeSet, 'txn:1', at, undefined, 'account-a')
    const discarded = applyMcpDiscardCommand(before, proposal, {
      'discovery:add:synthetic-job': { code: 'location' },
    }, new Date('2026-09-24T05:01:00.000Z'))
    expect(discarded.snapshot.data.opportunities).toEqual([])
    expect(discarded.snapshot.data.actions).toEqual([])
    expect(discarded.snapshot.data.discoveryInbox).toEqual([])
    expect(discarded.snapshot.data.changeSets).toMatchObject([{ id: changeSet.id, status: 'discarded' }])
    expect(discarded.snapshot.data.timeline).toMatchObject([{
      kind: 'discovery_rejected', discoveryReasonCode: 'location', changeSetId: changeSet.id,
    }])
    expect(before.data.timeline).toEqual([])
    expect(() => applyMcpDiscardCommand(before, proposal, { unknown: { code: 'other' } })).toThrow('unknown operation')
  })

  it('rejects delegated and cross-account callers, then commits one exact-baseline feedback receipt', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', 'test-discard-proposal-key')
    let current = snapshot()
    let revision = 1
    let commits = 0
    const signed = { ...changeSet, expectedWorkspaceFingerprint: await fingerprintWorkspace(current) }
    const token = await createSignedProposalToken(signed, 'txn:1', 'test-discard-proposal-key', new Date(), undefined, 'account-a')
    const command = { commandId: 'mcp-discard:test-0001', baseRevision: 1,
      command: { type: 'mcp_discard', value: { token, rejectionSelections: {
        'discovery:add:synthetic-job': { code: 'location' },
      } } } }
    expect(authoritativeBusinessCommandSchema.safeParse(command).success).toBe(true)
    expect(applyUserCommandSchema.safeParse({ kind: 'mcp_discard', token }).success).toBe(false)
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/rest/v1/pjsdas_workspaces') {
        return Response.json([{ id: 'ws-1', user_id: 'account-a', snapshot: current, revision,
          schema_version: current.version }])
      }
      if (url.pathname === '/rest/v1/pjsdas_command_ledger') return Response.json([])
      if (url.pathname === '/rest/v1/rpc/pjsdas_commit_workspace_v2') {
        const body = JSON.parse(String(init?.body))
        commits += 1
        expect(body.target_operation).toBe('mcp_discard')
        expect(body.target_receipt_context.affectedObjects).toEqual(expect.arrayContaining([
          { type: 'change_set', id: signed.id },
        ]))
        expect(body.target_receipt_context.affectedObjects).not.toContainEqual({ type: 'opportunity', id: 'synthetic-job' })
        current = body.target_snapshot
        revision += 1
        return Response.json([{ outcome: 'COMMITTED', workspace_id: 'ws-1', revision,
          snapshot: current, receipt: { status: 'COMMITTED', commandId: body.target_command_id } }])
      }
      return Response.json({ message: `Unexpected ${url.pathname}` }, { status: 500 })
    }) as unknown as typeof fetch
    const executor = createAuthoritativeCommandExecutor({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'test-service-role', fetchImpl,
    })
    await expect(executor.execute({ kind: 'delegated_mcp', userId: 'account-a' }, command))
      .rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    await expect(executor.execute({ kind: 'first_party_web', userId: 'account-b' }, command))
      .rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(commits).toBe(0)
    const result = await executor.execute({ kind: 'first_party_web', userId: 'account-a' }, command)
    expect(result.outcome).toBe('COMMITTED')
    expect(current.data.opportunities).toEqual([])
    expect(current.data.changeSets?.[0]?.status).toBe('discarded')
    expect(commits).toBe(1)
  })
})

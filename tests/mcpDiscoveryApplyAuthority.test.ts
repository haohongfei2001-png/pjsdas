import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMcpDiscoveryCommand } from '../src/mcpDiscoveryApplyCommand.js'
import { createMcpProposalEnvelope } from '../src/ai/mcpProposal.js'
import { createSignedProposalToken } from '../gateway/proposalToken.js'
import { authoritativeBusinessCommandSchema, createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'
import { createSnapshot } from '../src/snapshot.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const at = new Date('2026-09-24T01:00:00.000Z')
const secret = 'test-signed-discovery-proposal'
const discoveryOperation = (id: string) => ({
  id: `discovery:add:${id}`, kind: 'add_discovered_opportunity' as const, summary: `Discover ${id}`,
  opportunity: {
    id, company: `Company ${id}`, role: 'Designer', currentStageLabel: '待投',
    processStage: 'not_applied' as const, roleType: 'core' as const, early: false,
    opportunityValue: 70, fitScore: 75, locallyManaged: true, importedAt: at.toISOString(),
    detail: { discovery: {
      sourceUrl: `https://example.com/jobs/${id}`, sourceTitle: `Designer ${id}`,
      rationale: 'Source-backed match', discoveredAt: at.toISOString(),
      fitConfidence: 'medium' as const, opportunityValueConfidence: 'medium' as const,
    } },
  },
})
const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-20260924010000-APPLY1', version: 1, source: 'mcp', status: 'pending',
  title: 'Signed discovery proposal', createdAt: at.toISOString(), updatedAt: at.toISOString(),
  expectedWorkspaceVersion: 'txn:1',
  operations: [discoveryOperation('job-1'), discoveryOperation('job-2')],
}
const snapshot = () => createSnapshot({
  opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
  discoveryInbox: [], timeline: [], changeSets: [],
}, at.toISOString())

afterEach(() => vi.unstubAllEnvs())

describe('CGR-05 signed discovery apply authority', () => {
  it('applies only explicitly selected jobs and keeps rejected feedback in the authoritative receipt', () => {
    const before = snapshot()
    const proposal = createMcpProposalEnvelope(changeSet, 'txn:1', at, undefined, 'account-a')
    const result = applyMcpDiscoveryCommand(before, proposal, ['discovery:add:job-1'], {
      'discovery:add:job-2': { code: 'location' },
    }, new Date('2026-09-24T02:00:00.000Z'))
    expect(result.snapshot.data.opportunities.map((item) => item.id)).toEqual(['job-1'])
    expect(result.snapshot.data.actions.map((item) => item.id)).toEqual(['apply:job-1'])
    expect(result.snapshot.data.changeSets).toMatchObject([{ id: changeSet.id, status: 'applied', operations: [{ id: 'discovery:add:job-1' }] }])
    expect(result.snapshot.data.timeline?.map((item) => item.kind)).toEqual(expect.arrayContaining(['opportunity_added', 'discovery_accepted', 'discovery_rejected']))
    expect(result.snapshot.data.timeline?.find((item) => item.kind === 'discovery_rejected')).toMatchObject({ discoveryReasonCode: 'location' })
    expect(before.data.opportunities).toEqual([])
    expect(() => applyMcpDiscoveryCommand(before, proposal, ['discovery:add:job-1', 'unknown'], {})).toThrow('未知 operation')
  })

  it('does not add a delegated MCP write capability or accept another account token', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', secret)
    const token = await createSignedProposalToken(changeSet, 'txn:1', secret, new Date(), undefined, 'account-a')
    const command = { commandId: 'mcp-apply-discovery:test-0001', baseRevision: 1,
      command: { type: 'mcp_apply_discovery', value: { token, selectedOperationIds: ['discovery:add:job-1'], rejectionSelections: {} } } }
    expect(authoritativeBusinessCommandSchema.safeParse(command).success).toBe(true)
    expect(applyUserCommandSchema.safeParse({ kind: 'mcp_apply_discovery', token }).success).toBe(false)
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const executor = createAuthoritativeCommandExecutor({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'test-service-role', fetchImpl,
    })
    await expect(executor.execute({ kind: 'delegated_mcp', userId: 'account-a' }, command)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    await expect(executor.execute({ kind: 'first_party_web', userId: 'account-b' }, command)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('commits selected jobs and rejected feedback together, then rejects a stale proposal', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', secret)
    let current = snapshot()
    let revision = 1
    let commits = 0
    const signed = { ...changeSet, expectedWorkspaceFingerprint: await fingerprintWorkspace(current) }
    const token = await createSignedProposalToken(signed, 'txn:1', secret, new Date(), undefined, 'account-a')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/rest/v1/pjsdas_workspaces') {
        return Response.json([{ id: 'ws-1', user_id: 'account-a', snapshot: current, revision, schema_version: current.version }])
      }
      if (url.pathname === '/rest/v1/pjsdas_command_ledger') return Response.json([])
      if (url.pathname === '/rest/v1/rpc/pjsdas_commit_workspace_v2') {
        const body = JSON.parse(String(init?.body))
        commits += 1
        expect(body.target_operation).toBe('mcp_apply_discovery')
        expect(body.target_receipt_context.affectedObjects).toEqual(expect.arrayContaining([
          { type: 'opportunity', id: 'job-1' }, { type: 'action', id: 'apply:job-1' },
          { type: 'change_set', id: signed.id },
        ]))
        expect(body.target_receipt_context.affectedObjects).not.toContainEqual({ type: 'opportunity', id: 'job-2' })
        current = body.target_snapshot
        revision += 1
        return Response.json([{ outcome: 'COMMITTED', workspace_id: 'ws-1', revision, snapshot: current,
          receipt: { status: 'COMMITTED', commandId: body.target_command_id } }])
      }
      return Response.json({ message: `Unexpected ${url.pathname}` }, { status: 500 })
    }) as unknown as typeof fetch
    const executor = createAuthoritativeCommandExecutor({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'test-service-role', fetchImpl,
    })
    const command = { commandId: 'mcp-apply-discovery:test-0002', baseRevision: 1,
      command: { type: 'mcp_apply_discovery', value: {
        token, selectedOperationIds: ['discovery:add:job-1'],
        rejectionSelections: { 'discovery:add:job-2': { code: 'location' } },
      } } }
    const applied = await executor.execute({ kind: 'first_party_web', userId: 'account-a' }, command)
    expect(applied.outcome).toBe('COMMITTED')
    expect(current.data.opportunities.map((item) => item.id)).toEqual(['job-1'])
    expect(current.data.timeline?.some((item) => item.kind === 'discovery_rejected')).toBe(true)
    expect(commits).toBe(1)
    await expect(executor.execute({ kind: 'first_party_web', userId: 'account-a' },
      { ...command, commandId: 'mcp-apply-discovery:test-0003', baseRevision: 2 })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(commits).toBe(1)
  })
})

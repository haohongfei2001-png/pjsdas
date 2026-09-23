import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProgressChangeSet } from '../src/changeSet.js'
import { applyMcpProgressCommand } from '../src/mcpProgressCommand.js'
import { createMcpProposalEnvelope } from '../src/ai/mcpProposal.js'
import { createSignedProposalToken } from '../gateway/proposalToken.js'
import { authoritativeBusinessCommandSchema, createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'
import { createSnapshot } from '../src/snapshot.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'

const at = new Date('2026-09-24T06:00:00.000Z')
const occurredAt = at.toISOString()
const snapshot = () => createSnapshot({
  opportunities: [{ id: 'opp-1', company: 'Synthetic', role: 'Designer', currentStageLabel: '待投',
    processStage: 'not_applied', roleType: 'core', early: false, opportunityValue: 70, fitScore: 75,
    locallyManaged: true, importedAt: occurredAt }],
  processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [], changeSets: [],
}, occurredAt)
const changeSet = () => ({
  ...createProgressChangeSet([
    { id: 'progress-manual-1', kind: 'manual_action' as const, title: 'Prepare portfolio',
      estimatedMinutes: 25, occurredAt, sourceText: 'Synthetic review', confidence: 'high' as const },
    { id: 'progress-event-1', kind: 'process_event' as const, opportunityId: 'opp-1',
      company: 'Synthetic', role: 'Designer', eventType: 'interview_invite' as const,
      dueAt: '2026-09-26T09:00:00.000Z', estimatedMinutes: 60,
      occurredAt, sourceText: 'Synthetic interview', confidence: 'high' as const },
  ], at),
  source: 'mcp' as const, expectedWorkspaceVersion: 'txn:1',
})

afterEach(() => vi.unstubAllEnvs())

describe('CGR-05 signed progress authority', () => {
  it('commits a reviewed progress batch atomically without touching unrelated facts', () => {
    const before = snapshot()
    const proposal = createMcpProposalEnvelope(changeSet(), 'txn:1', at, undefined, 'account-a')
    const result = applyMcpProgressCommand(before, proposal, new Date('2026-09-24T06:01:00.000Z'))
    expect(before.data.actions).toEqual([])
    expect(result.snapshot.data.opportunities).toEqual(before.data.opportunities)
    expect(result.snapshot.data.actions.map((action) => action.id)).toEqual([
      'progress-action:progress-manual-1', 'event-action:progress-event:progress-event-1',
    ])
    expect(result.snapshot.data.processEvents).toMatchObject([{ id: 'progress-event:progress-event-1', opportunityId: 'opp-1' }])
    expect(result.snapshot.data.changeSets).toMatchObject([{ status: 'applied' }])
    expect(result.snapshot.data.timeline?.filter((item) => item.id.startsWith('timeline:progress:'))).toHaveLength(2)
  })

  it('fails closed for a missing referenced Opportunity or mixed operation types', () => {
    const before = snapshot()
    const missing = changeSet()
    const event = missing.operations[1]
    if (event.kind !== 'progress_update' || event.operation.kind !== 'process_event') throw new Error('Bad fixture')
    event.operation.opportunityId = 'missing'
    const proposal = createMcpProposalEnvelope(missing, 'txn:1', at, undefined, 'account-a')
    expect(() => applyMcpProgressCommand(before, proposal)).toThrow('missing')
    expect(before.data.processEvents).toEqual([])
  })

  it('denies delegated/cross-account callers and commits one exact-baseline receipt', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', 'test-progress-proposal-key')
    let current = snapshot()
    let revision = 1
    let commits = 0
    const signed = { ...changeSet(), expectedWorkspaceFingerprint: await fingerprintWorkspace(current) }
    const token = await createSignedProposalToken(signed, 'txn:1', 'test-progress-proposal-key', new Date(), undefined, 'account-a')
    const command = { commandId: 'mcp-progress:test-0001', baseRevision: 1,
      command: { type: 'mcp_apply_progress', value: { token } } }
    expect(authoritativeBusinessCommandSchema.safeParse(command).success).toBe(true)
    expect(applyUserCommandSchema.safeParse({ kind: 'mcp_apply_progress', token }).success).toBe(false)
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
        expect(body.target_operation).toBe('mcp_apply_progress')
        expect(body.target_receipt_context.affectedObjects).toEqual(expect.arrayContaining([
          { type: 'action', id: 'progress-action:progress-manual-1' },
          { type: 'process_event', id: 'progress-event:progress-event-1' },
        ]))
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
    expect(current.data.actions).toHaveLength(2)
    expect(commits).toBe(1)
  })
})

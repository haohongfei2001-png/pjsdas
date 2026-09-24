import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProgressChangeSet } from '../src/changeSet.js'
import { applyMcpMixedCommand } from '../src/mcpMixedCommand.js'
import { createMcpProposalEnvelope } from '../src/ai/mcpProposal.js'
import { createSignedProposalToken } from '../gateway/proposalToken.js'
import { authoritativeBusinessCommandSchema, createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'
import { createSnapshot } from '../src/snapshot.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import { decisionRulesForSnapshot } from '../src/decisionRules.js'

const at = new Date('2026-09-24T07:00:00.000Z')
const timestamp = at.toISOString()
const snapshot = () => createSnapshot({
  opportunities: [{ id: 'opp-1', company: 'Synthetic', role: 'Designer', currentStageLabel: '待投',
    processStage: 'not_applied', roleType: 'core', early: false, opportunityValue: 70, fitScore: 75,
    locallyManaged: true, importedAt: timestamp }],
  processes: [], processEvents: [], actions: [{ id: 'existing-action', kind: 'manual', title: 'Existing task',
    opportunityId: 'opp-1', estimatedMinutes: 15, leverage: 70, delayCost: 70,
    status: 'todo', createdAt: timestamp, updatedAt: timestamp }],
  prep: [], applicationGroups: [], timeline: [], changeSets: [],
}, timestamp)
const changeSet = () => ({
  ...createProgressChangeSet([{ id: 'new-task', kind: 'manual_action' as const,
    title: 'Prepare portfolio', estimatedMinutes: 25, occurredAt: timestamp,
    sourceText: 'Synthetic review', confidence: 'high' as const }], at),
  source: 'mcp' as const, expectedWorkspaceVersion: 'txn:1',
  operations: [
    ...createProgressChangeSet([{ id: 'new-task', kind: 'manual_action' as const,
      title: 'Prepare portfolio', estimatedMinutes: 25, occurredAt: timestamp,
      sourceText: 'Synthetic review', confidence: 'high' as const }], at).operations,
    { id: 'action:existing-action', kind: 'set_action_status' as const,
      summary: 'Complete reviewed action', actionId: 'existing-action',
      expectedStatus: 'todo' as const, status: 'done' as const },
  ],
})

afterEach(() => vi.unstubAllEnvs())

describe('CGR-05 signed mixed proposal authority', () => {
  it('commits progress and Action status together with one real ChangeSet', () => {
    const before = snapshot()
    const proposal = createMcpProposalEnvelope(changeSet(), 'txn:1', at, undefined, 'account-a')
    const result = applyMcpMixedCommand(before, proposal, new Date('2026-09-24T07:01:00.000Z'))
    expect(before.data.actions.find((item) => item.id === 'existing-action')?.status).toBe('todo')
    expect(result.snapshot.data.actions.find((item) => item.id === 'existing-action')?.status).toBe('done')
    expect(result.snapshot.data.actions.find((item) => item.id === 'progress-action:new-task')?.title).toBe('Prepare portfolio')
    expect(result.snapshot.data.changeSets).toMatchObject([{ id: proposal.changeSet.id, status: 'applied' }])
    expect(result.snapshot.data.timeline?.filter((item) => item.kind === 'change_set_applied')).toHaveLength(1)
  })

  it('fails the whole batch if a reviewed Action became stale', () => {
    const before = snapshot()
    const stale = changeSet()
    const action = stale.operations[1]
    if (action.kind !== 'set_action_status') throw new Error('Bad fixture')
    action.expectedStatus = 'doing'
    const proposal = createMcpProposalEnvelope(stale, 'txn:1', at, undefined, 'account-a')
    expect(() => applyMcpMixedCommand(before, proposal)).toThrow('changed')
    expect(before.data.actions).toHaveLength(1)
    expect(before.data.changeSets).toEqual([])
  })

  it('applies one Decision Rules patch with progress and Action changes in the same revision', () => {
    const before = snapshot()
    const currentRules = decisionRulesForSnapshot(before.data.decisionRules)
    const mixed = changeSet()
    mixed.operations.push({
      id: 'rules:reviewed', kind: 'replace_decision_rules', summary: 'Raise follow-up cap',
      mode: 'save', expectedUpdatedAt: currentRules.updatedAt,
      rules: { ...currentRules, followUpDailyCap: currentRules.followUpDailyCap + 1 },
    })
    const proposal = createMcpProposalEnvelope(mixed, 'txn:1', at, undefined, 'account-a')
    const result = applyMcpMixedCommand(before, proposal, new Date('2026-09-24T07:01:00.000Z'))
    expect(result.snapshot.data.decisionRules?.followUpDailyCap).toBe(currentRules.followUpDailyCap + 1)
    expect(result.snapshot.data.actions.find((item) => item.id === 'existing-action')?.status).toBe('done')
    expect(result.snapshot.data.changeSets).toHaveLength(1)
  })

  it('rejects delegated and cross-account callers, then commits one scoped receipt', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', 'test-mixed-proposal-key')
    let current = snapshot()
    let revision = 1
    let commits = 0
    const signed = { ...changeSet(), expectedWorkspaceFingerprint: await fingerprintWorkspace(current) }
    const token = await createSignedProposalToken(signed, 'txn:1', 'test-mixed-proposal-key', new Date(), undefined, 'account-a')
    const command = { commandId: 'mcp-mixed:test-0001', baseRevision: 1,
      command: { type: 'mcp_apply_mixed', value: { token } } }
    expect(authoritativeBusinessCommandSchema.safeParse(command).success).toBe(true)
    expect(applyUserCommandSchema.safeParse({ kind: 'mcp_apply_mixed', token }).success).toBe(false)
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
        expect(body.target_operation).toBe('mcp_apply_mixed')
        expect(body.target_receipt_context.affectedObjects).toEqual(expect.arrayContaining([
          { type: 'action', id: 'existing-action' },
          { type: 'action', id: 'progress-action:new-task' },
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
    expect(current.data.changeSets).toHaveLength(1)
    expect(commits).toBe(1)
  })
})

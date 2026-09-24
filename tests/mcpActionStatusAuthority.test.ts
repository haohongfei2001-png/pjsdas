import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMcpActionStatusCommand } from '../src/mcpActionStatusCommand.js'
import { createMcpProposalEnvelope } from '../src/ai/mcpProposal.js'
import { createSignedProposalToken } from '../gateway/proposalToken.js'
import { authoritativeBusinessCommandSchema, createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'
import { createSnapshot } from '../src/snapshot.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const at = new Date('2026-09-24T02:00:00.000Z')
const secret = 'test-signed-action-proposal'
const snapshot = () => createSnapshot({
  opportunities: [], processes: [], processEvents: [], prep: [], applicationGroups: [],
  actions: ['one', 'two'].map((id) => ({
    id: `action-${id}`, kind: 'manual' as const, title: `Action ${id}`,
    estimatedMinutes: 15, leverage: 50, delayCost: 50, status: 'todo' as const,
    createdAt: at.toISOString(), updatedAt: at.toISOString(),
  })),
  timeline: [], changeSets: [],
}, at.toISOString())
const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-20260924020000-ACTION', version: 1, source: 'mcp', status: 'pending',
  title: 'Signed Action review', createdAt: at.toISOString(), updatedAt: at.toISOString(),
  expectedWorkspaceVersion: 'txn:1',
  operations: ['one', 'two'].map((id) => ({
    id: `action:action-${id}:done`, kind: 'set_action_status' as const,
    summary: `Complete ${id}`, actionId: `action-${id}`,
    expectedStatus: 'todo' as const, status: 'done' as const,
  })),
}

afterEach(() => vi.unstubAllEnvs())

describe('CGR-05 signed Action-status proposal authority', () => {
  it('applies the reviewed batch atomically with ChangeSet audit and prior-state compensation', () => {
    const before = snapshot()
    const proposal = createMcpProposalEnvelope(changeSet, 'txn:1', at, undefined, 'account-a')
    const applied = applyMcpActionStatusCommand(before, proposal, at)
    expect(applied.snapshot.data.actions.map((item) => item.status)).toEqual(['done', 'done'])
    expect(applied.snapshot.data.changeSets).toMatchObject([{ id: changeSet.id, status: 'applied' }])
    expect(applied.compensation.payload.previous).toEqual([
      { actionId: 'action-one', status: 'todo' }, { actionId: 'action-two', status: 'todo' },
    ])
    expect(before.data.actions.map((item) => item.status)).toEqual(['todo', 'todo'])
    const stale = snapshot()
    stale.data.actions[1].status = 'doing'
    expect(() => applyMcpActionStatusCommand(stale, proposal, at)).toThrow('changed since')
    expect(stale.data.actions[0].status).toBe('todo')
    const duplicate = { ...proposal, changeSet: { ...changeSet, operations: [changeSet.operations[0], changeSet.operations[0]] } }
    expect(() => applyMcpActionStatusCommand(before, duplicate, at)).toThrow('same Action')
  })

  it('requires first-party account binding and commits one exact-baseline revision', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', secret)
    let current = snapshot()
    let revision = 1
    let commits = 0
    const signed = { ...changeSet, expectedWorkspaceFingerprint: await fingerprintWorkspace(current) }
    const token = await createSignedProposalToken(signed, 'txn:1', secret, new Date(), undefined, 'account-a')
    const command = { commandId: 'mcp-apply-actions:test-0001', baseRevision: 1,
      command: { type: 'mcp_apply_actions', value: { token } } }
    expect(authoritativeBusinessCommandSchema.safeParse(command).success).toBe(true)
    expect(applyUserCommandSchema.safeParse({ kind: 'mcp_apply_actions', token }).success).toBe(false)
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/rest/v1/pjsdas_workspaces') {
        return Response.json([{ id: 'ws-1', user_id: 'account-a', snapshot: current, revision, schema_version: current.version }])
      }
      if (url.pathname === '/rest/v1/pjsdas_command_ledger') return Response.json([])
      if (url.pathname === '/rest/v1/rpc/pjsdas_commit_workspace_v2') {
        const body = JSON.parse(String(init?.body))
        commits += 1
        expect(body.target_operation).toBe('mcp_apply_actions')
        expect(body.target_receipt_context.affectedObjects).toEqual(expect.arrayContaining([
          { type: 'action', id: 'action-one' }, { type: 'action', id: 'action-two' },
          { type: 'change_set', id: signed.id },
        ]))
        expect(body.target_compensation).toMatchObject({ operation: 'mcp_action_status_batch' })
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
    await expect(executor.execute({ kind: 'delegated_mcp', userId: 'account-a' }, command)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    await expect(executor.execute({ kind: 'first_party_web', userId: 'account-b' }, command)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(commits).toBe(0)
    const applied = await executor.execute({ kind: 'first_party_web', userId: 'account-a' }, command)
    expect(applied.outcome).toBe('COMMITTED')
    expect(current.data.actions.map((item) => item.status)).toEqual(['done', 'done'])
    expect(commits).toBe(1)
    await expect(executor.execute({ kind: 'first_party_web', userId: 'account-a' },
      { ...command, commandId: 'mcp-apply-actions:test-0002', baseRevision: 2 })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(commits).toBe(1)
  })
})

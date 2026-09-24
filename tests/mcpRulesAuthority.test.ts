import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMcpRulesCommand } from '../src/mcpRulesCommand.js'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import { createMcpProposalEnvelope } from '../src/ai/mcpProposal.js'
import { createSignedProposalToken } from '../gateway/proposalToken.js'
import { authoritativeBusinessCommandSchema, createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'
import { createSnapshot } from '../src/snapshot.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const at = new Date('2026-09-24T02:30:00.000Z')
const secret = 'test-signed-rules-proposal'
const before = createDefaultDecisionRules(at.toISOString())
const after = { ...before, followUpDailyCap: before.followUpDailyCap === 1 ? 2 : 1 }
const snapshot = () => createSnapshot({
  opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
  decisionRules: before, timeline: [], changeSets: [],
}, at.toISOString())
const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-20260924023000-RULES', version: 1, source: 'mcp', status: 'pending',
  title: 'Signed rules review', createdAt: at.toISOString(), updatedAt: at.toISOString(),
  expectedWorkspaceVersion: 'txn:1',
  operations: [{ id: 'rules:current', kind: 'replace_decision_rules', summary: 'Review follow-up cap',
    expectedUpdatedAt: before.updatedAt, mode: 'save', rules: after }],
}

afterEach(() => vi.unstubAllEnvs())

describe('CGR-05 signed Decision Rules proposal authority', () => {
  it('applies one reviewed rules change with audit and prior-state compensation', () => {
    const original = snapshot()
    const proposal = createMcpProposalEnvelope(changeSet, 'txn:1', at, undefined, 'account-a')
    const applied = applyMcpRulesCommand(original, proposal, new Date('2026-09-24T02:31:00.000Z'))
    expect(applied.snapshot.data.decisionRules?.followUpDailyCap).toBe(after.followUpDailyCap)
    expect(applied.snapshot.data.changeSets).toMatchObject([{ id: changeSet.id, status: 'applied' }])
    expect(applied.snapshot.data.timeline?.map((item) => item.kind)).toEqual(expect.arrayContaining(['rules_changed', 'change_set_applied']))
    expect(applied.compensation.payload.before).toMatchObject(before)
    expect(original.data.decisionRules?.followUpDailyCap).toBe(before.followUpDailyCap)
    const stale = snapshot()
    stale.data.decisionRules!.updatedAt = '2026-09-24T02:30:30.000Z'
    expect(() => applyMcpRulesCommand(stale, proposal)).toThrow('changed since')
  })

  it('rejects delegated and cross-account callers, then commits one exact-baseline revision', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', secret)
    let current = snapshot()
    let revision = 1
    let commits = 0
    const signed = { ...changeSet, expectedWorkspaceFingerprint: await fingerprintWorkspace(current) }
    const token = await createSignedProposalToken(signed, 'txn:1', secret, new Date(), undefined, 'account-a')
    const command = { commandId: 'mcp-apply-rules:test-0001', baseRevision: 1,
      command: { type: 'mcp_apply_rules', value: { token } } }
    expect(authoritativeBusinessCommandSchema.safeParse(command).success).toBe(true)
    expect(applyUserCommandSchema.safeParse({ kind: 'mcp_apply_rules', token }).success).toBe(false)
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/rest/v1/pjsdas_workspaces') {
        return Response.json([{ id: 'ws-1', user_id: 'account-a', snapshot: current, revision, schema_version: current.version }])
      }
      if (url.pathname === '/rest/v1/pjsdas_command_ledger') return Response.json([])
      if (url.pathname === '/rest/v1/rpc/pjsdas_commit_workspace_v2') {
        const body = JSON.parse(String(init?.body))
        commits += 1
        expect(body.target_operation).toBe('mcp_apply_rules')
        expect(body.target_receipt_context.affectedObjects).toEqual(expect.arrayContaining([
          { type: 'decision_rules', id: 'current' }, { type: 'change_set', id: signed.id },
        ]))
        expect(body.target_compensation).toMatchObject({ operation: 'mcp_restore_decision_rules' })
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
    expect(current.data.decisionRules?.followUpDailyCap).toBe(after.followUpDailyCap)
    expect(commits).toBe(1)
    await expect(executor.execute({ kind: 'first_party_web', userId: 'account-a' },
      { ...command, commandId: 'mcp-apply-rules:test-0002', baseRevision: 2 })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(commits).toBe(1)
  })
})

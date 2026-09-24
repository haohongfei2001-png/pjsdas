import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMcpSourceRefreshCommand } from '../src/mcpSourceRefreshCommand.js'
import { createJobPostingEvidence } from '../src/jobPosting.js'
import { createDiscoveryRunRecord } from '../src/discoveryRun.js'
import { createMcpProposalEnvelope } from '../src/ai/mcpProposal.js'
import { createSignedProposalToken } from '../gateway/proposalToken.js'
import { authoritativeBusinessCommandSchema, createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'
import { createSnapshot } from '../src/snapshot.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const at = new Date('2026-09-24T03:00:00.000Z')
const oldAt = '2026-09-22T03:00:00.000Z'
const secret = 'test-signed-source-refresh'
const posting = createJobPostingEvidence({
  company: 'Example', role: 'Designer', sourceUrl: 'https://careers.example.com/jobs/1?utm_source=old',
  sourceTitle: 'Designer', postingStatus: 'open', observedAt: oldAt,
})
const snapshot = () => createSnapshot({
  opportunities: [{
    id: 'opp-1', company: 'Example', role: 'Designer', currentStageLabel: '筛选中',
    processStage: 'screening' as const, roleType: 'core' as const, early: false,
    opportunityValue: 70, fitScore: 75, locallyManaged: true, importedAt: oldAt,
    detail: { discovery: {
      sourceUrl: posting.sourceUrl, sourceTitle: posting.sourceTitle,
      rationale: 'Public source', discoveredAt: oldAt,
      fitConfidence: 'medium' as const, opportunityValueConfidence: 'medium' as const, posting,
    } },
  }],
  processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
  discoveryInbox: [], timeline: [], changeSets: [],
}, at.toISOString())
const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-20260924030000-REFRESH', version: 1, source: 'mcp', status: 'pending',
  title: 'Signed posting refresh', createdAt: at.toISOString(), updatedAt: at.toISOString(),
  expectedWorkspaceVersion: 'txn:1',
  operations: [{
    id: 'posting:refresh:opp-1', kind: 'refresh_job_posting', summary: 'Review public posting',
    ownerKind: 'opportunity', ownerId: 'opp-1', expectedPostingId: posting.id,
    expectedCanonicalSourceUrl: posting.canonicalSourceUrl,
    sourceUrl: 'https://careers.example.com/jobs/1?utm_source=new', sourceTitle: 'Designer updated',
    postingStatus: 'closed', observedAt: at.toISOString(),
  }],
}

afterEach(() => vi.unstubAllEnvs())

describe('CGR-05 signed source refresh authority', () => {
  it('keeps source history and application stage while failing stale or mixed changes closed', () => {
    const before = snapshot()
    const proposal = createMcpProposalEnvelope(changeSet, 'txn:1', at, undefined, 'account-a')
    const applied = applyMcpSourceRefreshCommand(before, proposal, at)
    expect(applied.snapshot.data.opportunities[0].detail?.discovery?.posting).toMatchObject({ postingStatus: 'closed' })
    expect(applied.snapshot.data.opportunities[0].processStage).toBe('screening')
    expect(applied.snapshot.data.changeSets).toMatchObject([{ id: changeSet.id, status: 'applied' }])
    expect(before.data.opportunities[0].detail?.discovery?.posting?.postingStatus).toBe('open')
    const stale = { ...proposal, changeSet: { ...changeSet, operations: [{ ...changeSet.operations[0], expectedPostingId: 'stale' }] } }
    expect(() => applyMcpSourceRefreshCommand(before, stale, at)).toThrow('changed since')
    const mixed = { ...proposal, changeSet: { ...changeSet, operations: [
      ...changeSet.operations, { id: 'action:x:done', kind: 'set_action_status' as const,
        summary: 'Mix', actionId: 'x', expectedStatus: 'todo' as const, status: 'done' as const },
    ] } }
    expect(() => applyMcpSourceRefreshCommand(before, mixed, at)).toThrow('independent')
  })

  it('records a reviewed zero-candidate Discovery Run without inventing Opportunities', () => {
    const run = createDiscoveryRunRecord({
      screening: { received: 0, accepted: 0, duplicateCount: 0, rejectedCount: 0, deferredCount: 0 },
      candidateSourceUrls: [], workspaceVersion: 'txn:1', completedAt: at.toISOString(),
    })
    const signed: ChangeSetRecord = { ...changeSet, discoveryRun: run, operations: [{
      id: `run:${run.id}`, kind: 'record_discovery_run', summary: 'Record reviewed run', runId: run.id,
    }] }
    const before = snapshot()
    const applied = applyMcpSourceRefreshCommand(before, createMcpProposalEnvelope(signed, 'txn:1', at, undefined, 'account-a'), at)
    expect(applied.snapshot.data.opportunities).toHaveLength(1)
    expect(applied.snapshot.data.changeSets?.[0].discoveryRun?.id).toBe(run.id)
    expect(applied.snapshot.data.timeline?.some((item) => item.kind === 'change_set_applied')).toBe(true)
  })

  it('rejects delegated and cross-account callers, then commits one exact-baseline revision', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', secret)
    let current = snapshot()
    let revision = 1
    let commits = 0
    const signed = { ...changeSet, expectedWorkspaceFingerprint: await fingerprintWorkspace(current) }
    const token = await createSignedProposalToken(signed, 'txn:1', secret, new Date(), undefined, 'account-a')
    const command = { commandId: 'mcp-source-refresh:test-0001', baseRevision: 1,
      command: { type: 'mcp_apply_source_refresh', value: { token } } }
    expect(authoritativeBusinessCommandSchema.safeParse(command).success).toBe(true)
    expect(applyUserCommandSchema.safeParse({ kind: 'mcp_apply_source_refresh', token }).success).toBe(false)
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/rest/v1/pjsdas_workspaces') {
        return Response.json([{ id: 'ws-1', user_id: 'account-a', snapshot: current, revision, schema_version: current.version }])
      }
      if (url.pathname === '/rest/v1/pjsdas_command_ledger') return Response.json([])
      if (url.pathname === '/rest/v1/rpc/pjsdas_commit_workspace_v2') {
        const body = JSON.parse(String(init?.body))
        commits += 1
        expect(body.target_operation).toBe('mcp_apply_source_refresh')
        expect(body.target_receipt_context.affectedObjects).toEqual(expect.arrayContaining([
          { type: 'opportunity', id: 'opp-1' }, { type: 'change_set', id: signed.id },
        ]))
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
    expect(current.data.opportunities[0].detail?.discovery?.posting?.postingStatus).toBe('closed')
    expect(commits).toBe(1)
    await expect(executor.execute({ kind: 'first_party_web', userId: 'account-a' },
      { ...command, commandId: 'mcp-source-refresh:test-0002', baseRevision: 2 })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(commits).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { invokeApplyUserCommand } from '../gateway/userCommands.js'
import type { GatewayWorkspace, WorkspaceSource, WorkspaceWriteInput } from '../gateway/workspaceSource.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

function snapshot(): PJSDASSnapshot {
  return {
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-19T00:00:00.000Z',
    data: {
      opportunities: [{
        id: 'opp-1',
        company: 'Example Co',
        role: 'Product Manager',
        currentStageLabel: '待投',
        processStage: 'not_applied',
        roleType: 'core',
        assessmentStatus: 'unassessed',
        early: false,
        opportunityValue: 50,
        fitScore: 50,
        importedAt: '2026-09-19T00:00:00.000Z',
      }],
      processes: [],
      processEvents: [],
      actions: [{
        id: 'apply:opp-1',
        kind: 'apply',
        title: '投递 Example Co｜Product Manager',
        opportunityId: 'opp-1',
        estimatedMinutes: 45,
        leverage: 80,
        delayCost: 40,
        status: 'todo',
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z',
      }],
      prep: [],
      applicationGroups: [],
      timeline: [],
    },
  }
}

class Source implements WorkspaceSource {
  state = snapshot()
  writes: WorkspaceWriteInput[] = []
  async read(): Promise<GatewayWorkspace> {
    return {
      snapshot: this.state,
      context: { workspaceVersion: 'txn:4', now: new Date('2026-09-19T03:00:00.000Z') },
    }
  }
  async write(input: WorkspaceWriteInput): Promise<GatewayWorkspace> {
    this.writes.push(input)
    this.state = input.snapshot
    return {
      snapshot: this.state,
      context: { workspaceVersion: 'txn:5', now: new Date('2026-09-19T03:00:00.000Z') },
    }
  }
}

describe('explicit user command MCP tool', () => {
  it('writes exactly one semantic command with ledger metadata and compensation', async () => {
    const source = new Source()
    const result = await invokeApplyUserCommand(source, {
      commandId: 'cmd-complete-123',
      kind: 'set_action_status',
      actionId: 'apply:opp-1',
      status: 'done',
    })

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      applied: true,
      alreadyApplied: false,
      reviewRequired: false,
      commandId: 'cmd-complete-123',
      operation: 'set_action_status',
      workspaceVersion: 'txn:5',
    })
    expect(source.writes).toHaveLength(1)
    expect(source.writes[0]?.command).toMatchObject({
      commandId: 'cmd-complete-123',
      operation: 'set_action_status',
      provenance: { channel: 'mcp-explicit-user-command' },
      compensation: {
        operation: 'set_action_status',
        payload: { actionId: 'apply:opp-1', status: 'todo' },
      },
    })
  })

  it('returns a lightweight confirmation request instead of staging a ChangeSet', async () => {
    const source = new Source()
    source.state.data.opportunities[0]!.participationStatus = 'abandoned'
    const result = await invokeApplyUserCommand(source, {
      commandId: 'cmd-app-abandoned',
      kind: 'record_application_submission',
      opportunityId: 'opp-1',
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      applied: false,
      reviewRequired: false,
      needsConfirmation: true,
      reason: 'TARGET_ABANDONED',
    })
    expect(source.writes).toHaveLength(0)
  })
})

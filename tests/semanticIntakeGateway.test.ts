import { describe, expect, it, vi } from 'vitest'
import {
  invokePaiaIntake,
  invokeResolveSemanticDecision,
  invokeSemanticIntake,
  invokeSemanticUndo,
} from '../gateway/semanticIntake.js'
import type {
  GatewayWorkspace,
  WorkspacePreparedUndo,
  WorkspaceSource,
  WorkspaceWriteInput,
} from '../gateway/workspaceSource.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

function snapshot(): PJSDASSnapshot {
  return {
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-20T00:00:00.000Z',
    data: {
      opportunities: [{
        id: 'opp-1',
        company: 'Example Co',
        role: 'Product Manager',
        currentStageLabel: '筛选中',
        processStage: 'screening',
        roleType: 'core',
        participationStatus: 'active',
        early: false,
        opportunityValue: 80,
        fitScore: 80,
        locallyManaged: true,
        importedAt: '2026-09-01T00:00:00.000Z',
      }],
      processes: [{
        id: 'process-1',
        opportunityId: 'opp-1',
        company: 'Example Co',
        role: 'Product Manager',
        stage: 'screening',
        stageLabel: '筛选中',
        lastProgressAt: '2026-09-10T00:00:00.000Z',
        locallyManaged: true,
      }],
      processEvents: [],
      actions: [],
      prep: [],
      applicationGroups: [],
      timeline: [],
    },
  }
}

class TransactionalSource implements WorkspaceSource {
  state = snapshot()
  revision = 4
  writes: WorkspaceWriteInput[] = []
  ledger = new Map<string, { compensation?: Record<string, unknown>; revision: number }>()

  async read(): Promise<GatewayWorkspace> {
    return {
      snapshot: this.state,
      context: {
        workspaceVersion: `txn:${this.revision}`,
        now: new Date('2026-09-20T10:00:00.000Z'),
        timezone: 'Asia/Shanghai',
      },
    }
  }

  async write(input: WorkspaceWriteInput): Promise<GatewayWorkspace> {
    expect(input.expectedWorkspaceVersion).toBe(`txn:${this.revision}`)
    this.writes.push(input)
    this.revision += 1
    this.state = input.snapshot
    if (input.command) {
      this.ledger.set(input.command.commandId, {
        compensation: input.command.compensation,
        revision: this.revision,
      })
    }
    return this.read()
  }

  async prepareUndo(targetCommandId: string): Promise<WorkspacePreparedUndo> {
    const entry = this.ledger.get(targetCommandId)
    if (!entry) return { outcome: 'NEEDS_CONFIRMATION', reason: 'COMMAND_NOT_FOUND' }
    if (!entry.compensation) {
      return {
        outcome: 'NEEDS_CONFIRMATION',
        reason: 'NO_COMPENSATION',
        targetRevision: entry.revision,
        currentRevision: this.revision,
      }
    }
    if (entry.revision !== this.revision) {
      return {
        outcome: 'NEEDS_CONFIRMATION',
        reason: 'DEPENDENT_CHANGES',
        targetRevision: entry.revision,
        currentRevision: this.revision,
      }
    }
    return {
      outcome: 'READY',
      targetCommandId,
      expectedWorkspaceVersion: `txn:${this.revision}`,
      snapshot: this.state,
      compensation: entry.compensation,
    }
  }
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    inputId: 'semantic-gateway-input-1',
    source: {
      kind: 'mcp',
      sourceId: 'chatgpt-current',
      sourceRecordId: 'message-1',
      sourceVersion: 'v1',
      observedAt: '2026-09-20T10:00:00.000Z',
      assertedAt: '2026-09-20T10:00:00.000Z',
      timezone: 'Asia/Shanghai',
    },
    statementMode: 'assertion',
    originalText: '这个岗位我不投了',
    candidates: [{
      id: 'candidate-1',
      kind: 'abandon_opportunity',
      target: { company: 'Example Co', role: 'Product Manager' },
      objectConfidence: 'high',
      eventConfidence: 'high',
      evidenceRefs: [],
      sourceVersionRefs: [],
    }],
    ...overrides,
  }
}

describe('UU-02 Semantic Intake gateway', () => {
  it('server-authorizes the source, writes one ledgered semantic command, and does not persist raw user text in ledger payload', async () => {
    const source = new TransactionalSource()
    const authorize = vi.fn(async () => undefined)
    const result = await invokeSemanticIntake(source, args(), { authorize })

    expect(result.isError).not.toBe(true)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(result.structuredContent).toMatchObject({
      applied: true,
      decisionRequired: false,
      workspaceVersion: 'txn:5',
      commandId: 'semantic-intake:semantic-gateway-input-1',
    })
    expect(source.writes).toHaveLength(1)
    expect(source.writes[0]?.command).toMatchObject({
      operation: 'semantic_intake',
      provenance: {
        channel: 'semantic-intake-v1',
        sourceKind: 'mcp',
        sourceId: 'chatgpt-current',
        sourceRecordId: 'message-1',
      },
      compensation: { operation: 'semantic_batch' },
    })
    expect(JSON.stringify(source.writes[0]?.command?.payload)).not.toContain('这个岗位我不投了')
    expect(source.state.data.opportunities[0]).toMatchObject({ participationStatus: 'abandoned' })
  })

  it('fails before reading/writing when the server authorizer rejects a source', async () => {
    const source = new TransactionalSource()
    const read = vi.spyOn(source, 'read')
    const result = await invokeSemanticIntake(source, args({
      source: {
        kind: 'paia',
        sourceId: 'paia:owner-input',
        sourceRecordId: 'input-1',
        sourceVersion: 'v1',
        observedAt: '2026-09-20T10:00:00.000Z',
        timezone: 'Asia/Shanghai',
      },
    }), {
      authorize: async () => {
        throw new Error('not authorized')
      },
    })
    expect(result.isError).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(source.writes).toHaveLength(0)
  })

  it('adapts authorized PAIA owner input through the same Semantic Intake ledger without persisting raw owner text', async () => {
    const source = new TransactionalSource()
    const authorize = vi.fn(async () => undefined)
    const result = await invokePaiaIntake(source, args({
      inputId: 'paia-owner-input-0001',
      source: {
        kind: 'paia',
        sourceId: 'paia:owner-input',
        sourceRecordId: 'archive-input-1',
        sourceVersion: 'capture-v1',
        observedAt: '2026-09-20T10:00:00.000Z',
        assertedAt: '2026-09-20T10:00:00.000Z',
        timezone: 'Asia/Shanghai',
      },
      originalText: 'PAIA_RAW_OWNER_TEXT_SHOULD_NOT_PERSIST',
    }), { authorize })

    expect(result.isError).not.toBe(true)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(source.writes).toHaveLength(1)
    expect(source.writes[0]?.command?.provenance).toMatchObject({
      sourceKind: 'paia',
      sourceId: 'paia:owner-input',
      sourceRecordId: 'archive-input-1',
    })
    expect(JSON.stringify(source.writes[0]?.command?.payload)).not.toContain('PAIA_RAW_OWNER_TEXT_SHOULD_NOT_PERSIST')
  })

  it('rejects non-PAIA payloads at the PAIA adapter boundary before workspace access', async () => {
    const source = new TransactionalSource()
    const read = vi.spyOn(source, 'read')
    const result = await invokePaiaIntake(source, args())
    expect(result.isError).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(source.writes).toHaveLength(0)
  })

  it('persists an ambiguity as DecisionRequest and resolves only the exact offered choice', async () => {
    const source = new TransactionalSource()
    source.state.data.opportunities.push({
      ...source.state.data.opportunities[0]!,
      id: 'opp-2',
      role: 'Product Manager - Platform',
    })
    source.state.data.opportunities[0]!.role = 'Product Manager - Growth'

    const pending = await invokeSemanticIntake(source, args({
      candidates: [{
        id: 'candidate-1',
        kind: 'abandon_opportunity',
        target: { company: 'Example Co' },
        objectConfidence: 'high',
        eventConfidence: 'high',
        evidenceRefs: [],
        sourceVersionRefs: [],
      }],
    }))
    expect(pending.structuredContent).toMatchObject({ applied: false, decisionRequired: true })
    const request = source.state.data.decisionRequests?.[0]
    expect(request).toMatchObject({ reason: 'ambiguous_target', state: 'open' })
    const choice = request!.choices.find((item) => item.resolution?.opportunityId === 'opp-2')!

    const resolved = await invokeResolveSemanticDecision(source, {
      requestId: request!.id,
      choiceId: choice.id,
    })
    expect(resolved.isError).not.toBe(true)
    expect(resolved.structuredContent).toMatchObject({ applied: true, workspaceVersion: 'txn:6' })
    expect(source.state.data.opportunities.find((item) => item.id === 'opp-2')).toMatchObject({ participationStatus: 'abandoned' })
    expect(source.state.data.opportunities.find((item) => item.id === 'opp-1')?.participationStatus).not.toBe('abandoned')
  })

  it('applies ledger-backed Undo only while the target command is the latest revision', async () => {
    const source = new TransactionalSource()
    const applied = await invokeSemanticIntake(source, args())
    const commandId = String((applied.structuredContent as any)?.commandId)

    const undone = await invokeSemanticUndo(source, { targetCommandId: commandId })
    expect(undone.isError).not.toBe(true)
    expect(undone.structuredContent).toMatchObject({ applied: true, targetCommandId: commandId, workspaceVersion: 'txn:6' })
    expect(source.state.data.opportunities[0]?.participationStatus).toBe('active')

    const sourceWithDependentChange = new TransactionalSource()
    const first = await invokeSemanticIntake(sourceWithDependentChange, args())
    const firstCommand = String((first.structuredContent as any)?.commandId)
    sourceWithDependentChange.revision += 1
    const refused = await invokeSemanticUndo(sourceWithDependentChange, { targetCommandId: firstCommand })
    expect(refused.isError).not.toBe(true)
    expect(refused.structuredContent).toMatchObject({
      applied: false,
      needsConfirmation: true,
      reason: 'DEPENDENT_CHANGES',
    })
  })
})

import { createDefaultDecisionRules } from '../src/decisionRules.js'
import { recordCorrectionWorkspace } from './fixtures/recordCorrectionWorkspace.js'
import { applicationDeadlineFingerprint } from '../src/applicationDeadline.js'
import { applyWorkspaceDelta, type WorkspaceDelta } from '../src/workspaceDelta.js'
import { historyActionWorkspace } from './fixtures/historyActionWorkspace.js'
import { describe, expect, it, vi } from 'vitest'
import type { AuthoritativeCommandExecutorOptions } from '../gateway/authoritativeCommands.js'
import { createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'

function snapshot(): PJSDASSnapshot {
  return {
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-23T00:00:00.000Z',
    data: {
      opportunities: [{
        id: 'opp-1',
        company: 'Alpha',
        role: 'Role A',
        stage: '准备申请',
        source: 'Manual',
        sourceType: 'Manual',
        nextStep: 'Apply',
        urgency: 50,
        opportunityValue: 50,
        fitScore: 50,
        assessmentStatus: 'unassessed',
        locallyManaged: true,
        importedAt: '2026-09-23T00:00:00.000Z',
      }, {
        id: 'opp-2',
        company: 'Beta',
        role: 'Role B',
        stage: '准备申请',
        source: 'Manual',
        sourceType: 'Manual',
        nextStep: 'Apply',
        urgency: 50,
        opportunityValue: 50,
        fitScore: 50,
        assessmentStatus: 'unassessed',
        locallyManaged: true,
        importedAt: '2026-09-23T00:00:00.000Z',
      }],
      processes: [],
      processEvents: [],
      actions: [{
        id: 'action-1',
        kind: 'manual',
        title: 'Alpha task',
        opportunityId: 'opp-1',
        estimatedMinutes: 15,
        leverage: 50,
        delayCost: 50,
        status: 'todo',
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      }, {
        id: 'action-2',
        kind: 'manual',
        title: 'Beta task',
        opportunityId: 'opp-2',
        estimatedMinutes: 15,
        leverage: 50,
        delayCost: 50,
        status: 'todo',
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      }],
      prep: [],
      applicationGroups: [],
      timeline: [],
    },
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function harness(initial = snapshot(), managementOptions: Pick<AuthoritativeCommandExecutorOptions, 'resolveBusinessManagementGrant' | 'aiCaptureConfirmationEnabled'> = {}, hooks: { beforeCommit?: (state: { current: PJSDASSnapshot; revision: number }) => Response | undefined } = {}, captureRows: any[] = []) {
  let current = upgradeSnapshotToLatest(initial)
  let revision = 1
  const ledger: Array<{
    command_id: string
    operation: string
    payload_hash: string
    resulting_revision: number
    status: 'COMMITTED'
    receipt: Record<string, unknown>
    compensation: Record<string, unknown> | null
  }> = []

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/v1/pjsdas_workspaces') {
      return json([{ id: 'ws-1', user_id: 'user-a', snapshot: current, revision, schema_version: current.version }])
    }
    if (url.pathname === '/rest/v1/pjsdas_ai_capture_previews') return json(captureRows.filter(row => row.user_id === url.searchParams.get('user_id')?.slice(3) && row.request_id === url.searchParams.get('request_id')?.slice(3)))
    if (url.pathname === '/rest/v1/pjsdas_command_ledger') {
      const commandId = url.searchParams.get('command_id')?.replace(/^eq\./, '')
      const after = Number(url.searchParams.get('resulting_revision')?.replace(/^gt\./, '') ?? '-1')
      const rows = ledger.filter((item) =>
        (commandId ? item.command_id === commandId : true)
        && (Number.isFinite(after) ? item.resulting_revision > after : true))
      return json(rows)
    }
    if (url.pathname === '/rest/v1/rpc/pjsdas_commit_ai_capture' || url.pathname === '/rest/v1/rpc/pjsdas_commit_workspace_v2' || url.pathname === '/rest/v1/rpc/pjsdas_commit_management_workspace_v1') {
      const intercepted = hooks.beforeCommit?.({ current, revision })
      if (intercepted) return intercepted
      const body = JSON.parse(String(init?.body))
      const existing = ledger.find((item) => item.command_id === body.target_command_id)
      if (existing) {
        if (existing.payload_hash !== body.target_payload_hash) return json({ message: 'different payload' }, 409)
        return json([{
          outcome: 'ALREADY_APPLIED',
          workspace_id: 'ws-1',
          revision,
          snapshot: current,
          receipt: existing.receipt,
        }])
      }
      if (body.target_expected_revision !== revision) {
        return json([{
          outcome: 'CONFLICT',
          workspace_id: 'ws-1',
          revision,
          snapshot: current,
          receipt: { status: 'CONFLICT', actualRevision: revision },
        }])
      }
      revision += 1
      current = body.target_snapshot
      const receipt = {
        ...body.target_receipt_context,
        commandId: body.target_command_id,
        receiptId: `command-receipt:${body.target_command_id}`,
        status: 'COMMITTED',
        operation: body.target_operation,
        revision,
        undoAvailable: Boolean(body.target_compensation),
      }
      ledger.push({
        command_id: body.target_command_id,
        operation: body.target_operation,
        payload_hash: body.target_payload_hash,
        resulting_revision: revision,
        status: 'COMMITTED',
        receipt,
        compensation: body.target_compensation,
      })
      return json([{ outcome: 'COMMITTED', workspace_id: 'ws-1', revision, snapshot: current, receipt }])
    }
    return json({ message: `unexpected ${url.pathname}` }, 500)
  }) as unknown as typeof fetch

  return {
    executor: createAuthoritativeCommandExecutor({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role',
      aiCaptureConfirmationEnabled: true,
      fetchImpl,
      ...managementOptions,
    }),
    principal: { kind: 'first_party_web' as const, userId: 'user-a' },
    ledger,
    state: () => ({ current, revision }),
  }
}

function statusCommand(commandId: string, actionId: string, status: 'todo' | 'doing' | 'done') {
  return {
    commandId,
    command: {
      type: 'domain' as const,
      value: { commandId, kind: 'set_action_status' as const, actionId, status },
    },
  }
}

describe('CGR-01 authoritative command executor', () => {
  it('recovers a committed command by stable identity and makes retry idempotent', async () => {
    const h = harness()
    const first = await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0001', 'action-1', 'done'), baseRevision: 1 })
    expect(first).toMatchObject({
      outcome: 'COMMITTED',
      revision: 2,
      receipt: { receiptId: 'command-receipt:cmd-action-0001', undoAvailable: true },
    })
    const recovered = await h.executor.lookup(h.principal, 'cmd-action-0001')
    expect(recovered).toMatchObject({ found: true, resultingRevision: 2 })
    const retry = await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0001', 'action-1', 'done'), baseRevision: 1 })
    expect(retry.outcome).toBe('ALREADY_APPLIED')
    expect(h.ledger).toHaveLength(1)
    expect(h.state().current.data.actions.find((item) => item.id === 'action-1')?.status).toBe('done')
  })

  it('rebases a stale first-party command when an automation source changed only an unrelated business object', async () => {
    const h = harness()
    await h.executor.execute(
      { kind: 'automation', userId: 'user-a', sourceId: 'gmail:primary' },
      { ...statusCommand('cmd-action-0001', 'action-1', 'done'), baseRevision: 1 },
    )
    const second = await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0002', 'action-2', 'done'), baseRevision: 1 })
    expect(second).toMatchObject({
      outcome: 'COMMITTED',
      revision: 3,
      receipt: { lifecycle: { baseRevision: 1, authoritativeRevisionBeforeCommit: 2, rebased: true } },
    })
    expect(h.state().current.data.actions.map((item) => [item.id, item.status])).toEqual([
      ['action-1', 'done'],
      ['action-2', 'done'],
    ])
  })

  it('fails closed with concrete object conflict when the same object changed', async () => {
    const h = harness()
    await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0001', 'action-1', 'done'), baseRevision: 1 })
    const conflict = await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0002', 'action-1', 'doing'), baseRevision: 1 })
    expect(conflict).toMatchObject({
      outcome: 'CONFLICT',
      revision: 2,
      conflict: {
        kind: 'OBJECT_CONFLICT',
        objects: [{ type: 'action', id: 'action-1' }],
        interveningCommandIds: ['cmd-action-0001'],
      },
    })
    expect(h.state().current.data.actions.find((item) => item.id === 'action-1')?.status).toBe('done')
  })

  it('merges independent opportunity preference and confirmed fact at one stale base', async () => {
    const facts = [
      { field: 'location', value: 'Taipei' },
      { field: 'compensationText', value: 'NT$2m' },
      { field: 'applicationUrl', value: 'https://example.com/apply' },
    ] as const
    for (const [index, factCase] of facts.entries()) for (const firstKind of ['preference', 'fact'] as const) {
      const h = harness()
      const preference = { commandId: 'cmd-preference-0001', baseRevision: 1, command: { type: 'domain' as const,
        value: { commandId: 'cmd-preference-0001', kind: 'set_opportunity_preference' as const,
          opportunityId: 'opp-1', roleType: 'core' as const } } }
      const fact = { commandId: `cmd-fact-${index}`, baseRevision: 1, command: { type: 'domain' as const,
        value: { commandId: `cmd-fact-${index}`, kind: 'correct_opportunity_fact' as const,
          opportunityId: 'opp-1', field: factCase.field, value: factCase.value } } }
      const first = firstKind === 'preference' ? preference : fact
      const second = firstKind === 'preference' ? fact : preference
      expect((await h.executor.execute(h.principal, first)).outcome).toBe('COMMITTED')
      expect((await h.executor.execute(h.principal, second)).outcome).toBe('COMMITTED')
      const opportunity = h.state().current.data.opportunities.find(item => item.id === 'opp-1')!
      expect(opportunity.roleType).toBe('core')
      expect(opportunity.detail?.userFacts?.[factCase.field]).toBe(factCase.value)
      expect(h.ledger).toHaveLength(2)
    }
  })

  it('rejects contradictory same-field opportunity facts and preserves both receipts and current fact', async () => {
    const h = harness()
    const command = (commandId: string, value: string) => ({ commandId, baseRevision: 1,
      command: { type: 'domain' as const, value: { commandId, kind: 'correct_opportunity_fact' as const,
        opportunityId: 'opp-1', field: 'location' as const, value } } })
    expect((await h.executor.execute(h.principal, command('cmd-fact-taipei', 'Taipei'))).outcome).toBe('COMMITTED')
    const conflict = await h.executor.execute(h.principal, command('cmd-fact-tokyo', 'Tokyo'))
    expect(conflict).toMatchObject({ outcome: 'CONFLICT', conflict: {
      kind: 'OBJECT_CONFLICT', objects: [{ type: 'opportunity', id: 'opp-1' }],
      interveningCommandIds: ['cmd-fact-taipei'],
    } })
    expect(h.state().current.data.opportunities.find(item => item.id === 'opp-1')?.detail?.userFacts?.location).toBe('Taipei')
    expect(h.ledger).toHaveLength(1)
  })

  it('rebases different confirmed fact fields in either command order', async () => {
    for (const firstField of ['location', 'compensationText'] as const) {
      const h = harness()
      const command = (field: 'location' | 'compensationText') => ({
        commandId: `cmd-fact-${field}`, baseRevision: 1, command: { type: 'domain' as const,
          value: { commandId: `cmd-fact-${field}`, kind: 'correct_opportunity_fact' as const,
            opportunityId: 'opp-1', field, value: field === 'location' ? 'Taipei' : 'NT$2m' } },
      })
      const secondField = firstField === 'location' ? 'compensationText' : 'location'
      expect((await h.executor.execute(h.principal, command(firstField))).outcome).toBe('COMMITTED')
      expect((await h.executor.execute(h.principal, command(secondField))).outcome).toBe('COMMITTED')
      expect(h.state().current.data.opportunities.find(item => item.id === 'opp-1')?.detail?.userFacts)
        .toMatchObject({ location: 'Taipei', compensationText: 'NT$2m' })
    }
  })

  it('treats the same confirmed fact as already applied without another evidence write', async () => {
    const h = harness()
    const command = (commandId: string) => ({ commandId, baseRevision: 1,
      command: { type: 'domain' as const, value: { commandId, kind: 'correct_opportunity_fact' as const,
        opportunityId: 'opp-1', field: 'location' as const, value: 'Taipei' } } })
    expect((await h.executor.execute(h.principal, command('cmd-fact-first'))).outcome).toBe('COMMITTED')
    expect((await h.executor.execute(h.principal, command('cmd-fact-same'))).outcome).toBe('ALREADY_APPLIED')
    expect(h.ledger).toHaveLength(1)
    expect(h.state().revision).toBe(2)
  })

  it('merges independent capacity keys but conflicts on the same date override', async () => {
    const h = harness()
    const capacity = (commandId: string, kind: 'set_daily_capacity' | 'set_date_capacity', minutes: number) => ({
      commandId, baseRevision: 1, command: { type: 'domain' as const, value: kind === 'set_daily_capacity'
        ? { commandId, kind, minutes }
        : { commandId, kind, date: '2026-09-25', minutes } },
    })
    expect((await h.executor.execute(h.principal, capacity('cmd-capacity-default', 'set_daily_capacity', 360))).outcome).toBe('COMMITTED')
    expect((await h.executor.execute(h.principal, capacity('cmd-capacity-day', 'set_date_capacity', 120))).outcome).toBe('COMMITTED')
    expect((await h.executor.execute(h.principal, capacity('cmd-capacity-day-conflict', 'set_date_capacity', 240))).outcome).toBe('CONFLICT')
    expect(h.state().current.data.timePlanning).toMatchObject({ defaultDailyMinutes: 360,
      dateOverrides: { '2026-09-25': 120 } })
    expect(h.ledger).toHaveLength(2)
  })

  it('keeps a legacy object-only receipt conservative on a stale same-object command', async () => {
    const h = harness()
    const first = { commandId: 'cmd-preference-legacy', baseRevision: 1, command: { type: 'domain' as const,
      value: { commandId: 'cmd-preference-legacy', kind: 'set_opportunity_preference' as const,
        opportunityId: 'opp-1', roleType: 'core' as const } } }
    expect((await h.executor.execute(h.principal, first)).outcome).toBe('COMMITTED')
    delete h.ledger[0].receipt.affectedFields
    delete h.ledger[0].receipt.conflictScopes
    const second = { commandId: 'cmd-fact-after-legacy', baseRevision: 1, command: { type: 'domain' as const,
      value: { commandId: 'cmd-fact-after-legacy', kind: 'correct_opportunity_fact' as const,
        opportunityId: 'opp-1', field: 'location' as const, value: 'Taipei' } } }
    expect((await h.executor.execute(h.principal, second)).outcome).toBe('CONFLICT')
    expect(h.ledger).toHaveLength(1)
  })

  it('keeps dependent deadline updates object-scoped in either stale command order', async () => {
    for (const firstKind of ['deadline', 'fact'] as const) {
      const h = harness()
      const deadline = { commandId: 'cmd-deadline-guard', baseRevision: 1,
        command: { type: 'domain' as const, value: { commandId: 'cmd-deadline-guard',
          kind: 'set_deadline' as const, opportunityId: 'opp-1',
          deadline: '2026-09-28T00:00:00.000Z', precision: 'datetime' as const } } }
      const fact = { commandId: 'cmd-fact-guard', baseRevision: 1,
        command: { type: 'domain' as const, value: { commandId: 'cmd-fact-guard',
          kind: 'correct_opportunity_fact' as const, opportunityId: 'opp-1',
          field: 'location' as const, value: 'Taipei' } } }
      const first = firstKind === 'deadline' ? deadline : fact
      const second = firstKind === 'deadline' ? fact : deadline
      expect((await h.executor.execute(h.principal, first)).outcome).toBe('COMMITTED')
      expect((await h.executor.execute(h.principal, second)).outcome).toBe('CONFLICT')
      expect(h.ledger).toHaveLength(1)
    }
  })

  it('retains append-only process evidence while refusing a stale competing stage update', async () => {
    const h = harness()
    const event = (commandId: string, eventType: 'assessment_invite' | 'interview_invite', baseRevision: number) => ({
      commandId, baseRevision, command: { type: 'domain' as const, value: {
        commandId, kind: 'record_process_event' as const, opportunityId: 'opp-1', eventType,
        occurredAt: eventType === 'assessment_invite' ? '2026-09-23T01:00:00.000Z' : '2026-09-24T01:00:00.000Z',
        dueAt: eventType === 'assessment_invite' ? '2026-09-25T01:00:00.000Z' : '2026-09-26T01:00:00.000Z',
      } },
    })
    expect((await h.executor.execute(h.principal, event('cmd-event-assessment', 'assessment_invite', 1))).outcome).toBe('COMMITTED')
    expect((await h.executor.execute(h.principal, event('cmd-event-stale-interview', 'interview_invite', 1))).outcome).toBe('CONFLICT')
    expect(h.state().current.data.processEvents.map(item => item.type)).toEqual(['assessment_invite'])
    expect((await h.executor.execute(h.principal, event('cmd-event-current-interview', 'interview_invite', 2))).outcome).toBe('COMMITTED')
    expect(h.state().current.data.processEvents.map(item => item.type)).toEqual(['assessment_invite', 'interview_invite'])
    expect(h.ledger).toHaveLength(2)
  })

  it('refuses historical event deletion before any CAS workspace write', async () => {
    const h = harness()
    const before = historyActionWorkspace()
    const event = { id: 'retained-event', opportunityId: 'history-job', company: 'History company', role: 'Engineer', type: 'written_test_invite' as const,
      occurredAt: '2026-09-20T00:00:00.000Z', dueAt: '2026-09-20T01:00:00.000Z', source: 'manual' as const, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' }
    before.data.processEvents = [event]
    before.data.actions[0].processEventId = event.id
    before.data.scheduleNodes![0].processEventId = event.id
    Object.assign(h.state().current.data, before.data)
    const original = structuredClone(h.state().current)
    const result = await h.executor.execute(h.principal, { commandId: 'cmd-delete-history-0001', baseRevision: 1, command: { type: 'process_event_delete', value: { eventId: event.id } } })
    expect(result).toMatchObject({ outcome: 'CONFLICT', conflict: { reason: 'HISTORICAL_OCCURRENCES_RETAINED' } })
    expect(h.ledger).toEqual([])
    expect(h.state().current).toEqual(original)
    expect(h.state().revision).toBe(1)
  })

  it.each(['raw', 'absent'] as const)('restores %s historical MCP rules exactly without new defaults or timestamps', async state => {
    const h = harness()
    const before = state === 'absent' ? null : { ...createDefaultDecisionRules('2026-01-01T00:00:00Z'), retainedMetadata: { source: 'Historical only' } }
    if (before) {
      delete before.fitComponentWeights
      delete before.opportunityValueComponentWeights
      delete before.portfolioWeights
      delete before.portfolioMinimumCandidateScore
    }
    h.state().current.data.decisionRules = { ...createDefaultDecisionRules('2026-09-01T00:00:00Z'), prepDailyCap: 3 }
    const original = structuredClone(h.state().current.data)
    h.ledger.push({ command_id: 'historic-rules-0001', operation: 'mcp_apply_rules', payload_hash: 'historic-rules-hash', resulting_revision: 1, status: 'COMMITTED',
      receipt: { affectedObjects: [{ type: 'decision_rules', id: 'current' }], undoDependencyObjects: [{ type: 'decision_rules', id: 'current' }] },
      compensation: { operation: 'mcp_restore_decision_rules', payload: { before } } })
    const undone = await h.executor.undo(h.principal, { commandId: 'undo-historic-rules-0001', targetCommandId: 'historic-rules-0001' })
    expect(undone.outcome).toBe('COMMITTED')
    if (before) expect(h.state().current.data.decisionRules).toEqual(before)
    else expect(h.state().current.data).not.toHaveProperty('decisionRules')
    for (const key of ['opportunities', 'processes', 'processEvents', 'actions', 'scheduleNodes'] as const) expect(h.state().current.data[key]).toEqual(original[key])
    expect(h.ledger).toHaveLength(2)
  })

  it('persists bounded occurrence compensation and retains historical facts through authoritative Undo', async () => {
    const h = harness()
    const before = historyActionWorkspace()
    Object.assign(h.state().current.data, structuredClone(before.data))
    const result = await h.executor.execute(h.principal, { ...statusCommand('cmd-history-0001', 'history-task', 'done'), baseRevision: 1 })
    expect(result.outcome).toBe('COMMITTED')
    h.ledger[0].compensation = JSON.parse(JSON.stringify(h.ledger[0].compensation))
    const completedTimeline = structuredClone(h.state().current.data.timeline)
    const undone = await h.executor.undo(h.principal, { commandId: 'cmd-undo-history-0001', targetCommandId: 'cmd-history-0001' })
    expect(undone.outcome).toBe('COMMITTED')
    for (const node of before.data.scheduleNodes!) {
      const actual = h.state().current.data.scheduleNodes!.find((item) => item.id === node.id)!
      expect(actual).toMatchObject({ state: node.state, updatedAt: node.updatedAt })
      expect(actual.completedAt).toBe(node.completedAt)
    }
    for (const row of completedTimeline ?? []) expect(h.state().current.data.timeline).toContainEqual(row)
    expect(h.ledger).toHaveLength(2)
  })

  it('allows compensating Undo after an unrelated later mutation', async () => {
    const h = harness()
    await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0001', 'action-1', 'done'), baseRevision: 1 })
    await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0002', 'action-2', 'done'), baseRevision: 2 })
    const undone = await h.executor.undo(h.principal, {
      commandId: 'cmd-undo-0001',
      targetCommandId: 'cmd-action-0001',
    })
    expect(undone).toMatchObject({
      outcome: 'COMMITTED',
      revision: 4,
      receipt: { undoOf: 'cmd-action-0001' },
    })
    expect(h.state().current.data.actions.map((item) => [item.id, item.status])).toEqual([
      ['action-1', 'todo'],
      ['action-2', 'done'],
    ])
  })

  it('refuses Undo when a later mutation depends on the same object', async () => {
    const h = harness()
    await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0001', 'action-1', 'done'), baseRevision: 1 })
    await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0002', 'action-1', 'doing'), baseRevision: 2 })
    const undone = await h.executor.undo(h.principal, {
      commandId: 'cmd-undo-0001',
      targetCommandId: 'cmd-action-0001',
    })
    expect(undone).toMatchObject({
      outcome: 'CONFLICT',
      conflict: {
        kind: 'OBJECT_CONFLICT',
        objects: [{ type: 'action', id: 'action-1' }],
        interveningCommandIds: ['cmd-action-0002'],
      },
    })
    expect(h.ledger).toHaveLength(2)
    expect(h.state().current.data.actions.find((item) => item.id === 'action-1')?.status).toBe('doing')
  })

  it('executes occurrence completion and reschedule against the authoritative schedule identity', async () => {
    const completeHarness = harness()
    completeHarness.state().current.data.scheduleNodes = [{
      id: 'schedule:occurrence-1:v1',
      occurrenceId: 'occurrence-1',
      version: 1,
      opportunityId: 'opp-1',
      kind: 'interview',
      state: 'scheduled',
      temporal: {
        shape: 'fixed_range',
        precision: 'datetime',
        timezone: 'Asia/Taipei',
        startAt: '2026-09-24T02:00:00.000Z',
        endAt: '2026-09-24T03:00:00.000Z',
        resolutionBasis: 'user_explicit',
      },
      constraintKind: 'employer_hard',
      evidenceRefs: [],
      sourceVersionRefs: [],
      relatedActionIds: ['action-1'],
      relatedPrepIds: [],
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    }]
    const completed = await completeHarness.executor.execute(completeHarness.principal, {
      commandId: 'cmd-occurrence-complete-0001',
      baseRevision: 1,
      command: {
        type: 'domain',
        value: {
          commandId: 'cmd-occurrence-complete-0001',
          kind: 'complete_occurrence',
          occurrenceId: 'occurrence-1',
          occurredAt: '2026-09-24T03:05:00.000Z',
        },
      },
    })
    expect(completed).toMatchObject({
      outcome: 'COMMITTED',
      receipt: {
        affectedObjects: expect.arrayContaining([
          { type: 'schedule_occurrence', id: 'occurrence-1' },
          { type: 'action', id: 'action-1' },
        ]),
      },
    })
    expect(completeHarness.state().current.data.scheduleNodes?.find((node) => node.occurrenceId === 'occurrence-1')).toMatchObject({
      state: 'completed',
      completedAt: '2026-09-24T03:05:00.000Z',
    })
    expect(completeHarness.state().current.data.actions.find((item) => item.id === 'action-1')?.status).toBe('done')
    const staleReschedule = await completeHarness.executor.execute(completeHarness.principal, {
      commandId: 'cmd-occurrence-stale-reschedule', baseRevision: 1,
      command: { type: 'domain', value: { commandId: 'cmd-occurrence-stale-reschedule',
        kind: 'reschedule_occurrence', occurrenceId: 'occurrence-1', temporal: {
          shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Taipei',
          startAt: '2026-09-26T02:00:00.000Z', endAt: '2026-09-26T03:00:00.000Z',
          resolutionBasis: 'user_explicit',
        } } },
    })
    expect(staleReschedule).toMatchObject({ outcome: 'CONFLICT', conflict: {
      objects: [{ type: 'schedule_occurrence', id: 'occurrence-1' }],
    } })
    expect(completeHarness.state().current.data.scheduleNodes?.filter(node => node.occurrenceId === 'occurrence-1')).toHaveLength(1)
    expect(completeHarness.ledger).toHaveLength(1)

    const rescheduleHarness = harness()
    rescheduleHarness.state().current.data.scheduleNodes = [{
      id: 'schedule:occurrence-2:v1',
      occurrenceId: 'occurrence-2',
      version: 1,
      opportunityId: 'opp-2',
      kind: 'interview',
      state: 'scheduled',
      temporal: {
        shape: 'fixed_range',
        precision: 'datetime',
        timezone: 'Asia/Taipei',
        startAt: '2026-09-25T02:00:00.000Z',
        endAt: '2026-09-25T03:00:00.000Z',
        resolutionBasis: 'source_explicit',
      },
      constraintKind: 'employer_hard',
      evidenceRefs: ['old-mail'],
      sourceVersionRefs: ['mail-v1'],
      relatedActionIds: ['action-2'],
      relatedPrepIds: [],
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    }]
    const rescheduled = await rescheduleHarness.executor.execute(rescheduleHarness.principal, {
      commandId: 'cmd-occurrence-reschedule-0001',
      baseRevision: 1,
      command: {
        type: 'domain',
        value: {
          commandId: 'cmd-occurrence-reschedule-0001',
          kind: 'reschedule_occurrence',
          occurrenceId: 'occurrence-2',
          temporal: {
            shape: 'fixed_range',
            precision: 'datetime',
            timezone: 'Asia/Taipei',
            startAt: '2026-09-26T06:00:00.000Z',
            endAt: '2026-09-26T07:00:00.000Z',
            resolutionBasis: 'source_explicit',
          },
          evidenceRefs: ['reschedule-mail'],
          sourceVersionRefs: ['mail-v2'],
        },
      },
    })
    expect(rescheduled.outcome).toBe('COMMITTED')
    const versions = rescheduleHarness.state().current.data.scheduleNodes?.filter((node) => node.occurrenceId === 'occurrence-2') ?? []
    expect(versions).toHaveLength(2)
    expect(versions.find((node) => node.version === 1)).toMatchObject({ state: 'superseded' })
    expect(versions.find((node) => node.version === 2)).toMatchObject({
      state: 'scheduled',
      temporal: { startAt: '2026-09-26T06:00:00.000Z' },
      evidenceRefs: expect.arrayContaining(['old-mail', 'reschedule-mail']),
      sourceVersionRefs: expect.arrayContaining(['mail-v1', 'mail-v2']),
    })
  })

  it('executes Web Semantic Intake and resolves its DecisionRequest on the server', async () => {
    const h = harness()
    const observation = {
      contractVersion: 1 as const,
      inputId: 'semantic-web-0001',
      source: {
        kind: 'web' as const,
        sourceId: 'tell-pjsdas',
        sourceRecordId: 'capture-0001',
        sourceVersion: 'v1',
        observedAt: '2026-09-23T01:00:00.000Z',
        assertedAt: '2026-09-23T01:00:00.000Z',
        timezone: 'Asia/Taipei',
      },
      statementMode: 'assertion' as const,
      candidates: [{
        id: 'candidate-manual-0001',
        kind: 'manual_action' as const,
        title: 'Send a visitor access request',
        target: { opportunityId: 'opp-1' },
        objectConfidence: 'low' as const,
        eventConfidence: 'high' as const,
        evidenceRefs: [],
        sourceVersionRefs: [],
      }],
    }
    const pending = await h.executor.execute(h.principal, {
      commandId: 'cmd-semantic-web-0001',
      baseRevision: 1,
      command: { type: 'semantic_intake', value: observation },
    })
    expect(pending).toMatchObject({
      outcome: 'COMMITTED',
      result: { status: 'DECISION_REQUIRED' },
    })
    const request = h.state().current.data.decisionRequests?.[0]
    expect(request).toMatchObject({ state: 'open', reason: 'low_confidence' })
    const confirm = request?.choices.find((choice) => choice.resolution?.confirm)
    expect(confirm).toBeDefined()

    const resolved = await h.executor.execute(h.principal, {
      commandId: 'cmd-decision-web-0001',
      baseRevision: 2,
      command: {
        type: 'resolve_semantic_decision',
        value: { requestId: request!.id, choiceId: confirm!.id },
      },
    })
    expect(resolved).toMatchObject({
      outcome: 'COMMITTED',
      result: { status: 'APPLIED' },
    })
    expect(h.state().current.data.decisionRequests?.find((item) => item.id === request!.id)).toMatchObject({
      state: 'answered',
      answerChoiceId: confirm!.id,
    })
    expect(h.state().current.data.actions.some((item) => item.title === 'Send a visitor access request')).toBe(true)
  })

  it('keeps first-party Web Semantic Intake source authorization fail closed', async () => {
    const h = harness()
    await expect(h.executor.execute(h.principal, {
      commandId: 'cmd-semantic-mcp-0001',
      baseRevision: 1,
      command: {
        type: 'semantic_intake',
        value: {
          contractVersion: 1,
          inputId: 'semantic-mcp-0001',
          source: {
            kind: 'mcp',
            sourceId: 'chatgpt',
            sourceRecordId: 'message-1',
            observedAt: '2026-09-23T01:00:00.000Z',
            timezone: 'Asia/Taipei',
          },
          statementMode: 'assertion',
          candidates: [],
        },
      },
    })).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(h.ledger).toHaveLength(0)
  })

})


it('compact manual action receipt projects the exact committed derived schedule node', async () => {
  const h = harness(), before = h.state().current, commandId = 'manual-derived-schedule'
  const result = await h.executor.execute(h.principal, { commandId, baseRevision: 1, command: { type: 'domain', value: {
    commandId, kind: 'add_manual_action', title: 'Return visitor badge', scheduledTemporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: '2026-10-02T10:00:00Z', resolutionBasis: 'user_explicit' } } } })
  const delta = result.receipt!.projectionDelta as WorkspaceDelta
  const projected = applyWorkspaceDelta(before, delta)
  expect(h.state().current.data.scheduleNodes!.some(node => node.relatedActionIds.includes(projected.data.actions.find(action => action.title === 'Return visitor badge')!.id))).toBe(true)
  expect(projected.data).toEqual(h.state().current.data)
})


describe('website record corrections use the existing authoritative command boundary', () => {
  function correction(h: ReturnType<typeof harness>) {
    const snapshot = h.state().current, target = snapshot.data.opportunities.find(item => item.id === 'expired')!
    return { commandId: 'synthetic-ui-correction', kind: 'correct_application_deadline' as const, opportunityId: target.id, expectedDeadlineFingerprint: applicationDeadlineFingerprint(target, snapshot.data), correction: { state: 'unknown' as const, sourceUrl: 'https://careers.example.test/role', sourceAuthority: 'official_role' as const, evidence: 'Synthetic verified public role has no published deadline. Availability remains unknown.', checkedAt: '2026-10-02T08:00:00Z', postingStatus: 'unknown' as const } }
  }
  it('commits once through CAS, recovers its receipt, and exposes no unsupported undo', async () => {
    const h = harness(recordCorrectionWorkspace()), command = correction(h)
    const body = { commandId: command.commandId, baseRevision: 1, command: { type: 'domain' as const, value: command } }
    const first = await h.executor.execute(h.principal, body)
    expect(first.outcome).toBe('COMMITTED')
    expect(first.receipt?.undoAvailable).toBe(false)
    expect((await h.executor.execute(h.principal, body)).outcome).toBe('ALREADY_APPLIED')
    expect((await h.executor.lookup(h.principal, command.commandId)).found).toBe(true)
    expect(h.ledger).toHaveLength(1)
    expect(h.state().current.data.opportunities.find(item => item.id === 'expired')!.detail?.deadlineCorrections).toHaveLength(1)
    await expect(h.executor.execute(h.principal, { ...body, command: { ...body.command, value: { ...command, correction: { ...command.correction, evidence: 'Different payload.' } } } })).rejects.toThrow(/reused/)
  })
  it('refuses a protected or stale exact owner even when invoked directly through the website endpoint', async () => {
    const h = harness(recordCorrectionWorkspace()), command = correction(h)
    h.state().current.data.opportunities.find(item => item.id === 'expired')!.processStage = 'screening'
    await expect(h.executor.execute(h.principal, { commandId: command.commandId, baseRevision: 1, command: { type: 'domain', value: command } })).rejects.toThrow(/unsubmitted/)
    expect(h.ledger).toHaveLength(0)
    const clean = harness(recordCorrectionWorkspace()), stale = correction(clean)
    clean.state().current.data.scheduleNodes!.find(item => item.opportunityId === 'expired')!.temporal.date = '2026-11-01'
    await expect(clean.executor.execute(clean.principal, { commandId: stale.commandId, baseRevision: 1, command: { type: 'domain', value: stale } })).rejects.toThrow(/changed/)
    expect(clean.ledger).toHaveLength(0)
  })
})


describe('business management through existing authoritative transaction', () => {
  const principal = { kind: 'delegated_mcp' as const, userId: 'user-a', clientId: 'synthetic-client' }
  const granted = { resolveBusinessManagementGrant: async () => ({ id: '00000000-0000-4000-8000-000000000001', revision: 1, userId: 'user-a', clientId: 'synthetic-client', consentVersion: 2 as const, capability: 'workspace.manage' as const, grantedAt: '2026-10-01T00:00:00Z' }) }
  const create = { commandId: 'managed-create-001', baseRevision: 1, command: { type: 'business_management', value: { operations: [{ kind: 'create_application_group', value: { company: 'Synthetic group', total: 2 } }] } } }
  it('commits with audit, projection delta and compensation, then safely undoes', async () => {
    const h = harness(snapshot(), granted)
    const result = await h.executor.execute(principal, create)
    expect(result).toMatchObject({ outcome: 'COMMITTED', revision: 2, result: { type: 'business_management', objects: [{ type: 'application_group', id: 'managed:application_group:managed-create-001:0' }] } })
    expect(h.ledger[0].compensation).toMatchObject({ operation: 'business_management_restore' })
    const retry = await h.executor.execute(principal, create)
    expect(retry.outcome).toBe('ALREADY_APPLIED')
    expect(h.ledger).toHaveLength(1)
    const undo = await h.executor.undo(principal, { commandId: 'managed-undo-001', targetCommandId: create.commandId })
    expect(undo.outcome).toBe('COMMITTED')
    expect(h.state().current.data.applicationGroups).toEqual([])
    expect(h.state().current.data.timeline?.some(item => item.commandId === create.commandId)).toBe(true)
  })
  it('cannot reuse a command id with changed content', async () => {
    const h = harness(snapshot(), granted)
    await h.executor.execute(principal, create)
    const changed = structuredClone(create)
    changed.command.value.operations[0].value.company = 'Changed request'
    await expect(h.executor.execute(principal, changed)).rejects.toThrow(/reused/)
    expect(h.ledger).toHaveLength(1)
  })
  it('rechecks authorization at the commit boundary after the initial check', async () => {
    let checks = 0
    const h = harness(snapshot(), { resolveBusinessManagementGrant: async () => ({ ...await granted.resolveBusinessManagementGrant(), revokedAt: ++checks > 1 ? '2026-10-02T00:00:00Z' : null }) })
    await expect(h.executor.execute(principal, create)).rejects.toThrow(/authorization/)
    expect(checks).toBe(2)
    expect(h.ledger).toHaveLength(0)
    expect(h.state().current.data.applicationGroups).toEqual([])
  })
  it('does not reuse authorization after a transient commit conflict', async () => {
    let revoked = false; let attempts = 0
    const h = harness(snapshot(), { resolveBusinessManagementGrant: async () => ({ ...await granted.resolveBusinessManagementGrant(), revokedAt: revoked ? '2026-10-02T00:00:00Z' : null }) }, { beforeCommit: ({ current, revision }) => {
      attempts++; revoked = true
      return json([{ outcome: 'CONFLICT', workspace_id: 'ws-1', revision, snapshot: current, receipt: { status: 'CONFLICT' } }])
    } })
    await expect(h.executor.execute(principal, create)).rejects.toThrow(/authorization/)
    expect(attempts).toBe(1)
    expect(h.ledger).toHaveLength(0)
    expect(h.state().current.data.applicationGroups).toEqual([])
  })
  it.each(['revision', 'identity'])('does not adopt a newly active grant %s before execute commit', async mode => {
    let checks = 0
    const initial = await granted.resolveBusinessManagementGrant()
    const shared = { ...initial }
    const h = harness(snapshot(), { resolveBusinessManagementGrant: async () => {
      if (++checks > 1) {
        if (mode === 'revision') shared.revision = 2
        else shared.id = '00000000-0000-4000-8000-000000000099'
      }
      return shared
    } })
    await expect(h.executor.execute(principal, create)).rejects.toThrow(/new explicit request/)
    expect(h.ledger).toHaveLength(0)
    expect(h.state().current.data.applicationGroups).toEqual([])
  })
  it.each(['revision', 'identity'])('does not adopt a newly active grant %s after execute CAS conflict', async mode => {
    let epochChanged = false; let attempts = 0
    const h = harness(snapshot(), { resolveBusinessManagementGrant: async () => ({ ...await granted.resolveBusinessManagementGrant(), ...(epochChanged ? mode === 'revision' ? { revision: 2 } : { id: '00000000-0000-4000-8000-000000000099' } : {}) }) }, { beforeCommit: ({ current, revision }) => {
      attempts++; epochChanged = true
      return json([{ outcome: 'CONFLICT', workspace_id: 'ws-1', revision, snapshot: current, receipt: { status: 'CONFLICT' } }])
    } })
    await expect(h.executor.execute(principal, create)).rejects.toThrow(/new explicit request/)
    expect(attempts).toBe(1)
    expect(h.ledger).toHaveLength(0)
  })
  it.each(['revision', 'identity'])('does not adopt a newly active grant %s before undo commit', async mode => {
    let testingUndo = false; let checks = 0
    const h = harness(snapshot(), { resolveBusinessManagementGrant: async () => ({ ...await granted.resolveBusinessManagementGrant(), ...(testingUndo && ++checks > 1 ? mode === 'revision' ? { revision: 2 } : { id: '00000000-0000-4000-8000-000000000099' } : {}) }) })
    await h.executor.execute(principal, create)
    testingUndo = true
    await expect(h.executor.undo(principal, { commandId: 'managed-undo-001', targetCommandId: create.commandId })).rejects.toThrow(/new explicit request/)
    expect(h.ledger).toHaveLength(1)
    expect(h.state().current.data.applicationGroups).toHaveLength(1)
  })
  it.each(['revision', 'identity'])('does not adopt a newly active grant %s after undo CAS conflict', async mode => {
    let testingUndo = false; let epochChanged = false; let attempts = 0
    const h = harness(snapshot(), { resolveBusinessManagementGrant: async () => ({ ...await granted.resolveBusinessManagementGrant(), ...(epochChanged ? mode === 'revision' ? { revision: 2 } : { id: '00000000-0000-4000-8000-000000000099' } : {}) }) }, { beforeCommit: ({ current, revision }) => {
      if (!testingUndo) return undefined
      attempts++; epochChanged = true
      return json([{ outcome: 'CONFLICT', workspace_id: 'ws-1', revision, snapshot: current, receipt: { status: 'CONFLICT' } }])
    } })
    await h.executor.execute(principal, create)
    testingUndo = true
    await expect(h.executor.undo(principal, { commandId: 'managed-undo-001', targetCommandId: create.commandId })).rejects.toThrow(/new explicit request/)
    expect(attempts).toBe(1)
    expect(h.ledger).toHaveLength(1)
    expect(h.state().current.data.applicationGroups).toHaveLength(1)
  })
  it('rechecks authorization immediately before undo commit', async () => {
    let revokeOnSecondCheck = false; let checks = 0
    const h = harness(snapshot(), { resolveBusinessManagementGrant: async () => ({ ...await granted.resolveBusinessManagementGrant(), revokedAt: revokeOnSecondCheck && ++checks > 1 ? '2026-10-02T00:00:00Z' : null }) })
    await h.executor.execute(principal, create)
    revokeOnSecondCheck = true; checks = 0
    await expect(h.executor.undo(principal, { commandId: 'managed-undo-001', targetCommandId: create.commandId })).rejects.toThrow(/authorization/)
    expect(checks).toBe(2)
    expect(h.ledger).toHaveLength(1)
    expect(h.state().current.data.applicationGroups).toHaveLength(1)
  })
  it('rejects other account and client principals before the transaction', async () => {
    const h = harness(snapshot(), granted)
    await expect(h.executor.execute({ ...principal, userId: 'other-account' }, create)).rejects.toThrow(/authorization/)
    await expect(h.executor.execute({ ...principal, clientId: 'other-client' }, create)).rejects.toThrow(/authorization/)
    expect(h.ledger).toHaveLength(0)
  })
  it('refuses a misrouted foreign workspace even if a matching grant exists', async () => {
    const h = harness(snapshot(), { resolveBusinessManagementGrant: async () => ({ ...await granted.resolveBusinessManagementGrant(), userId: 'other-account' }) })
    await expect(h.executor.execute({ ...principal, userId: 'other-account' }, create)).rejects.toThrow(/metadata is invalid/)
    expect(h.ledger).toHaveLength(0)
  })
  it('refuses undo over a later edit to the same prep', async () => {
    const h = harness(snapshot(), granted)
    await h.executor.execute(principal, create)
    await h.executor.execute(principal, { commandId: 'managed-update-002', baseRevision: 2, command: { type: 'business_management', value: { operations: [{ kind: 'update_application_group', id: 'managed:application_group:managed-create-001:0', patch: { company: 'Newer title' } }] } } })
    const result = await h.executor.undo(principal, { commandId: 'managed-undo-001', targetCommandId: create.commandId })
    expect(result.outcome).toBe('CONFLICT')
    expect(h.state().current.data.applicationGroups[0].company).toBe('Newer title')
    expect(h.ledger).toHaveLength(2)
  })
  it('rejects revoked management authorization for undo', async () => {
    let revoked = false
    const h = harness(snapshot(), { resolveBusinessManagementGrant: async () => ({ ...await granted.resolveBusinessManagementGrant(), revokedAt: revoked ? '2026-10-02T00:00:00Z' : null }) })
    await h.executor.execute(principal, create)
    revoked = true
    await expect(h.executor.undo(principal, { commandId: 'managed-undo-001', targetCommandId: create.commandId })).rejects.toThrow(/authorization/)
    expect(h.state().current.data.applicationGroups).toHaveLength(1)
    expect(h.ledger).toHaveLength(1)
  })
  it('rejects a later invalid batch item without commit or partial creation', async () => {
    const h = harness(snapshot(), granted)
    await expect(h.executor.execute(principal, { ...create, command: { type: 'business_management', value: { operations: [...create.command.value.operations, { kind: 'archive_application_group', id: 'foreign-or-missing' }] } } })).rejects.toThrow(/not found/)
    expect(h.state().current.data.applicationGroups).toEqual([])
    expect(h.ledger).toHaveLength(0)
  })
})

describe('B3 first-party viewed metadata', () => {
  it('writes only the owned job read field, rejects external clients, and replays idempotently', async () => {
    const initial = snapshot()
    initial.data.opportunities[0].discoveryRead = { version: 1, addedAt: '2026-10-17T01:00:00.000Z' }
    const h = harness(initial)
    const command = { commandId: 'view-job-command-1', baseRevision: 1, command: { type: 'job_viewed', value: { opportunityId: 'opp-1' } } }
    await expect(h.executor.execute({ kind: 'delegated_mcp', userId: 'user-a', clientId: 'external' } as any, command)).rejects.toThrow('first-party')
    const before = h.state().current
    const result = await h.executor.execute(h.principal, command)
    expect(result.outcome).toBe('COMMITTED')
    expect(result.snapshot.data.opportunities[0].discoveryRead?.viewedAt).toBeTruthy()
    expect(result.snapshot.data.actions).toEqual(before.data.actions)
    expect(result.snapshot.data.opportunities[1]).toEqual(before.data.opportunities[1])
    expect((await h.executor.execute(h.principal, command)).outcome).toBe('ALREADY_APPLIED')
    expect(h.ledger).toHaveLength(1)
    await expect(h.executor.execute(h.principal, { ...command, commandId: 'view-missing-command', command: { type: 'job_viewed', value: { opportunityId: 'foreign-job' } } })).rejects.toThrow('current workspace')
  })
  it('rejects a scope save against another saved version even at the current revision', async () => {
    const h = harness()
    await expect(h.executor.execute(h.principal, { commandId: 'stale-scope-save', baseRevision: 1,
      command: { type: 'discovery_profile', expectedFingerprint: 'a'.repeat(64), value: { targetRoleQueries: ['产品经理'], titleEquals: ['产品经理'], preferredLocations: [], mustHave: [], mustNotHave: [] } } })).rejects.toThrow('Search scope changed')
    expect(h.ledger).toHaveLength(0)
  })
})


describe('immutable AI preview authoritative confirmation', () => {
  function ready() {
    const text = 'Send a visitor access request'
    const observation = { contractVersion: 1, inputId: 'ai:capture-test', statementMode: 'current_intent', originalText: text,
      source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: 'capture-test', sourceVersion: '1', observedAt: '2026-10-19T00:00:00.000Z', timezone: 'UTC' },
      candidates: [{ id: 'ai-capture:1', kind: 'manual_action', title: text, objectConfidence: 'high', eventConfidence: 'high', temporalConfidence: 'high', evidenceRefs: ['capture-test#text=0:29'], sourceVersionRefs: ['1'] }] }
    return { user_id: 'user-a', request_id: 'capture-test', payload_hash: 'a'.repeat(64), text, timezone: 'UTC', reference_time: observation.source.observedAt,
      expected_revision: 1, expires_at: new Date(Date.now() + 900_000).toISOString(), status: 'READY', review: { status: 'ready_for_review', statementMode: 'current_intent', candidates: observation.candidates, issues: [] }, observation }
  }
  const command = { commandId: 'cmd-ai-capture-test', baseRevision: 1, command: { type: 'ai_capture_confirm', value: { requestId: 'capture-test' } } }
  it('commits stored candidates, recovers the same receipt, and uses existing semantic undo', async () => {
    const h = harness(snapshot(), {}, {}, [ready()])
    const result = await h.executor.execute(h.principal, command)
    expect(result).toMatchObject({ outcome: 'COMMITTED', result: { type: 'ai_capture_confirm', status: 'APPLIED' }, receipt: { undoAvailable: true } })
    expect(h.state().current.data.actions.filter(item => item.title === 'Send a visitor access request')).toHaveLength(1)
    expect(await h.executor.execute(h.principal, command)).toMatchObject({ outcome: 'ALREADY_APPLIED', receipt: result.receipt })
    const undone = await h.executor.undo(h.principal, { commandId: 'undo-ai-capture-test', targetCommandId: command.commandId })
    expect(undone.outcome).toBe('COMMITTED')
    expect(h.state().current.data.actions.some(item => item.title === 'Send a visitor access request')).toBe(false)
  })
  it('records a durable confirm receipt even when identical semantic facts are already applied', async () => {
    const row = ready(); const h = harness(snapshot(), {}, {}, [row])
    await h.executor.execute(h.principal, { commandId: 'prior-semantic-command', baseRevision: 1, command: { type: 'semantic_intake', value: row.observation } })
    row.expected_revision = 2
    const result = await h.executor.execute(h.principal, { ...command, baseRevision: 2 })
    expect(result).toMatchObject({ outcome: 'COMMITTED', result: { status: 'ALREADY_APPLIED' }, receipt: { commandType: 'ai_capture_confirm' } })
    expect(h.ledger).toHaveLength(2)
    expect(await h.executor.execute(h.principal, { ...command, baseRevision: 2 })).toMatchObject({ outcome: 'ALREADY_APPLIED', receipt: result.receipt })
  })
  it.each(['UNKNOWN', 'DISPATCHED', 'BLOCKED', 'COMMITTED'])('never commits an unready %s receipt', async status => {
    const h = harness(snapshot(), {}, {}, [{ ...ready(), status }])
    await expect(h.executor.execute(h.principal, command)).rejects.toMatchObject({ code: 'AI_CAPTURE_NOT_READY' })
    expect(h.ledger).toHaveLength(0)
  })
  it('rejects expired reviews and a disabled global confirmation gate', async () => {
    const h = harness(snapshot(), {}, {}, [{ ...ready(), expires_at: '2000-01-01T00:00:00Z' }])
    await expect(h.executor.execute(h.principal, command)).rejects.toMatchObject({ code: 'AI_CAPTURE_EXPIRED' })
    const disabled = harness(snapshot(), { aiCaptureConfirmationEnabled: false }, {}, [ready()])
    await expect(disabled.executor.execute(disabled.principal, command)).rejects.toMatchObject({ code: 'AI_CAPTURE_NOT_ENABLED' })
  })
  it('rejects a stored statement mode changed independently of its review', async () => {
    const row = ready(); row.observation.statementMode = 'question'
    const h = harness(snapshot(), {}, {}, [row])
    await expect(h.executor.execute(h.principal, command)).rejects.toMatchObject({ code: 'AI_CAPTURE_LEDGER_INVALID' })
  })
  it('rejects a different account and injected candidates', async () => {
    const h = harness(snapshot(), {}, {}, [{ ...ready(), user_id: 'user-b' }])
    await expect(h.executor.execute(h.principal, command)).rejects.toMatchObject({ code: 'AI_CAPTURE_NOT_READY' })
    await expect(h.executor.execute(h.principal, { ...command, command: { ...command.command, value: { requestId: 'capture-test', candidates: [] } } })).rejects.toThrow()
    await expect(h.executor.execute({ ...h.principal, kind: 'delegated_mcp' }, command)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
  })
  it('never rebases an old preview after an unrelated workspace write', async () => {
    const h = harness(snapshot(), {}, {}, [ready()])
    await h.executor.execute(h.principal, { ...statusCommand('unrelated-write', 'action-2', 'done'), baseRevision: 1 })
    await expect(h.executor.execute(h.principal, command)).rejects.toMatchObject({ code: 'AI_CAPTURE_STALE' })
    expect(h.ledger).toHaveLength(1)
  })
  it('does not retry or rebase when the atomic commit loses its CAS', async () => {
    let calls = 0
    const h = harness(snapshot(), {}, { beforeCommit: ({ current }) => { calls++; return json([{ outcome: 'CONFLICT', workspace_id: 'ws-1', revision: 2, snapshot: current, receipt: {} }]) } }, [ready()])
    await expect(h.executor.execute(h.principal, command)).rejects.toMatchObject({ code: 'AI_CAPTURE_STALE' })
    expect(calls).toBe(1); expect(h.ledger).toHaveLength(0)
  })
  it('rejects mismatched stored observations and rolls back batches needing a decision', async () => {
    const tampered = ready(); tampered.observation.originalText = 'changed'
    let h = harness(snapshot(), {}, {}, [tampered])
    await expect(h.executor.execute(h.principal, command)).rejects.toMatchObject({ code: 'AI_CAPTURE_LEDGER_INVALID' })
    const row = ready(); row.observation.candidates.push({ ...row.observation.candidates[0], id: 'ai-capture:2', objectConfidence: 'low' })
    h = harness(snapshot(), {}, {}, [row])
    await expect(h.executor.execute(h.principal, command)).rejects.toMatchObject({ code: 'AI_CAPTURE_REVIEW_REQUIRED' })
    expect(h.ledger).toHaveLength(0); expect(h.state().current.data.actions).toHaveLength(2)
  })
})

import { createAiCapturePreviewHandler } from '../gateway/aiCapturePreviewHandler.js'
import { latestScheduleOccurrence } from '../src/scheduleNodes.js'

describe('bounded reschedule through real preview handler and authoritative confirmation', () => {
  async function prepareReschedule() {
    const initial = upgradeSnapshotToLatest(snapshot())
    initial.data.scheduleNodes = [{ id: 'trusted-interview-v1', occurrenceId: 'trusted-interview', opportunityId: 'opp-1', version: 1,
      kind: 'interview', state: 'scheduled', constraintKind: 'employer_hard', temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai',
        startAt: '2030-10-25T14:30:00+08:00', resolutionBasis: 'source_explicit' }, evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
      createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' }]
    const text = '请导入以下转发的面试通知。\n-----Forwarded message-----\nAlpha Role A 面试改期通知：原定2030年10月25日14:30，改为2030年10月26日15:30'
    const evidence = (quote: string) => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote })
    const rows: any[] = []
    const transport = vi.fn(async (_request, before) => {
      await before()
      return JSON.stringify({ statementMode: 'current_intent', interpretation: { contractVersion: 1, clarifications: [], candidates: [{
        kind: 'occurrence_rescheduled', occurrenceKind: 'interview', target: { company: 'Alpha', role: 'Role A' }, confidence: 'high', evidence: evidence(text),
        previousStartAt: '2030-10-25T14:30:00+08:00', previousTimeEvidence: evidence('2030年10月25日14:30'), newTimeEvidence: evidence('2030年10月26日15:30'),
        temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2030-10-26T15:30:00+08:00' },
      }] } })
    })
    const ledger = {
      read: async () => rows[0] ?? null,
      admit: async (value: any) => { rows.push({ user_id: value.userId, request_id: value.requestId, payload_hash: value.payloadHash, text: value.text,
        timezone: value.timezone, reference_time: value.referenceTime, expected_revision: value.expectedRevision,
        expires_at: new Date(Date.now() + 900_000).toISOString(), status: 'DISPATCHED', review: null, observation: null }) },
      finish: async (value: any) => { Object.assign(rows[0], { status: value.status, review: value.review, observation: value.observation }) },
    }
    const handler = createAiCapturePreviewHandler({ supabaseUrl: 'https://example.test', supabasePublishableKey: 'synthetic-key', allowedOrigins: ['https://app.example.test'],
      fetchImpl: async () => json({ id: 'user-a' }), authorizeIdentity: async () => ({ allowed: true }),
      readWorkspace: async () => ({ userId: 'user-a', workspaceId: 'ws-1', revision: 1, schemaVersion: initial.version, snapshot: initial }),
      now: () => new Date('2026-10-22T00:00:00Z'), runtime: { transport, ledger, beforeDispatch: async () => {}, reservationUnits: 1 } })
    const response = await handler(new Request('https://backend.example.test/api/workspace?surface=ai-capture-preview', {
      method: 'POST', headers: { origin: 'https://app.example.test', authorization: 'Bearer synthetic-token', 'content-type': 'application/json' },
      body: JSON.stringify({ text, timezone: 'Asia/Shanghai', requestId: 'ai-reschedule-review', expectedRevision: 1, contextRefs: ['opportunity:opp-1'] }) }))
    expect(response.status).toBe(200)
    expect((await response.json()).canCommit).toBe(true)
    expect(rows[0].observation.contextRefs).toEqual(['opportunity:opp-1'])
    expect(rows[0].observation.candidates[0].temporal.resolutionBasis).toBe('source_explicit')
    expect(rows[0].observation.source).not.toHaveProperty('assertedAt')
    expect(transport).toHaveBeenCalledOnce()
    expect(JSON.stringify(transport.mock.calls[0][0])).not.toContain('trusted-interview')
    return { initial, rows, command: { commandId: 'ai-reschedule-confirm', baseRevision: 1, command: { type: 'ai_capture_confirm', value: { requestId: 'ai-reschedule-review' } } } }
  }
  it('reschedules the existing occurrence, replays once, and restores it through authoritative Undo', async () => {
    const { initial, rows, command } = await prepareReschedule(), h = harness(initial, {}, {}, rows)
    expect(await h.executor.execute(h.principal, command)).toMatchObject({ outcome: 'COMMITTED', result: { status: 'APPLIED' } })
    expect(latestScheduleOccurrence(h.state().current.data.scheduleNodes!, 'trusted-interview')?.temporal.startAt).toBe('2030-10-26T15:30:00+08:00')
    expect(h.state().current.data.actions).toEqual(initial.data.actions)
    expect(h.state().current.data.processEvents).toEqual(initial.data.processEvents)
    expect(await h.executor.execute(h.principal, command)).toMatchObject({ outcome: 'ALREADY_APPLIED' })
    expect(h.ledger).toHaveLength(1)
    expect(await h.executor.undo(h.principal, { commandId: 'undo-ai-reschedule', targetCommandId: command.commandId })).toMatchObject({ outcome: 'COMMITTED' })
    expect(latestScheduleOccurrence(h.state().current.data.scheduleNodes!, 'trusted-interview')?.id).toBe('trusted-interview-v1')
  })
  it('fails a lost CAS once without rebasing or partial writes', async () => {
    const { initial, rows, command } = await prepareReschedule()
    let attempts = 0
    const h = harness(initial, {}, { beforeCommit: ({ current }) => { attempts++; return json([{ outcome: 'CONFLICT', workspace_id: 'ws-1', revision: 2, snapshot: current, receipt: {} }]) } }, rows)
    await expect(h.executor.execute(h.principal, command)).rejects.toMatchObject({ code: 'AI_CAPTURE_STALE' })
    expect(attempts).toBe(1); expect(h.ledger).toEqual([]); expect(h.state().current.data).toEqual(initial.data)
  })
})

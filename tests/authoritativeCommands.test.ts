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

function harness(initial = snapshot(), managementOptions: Pick<AuthoritativeCommandExecutorOptions, 'resolveBusinessManagementGrant'> = {}, hooks: { beforeCommit?: (state: { current: PJSDASSnapshot; revision: number }) => Response | undefined } = {}) {
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
    if (url.pathname === '/rest/v1/pjsdas_command_ledger') {
      const commandId = url.searchParams.get('command_id')?.replace(/^eq\./, '')
      const after = Number(url.searchParams.get('resulting_revision')?.replace(/^gt\./, '') ?? '-1')
      const rows = ledger.filter((item) =>
        (commandId ? item.command_id === commandId : true)
        && (Number.isFinite(after) ? item.resulting_revision > after : true))
      return json(rows)
    }
    if (url.pathname === '/rest/v1/rpc/pjsdas_commit_workspace_v2' || url.pathname === '/rest/v1/rpc/pjsdas_commit_management_workspace_v1') {
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
        title: 'Prepare a concise interview answer',
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
    expect(h.state().current.data.actions.some((item) => item.title === 'Prepare a concise interview answer')).toBe(true)
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
    commandId, kind: 'add_manual_action', title: 'Prepare interview', dueAt: '2026-10-02T10:00:00Z' } } })
  const delta = result.receipt!.projectionDelta as WorkspaceDelta
  const projected = applyWorkspaceDelta(before, delta)
  expect(h.state().current.data.scheduleNodes!.some(node => node.relatedActionIds.includes(projected.data.actions.find(action => action.title === 'Prepare interview')!.id))).toBe(true)
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
  const create = { commandId: 'managed-create-001', baseRevision: 1, command: { type: 'business_management', value: { operations: [{ kind: 'create_prep', value: { title: 'Synthetic preparation', estimatedMinutes: 30 } }] } } }
  it('commits with audit, projection delta and compensation, then safely undoes', async () => {
    const h = harness(snapshot(), granted)
    const result = await h.executor.execute(principal, create)
    expect(result).toMatchObject({ outcome: 'COMMITTED', revision: 2, result: { type: 'business_management', objects: [{ type: 'prep', id: 'managed:prep:managed-create-001:0' }] } })
    expect(h.ledger[0].compensation).toMatchObject({ operation: 'business_management_restore' })
    const retry = await h.executor.execute(principal, create)
    expect(retry.outcome).toBe('ALREADY_APPLIED')
    expect(h.ledger).toHaveLength(1)
    const undo = await h.executor.undo(principal, { commandId: 'managed-undo-001', targetCommandId: create.commandId })
    expect(undo.outcome).toBe('COMMITTED')
    expect(h.state().current.data.prep).toEqual([])
    expect(h.state().current.data.timeline?.some(item => item.commandId === create.commandId)).toBe(true)
  })
  it('cannot reuse a command id with changed content', async () => {
    const h = harness(snapshot(), granted)
    await h.executor.execute(principal, create)
    const changed = structuredClone(create)
    changed.command.value.operations[0].value.title = 'Changed request'
    await expect(h.executor.execute(principal, changed)).rejects.toThrow(/reused/)
    expect(h.ledger).toHaveLength(1)
  })
  it('rechecks authorization at the commit boundary after the initial check', async () => {
    let checks = 0
    const h = harness(snapshot(), { resolveBusinessManagementGrant: async () => ({ ...await granted.resolveBusinessManagementGrant(), revokedAt: ++checks > 1 ? '2026-10-02T00:00:00Z' : null }) })
    await expect(h.executor.execute(principal, create)).rejects.toThrow(/authorization/)
    expect(checks).toBe(2)
    expect(h.ledger).toHaveLength(0)
    expect(h.state().current.data.prep).toEqual([])
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
    expect(h.state().current.data.prep).toEqual([])
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
    expect(h.state().current.data.prep).toEqual([])
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
    expect(h.state().current.data.prep).toHaveLength(1)
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
    expect(h.state().current.data.prep).toHaveLength(1)
  })
  it('rechecks authorization immediately before undo commit', async () => {
    let revokeOnSecondCheck = false; let checks = 0
    const h = harness(snapshot(), { resolveBusinessManagementGrant: async () => ({ ...await granted.resolveBusinessManagementGrant(), revokedAt: revokeOnSecondCheck && ++checks > 1 ? '2026-10-02T00:00:00Z' : null }) })
    await h.executor.execute(principal, create)
    revokeOnSecondCheck = true; checks = 0
    await expect(h.executor.undo(principal, { commandId: 'managed-undo-001', targetCommandId: create.commandId })).rejects.toThrow(/authorization/)
    expect(checks).toBe(2)
    expect(h.ledger).toHaveLength(1)
    expect(h.state().current.data.prep).toHaveLength(1)
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
    await h.executor.execute(principal, { commandId: 'managed-update-002', baseRevision: 2, command: { type: 'business_management', value: { operations: [{ kind: 'update_prep', id: 'managed:prep:managed-create-001:0', patch: { title: 'Newer title' } }] } } })
    const result = await h.executor.undo(principal, { commandId: 'managed-undo-001', targetCommandId: create.commandId })
    expect(result.outcome).toBe('CONFLICT')
    expect(h.state().current.data.prep[0].title).toBe('Newer title')
    expect(h.ledger).toHaveLength(2)
  })
  it('rejects revoked management authorization for undo', async () => {
    let revoked = false
    const h = harness(snapshot(), { resolveBusinessManagementGrant: async () => ({ ...await granted.resolveBusinessManagementGrant(), revokedAt: revoked ? '2026-10-02T00:00:00Z' : null }) })
    await h.executor.execute(principal, create)
    revoked = true
    await expect(h.executor.undo(principal, { commandId: 'managed-undo-001', targetCommandId: create.commandId })).rejects.toThrow(/authorization/)
    expect(h.state().current.data.prep).toHaveLength(1)
    expect(h.ledger).toHaveLength(1)
  })
  it('rejects a later invalid batch item without commit or partial creation', async () => {
    const h = harness(snapshot(), granted)
    await expect(h.executor.execute(principal, { ...create, command: { type: 'business_management', value: { operations: [...create.command.value.operations, { kind: 'archive_prep', id: 'foreign-or-missing' }] } } })).rejects.toThrow(/not found/)
    expect(h.state().current.data.prep).toEqual([])
    expect(h.ledger).toHaveLength(0)
  })
})

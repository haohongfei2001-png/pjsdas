import { describe, expect, it } from 'vitest'
import {
  buildIngestionRunSummary,
  createIngestionLedgerTimeline,
  createIngestionRunTimeline,
  summarizeCoverage,
} from '../src/ingestion.js'
import { reconcileIngestionDebt } from '../src/ingestionResolution.js'
import type { Opportunity, ProcessRecord, TimelineRecord } from '../src/model.js'
import { createSnapshot } from '../src/snapshot.js'

const NOW = new Date('2026-09-26T12:00:00.000Z')
const SOURCE_ID = 'gmail:primary'

function opportunity(id: string, company = 'Example', role = 'AI Product Manager'): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: '筛选中',
    processStage: 'screening',
    roleType: 'core',
    early: false,
    opportunityValue: 80,
    fitScore: 75,
    locallyManaged: true,
    importedAt: '2026-08-01T00:00:00.000Z',
  }
}

function process(opportunityId: string, overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    id: `process:${opportunityId}`,
    opportunityId,
    company: 'Example',
    role: 'AI Product Manager',
    stage: 'screening',
    stageLabel: '筛选中',
    progress: 'waiting_result',
    result: 'pending',
    participationState: 'active',
    ...overrides,
  }
}

function unresolved(input: {
  sourceRecordId: string
  receivedAt?: string
  reason?: string
  opportunityId?: string
  company?: string
  role?: string
  fingerprint?: string
}) {
  return createIngestionLedgerTimeline({
    sourceKind: 'gmail',
    sourceId: SOURCE_ID,
    sourceRecordId: input.sourceRecordId,
    runId: `run:${input.sourceRecordId}`,
    recordType: 'recruiting_message',
    outcome: 'unresolved',
    fingerprint: input.fingerprint ?? `fp:${input.sourceRecordId}`,
    receivedAt: input.receivedAt ?? '2026-09-20T00:00:00.000Z',
    accountedAt: input.receivedAt ?? '2026-09-20T00:00:00.000Z',
    reason: input.reason,
    opportunityId: input.opportunityId,
    company: input.company,
    role: input.role,
  })
}

function zeroRun(completedAt = '2026-09-26T11:55:00.000Z') {
  const summary = buildIngestionRunSummary({
    runId: 'gmail:latest',
    sourceKind: 'gmail',
    sourceId: SOURCE_ID,
    producer: 'server_scheduler',
    startedAt: '2026-09-26T11:54:00.000Z',
    completedAt,
    records: [],
  })
  return createIngestionRunTimeline(summary)
}

function snapshot(input: {
  timeline: TimelineRecord[]
  opportunities?: Opportunity[]
  processes?: ProcessRecord[]
  actions?: any[]
  processEvents?: any[]
  semanticReceipts?: any[]
  decisionRequests?: any[]
}) {
  return createSnapshot({
    opportunities: input.opportunities ?? [],
    processes: input.processes ?? [],
    processEvents: input.processEvents ?? [],
    actions: input.actions ?? [],
    prep: [],
    applicationGroups: [],
    timeline: input.timeline,
    semanticReceipts: input.semanticReceipts ?? [],
    decisionRequests: input.decisionRequests ?? [],
  }, NOW.toISOString())
}

describe('R02 active unresolved reconciliation', () => {
  it('retains lifetime audit but clears active unresolved when a linked process is definitively terminal', () => {
    const record = unresolved({
      sourceRecordId: 'fragment-limit-old',
      receivedAt: '2026-08-10T00:00:00.000Z',
      reason: 'Message exceeds the 20-fragment interpretation limit.',
      opportunityId: 'opp-closed',
    })
    const base = snapshot({
      timeline: [record, zeroRun()],
      opportunities: [opportunity('opp-closed')],
      processes: [process('opp-closed', {
        stage: 'closed',
        stageLabel: '已结束',
        progress: 'completed',
        result: 'rejected',
      })],
    })

    const reconciled = reconcileIngestionDebt(base, NOW)
    expect(reconciled.appended).toHaveLength(1)
    expect(reconciled.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'historical_only',
      reason: 'linked_process_terminal',
      targetIngestionTimelineId: record.id,
    })

    const coverage = summarizeCoverage(reconciled.snapshot.data.timeline, { now: NOW })
    expect(coverage.lifetimeUnresolvedCount).toBe(1)
    expect(coverage.activeUnresolvedCount).toBe(0)
    expect(coverage.settledHistoricalUnresolvedCount).toBe(1)
    expect(coverage.allCaughtUp).toBe(true)
  })

  it('clears an old unresolved event when its linked action was completed later', () => {
    const record = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: SOURCE_ID,
      sourceRecordId: 'completed-event',
      runId: 'run:completed-event',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:completed-event',
      receivedAt: '2026-09-10T00:00:00.000Z',
      accountedAt: '2026-09-10T00:00:00.000Z',
      reason: '1 item(s) need a decision.',
      processEventId: 'event-1',
    })
    const base = snapshot({
      timeline: [record, zeroRun()],
      opportunities: [opportunity('opp-event')],
      processes: [process('opp-event')],
      processEvents: [{
        id: 'event-1',
        opportunityId: 'opp-event',
        company: 'Example',
        role: 'AI Product Manager',
        type: 'interview_invite',
        occurredAt: '2026-09-10T00:00:00.000Z',
        source: 'email',
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:00:00.000Z',
      }],
      actions: [{
        id: 'action-event-1',
        kind: 'follow_up',
        title: 'Interview follow-up',
        opportunityId: 'opp-event',
        processEventId: 'event-1',
        estimatedMinutes: 10,
        leverage: 1,
        delayCost: 1,
        status: 'done',
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-11T00:00:00.000Z',
      }],
    })
    const result = reconcileIngestionDebt(base, NOW)
    expect(result.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'resolved',
      reason: 'linked_action_settled',
    })
    expect(summarizeCoverage(result.snapshot.data.timeline, { now: NOW }).activeUnresolvedCount).toBe(0)
  })

  it('settles an old unresolved record when later Semantic Intake committed the same Gmail source record', () => {
    const record = unresolved({ sourceRecordId: 'semantic-later' })
    const base = snapshot({
      timeline: [record, zeroRun()],
      semanticReceipts: [{
        id: 'semantic-receipt:semantic-later',
        inputId: 'gmail:semantic-later:reconciliation-v1',
        sourceKind: 'gmail',
        sourceId: SOURCE_ID,
        sourceRecordId: 'semantic-later',
        sourceVersion: 'reconciliation-v1',
        status: 'committed',
        summary: 'Applied.',
        affectedObjects: [],
        decisionRequestIds: [],
        undoAvailable: false,
        createdAt: '2026-09-26T10:00:00.000Z',
        updatedAt: '2026-09-26T10:00:00.000Z',
      }],
    })
    const result = reconcileIngestionDebt(base, NOW)
    expect(result.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'resolved',
      reason: 'semantic_receipt_committed',
    })
  })

  it('keeps a same-company multi-role ambiguity active when no later durable evidence disambiguates it', () => {
    const record = unresolved({
      sourceRecordId: 'same-company-ambiguous',
      company: 'Example',
    })
    const base = snapshot({
      timeline: [record, zeroRun()],
      opportunities: [
        opportunity('opp-a', 'Example', 'AI Product Manager'),
        opportunity('opp-b', 'Example', 'Technical Product Manager'),
      ],
      processes: [process('opp-a'), process('opp-b')],
    })

    const result = reconcileIngestionDebt(base, NOW)
    expect(result.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'live_process_ambiguity',
    })
    const coverage = summarizeCoverage(result.snapshot.data.timeline, { now: NOW })
    expect(coverage.activeUnresolvedCount).toBe(1)
    expect(coverage.allCaughtUp).toBe(false)
  })

  it('classifies an explicitly non-actionable historical recruiting ad as ignored without deleting the ledger', () => {
    const record = unresolved({
      sourceRecordId: 'generic-ad',
      reason: 'Generic recruiting ad / marketing newsletter; no actionable business fact.',
    })
    const base = snapshot({ timeline: [record, zeroRun()] })
    const result = reconcileIngestionDebt(base, NOW)
    expect(result.snapshot.data.timeline.some((item) => item.id === record.id)).toBe(true)
    expect(result.appended[0]?.ingestionResolution?.outcome).toBe('ignored')
    expect(summarizeCoverage(result.snapshot.data.timeline, { now: NOW }).activeUnresolvedCount).toBe(0)
  })

  it('classifies a replayed source record with a later duplicate outcome without duplicating audit objects', () => {
    const first = unresolved({
      sourceRecordId: 'source-replay',
      receivedAt: '2026-09-20T00:00:00.000Z',
      fingerprint: 'fp:source-replay',
    })
    const later = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: SOURCE_ID,
      sourceRecordId: 'source-replay',
      runId: 'run:source-replay:later',
      recordType: 'recruiting_message',
      outcome: 'duplicate',
      fingerprint: 'fp:source-replay',
      receivedAt: '2026-09-20T00:00:00.000Z',
      accountedAt: '2026-09-25T00:00:00.000Z',
      reason: 'Already safely accounted.',
    })
    const base = snapshot({ timeline: [first, later, zeroRun()] })
    const reconciled = reconcileIngestionDebt(base, NOW)
    expect(reconciled.appended).toHaveLength(1)
    expect(reconciled.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'duplicate',
      reason: 'later_source_state',
      targetIngestionTimelineId: first.id,
    })
    const replay = reconcileIngestionDebt(reconciled.snapshot, new Date('2026-09-26T13:00:00.000Z'))
    expect(replay.changed).toBe(false)
    expect(replay.snapshot.data.timeline?.filter((item) =>
      item.ingestionResolution?.sourceRecordId === 'source-replay')).toHaveLength(1)
  })

  it('is idempotent for replayed reconciliation and never duplicates resolution objects', () => {
    const record = unresolved({
      sourceRecordId: 'stable-replay',
      reason: 'Generic recruiting ad / marketing newsletter; no actionable business fact.',
    })
    const first = reconcileIngestionDebt(snapshot({ timeline: [record, zeroRun()] }), NOW)
    const second = reconcileIngestionDebt(first.snapshot, new Date('2026-09-26T13:00:00.000Z'))
    expect(first.appended).toHaveLength(1)
    expect(second.changed).toBe(false)
    expect(second.appended).toHaveLength(0)
    expect(second.snapshot.data.timeline?.filter((item) => item.ingestionResolution)).toHaveLength(1)
  })

  it('allows healthy Coverage when only settled historical debt remains', () => {
    const record = unresolved({
      sourceRecordId: 'historical-settled',
      reason: 'Generic recruiting ad / marketing newsletter; no actionable business fact.',
    })
    const result = reconcileIngestionDebt(snapshot({ timeline: [record, zeroRun()] }), NOW)
    const coverage = summarizeCoverage(result.snapshot.data.timeline, { now: NOW })
    expect(coverage.lifetimeUnresolvedCount).toBe(1)
    expect(coverage.activeUnresolvedCount).toBe(0)
    expect(coverage.unresolvedCount).toBe(0)
    expect(coverage.allCaughtUp).toBe(true)
  })

  it('never clears an unlinked unresolved record merely because it is old', () => {
    const record = unresolved({
      sourceRecordId: 'old-but-ambiguous',
      receivedAt: '2026-01-01T00:00:00.000Z',
      reason: 'Ambiguous recruiting source record.',
    })
    const result = reconcileIngestionDebt(snapshot({ timeline: [record, zeroRun()] }), NOW)
    expect(result.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'unlinked_unresolved',
    })
    expect(summarizeCoverage(result.snapshot.data.timeline, { now: NOW }).allCaughtUp).toBe(false)
  })

  it('keeps unresolved input that still affects a live process active and blocking', () => {
    const record = unresolved({
      sourceRecordId: 'live-process',
      opportunityId: 'opp-live',
    })
    const base = snapshot({
      timeline: [record, zeroRun()],
      opportunities: [opportunity('opp-live')],
      processes: [process('opp-live')],
    })
    const result = reconcileIngestionDebt(base, NOW)
    const coverage = summarizeCoverage(result.snapshot.data.timeline, { now: NOW })
    expect(coverage.activeUnresolvedCount).toBe(1)
    expect(coverage.lifetimeUnresolvedCount).toBe(1)
    expect(coverage.allCaughtUp).toBe(false)
  })
})

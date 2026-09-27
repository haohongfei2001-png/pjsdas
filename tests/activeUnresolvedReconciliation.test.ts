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
  it('appends a new active resolution when canonical state returns to an earlier ambiguity', () => {
    const original = unresolved({ sourceRecordId: 'state-return', opportunityId: 'opp-return' })
    const base = snapshot({
      timeline: [original, zeroRun()],
      opportunities: [opportunity('opp-return')],
      processes: [process('opp-return')],
    })
    const initial = reconcileIngestionDebt(base, NOW)
    const terminal = structuredClone(initial.snapshot)
    terminal.data.processes[0] = process('opp-return', { stage: 'closed', result: 'rejected' })
    const settled = reconcileIngestionDebt(terminal, NOW)
    expect(summarizeCoverage(settled.snapshot.data.timeline, { now: NOW }).activeUnresolvedCount).toBe(0)

    const live = structuredClone(settled.snapshot)
    // A durable IndexedDB getAll() orders rows by primary key, not append order.
    live.data.timeline.sort((a, b) => a.id.localeCompare(b.id))
    live.data.processes[0] = process('opp-return')
    const returned = reconcileIngestionDebt(live, NOW)
    expect(returned.appended).toHaveLength(1)
    expect(returned.appended[0]?.ingestionResolution?.outcome).toBe('active_unresolved')
    expect(returned.appended[0]?.id).not.toBe(initial.appended[0]?.id)
    expect(summarizeCoverage(returned.snapshot.data.timeline, { now: NOW }).allCaughtUp).toBe(false)
    expect(returned.snapshot.data.timeline.filter((item) => item.ingestion)).toEqual([original])
    expect(reconcileIngestionDebt(returned.snapshot, NOW).changed).toBe(false)
  })

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

  it('keeps an older open semantic decision active even when a newer receipt committed', () => {
    const record = unresolved({ sourceRecordId: 'semantic-open-before-commit' })
    const decisionId = 'decision:semantic-open-before-commit'
    const base = snapshot({
      timeline: [record, zeroRun()],
      semanticReceipts: [
        {
          id: 'semantic-receipt:semantic-open-before-commit:v1',
          inputId: 'gmail:semantic-open-before-commit:v1',
          sourceKind: 'gmail',
          sourceId: SOURCE_ID,
          sourceRecordId: 'semantic-open-before-commit',
          sourceVersion: 'v1',
          status: 'decision_required',
          summary: 'Decision required.',
          affectedObjects: [{ type: 'decision_request', id: decisionId }],
          decisionRequestIds: [decisionId],
          undoAvailable: false,
          createdAt: '2026-09-25T10:00:00.000Z',
          updatedAt: '2026-09-25T10:00:00.000Z',
        },
        {
          id: 'semantic-receipt:semantic-open-before-commit:v2',
          inputId: 'gmail:semantic-open-before-commit:v2',
          sourceKind: 'gmail',
          sourceId: SOURCE_ID,
          sourceRecordId: 'semantic-open-before-commit',
          sourceVersion: 'v2',
          status: 'committed',
          summary: 'Applied a later bounded fact.',
          affectedObjects: [],
          decisionRequestIds: [],
          undoAvailable: false,
          createdAt: '2026-09-26T10:00:00.000Z',
          updatedAt: '2026-09-26T10:00:00.000Z',
        },
      ],
      decisionRequests: [{
        id: decisionId,
        reason: 'ambiguous_target',
        affectedObjects: [{ type: 'source', id: 'gmail:semantic-open-before-commit' }],
        question: 'Which target is correct?',
        choices: [
          { id: 'one', label: 'One', consequence: 'Use one target.' },
          { id: 'two', label: 'Two', consequence: 'Use another target.' },
        ],
        evidenceRefs: ['gmail:semantic-open-before-commit'],
        payloadBinding: {
          contractVersion: 1,
          inputId: 'gmail:semantic-open-before-commit:v1',
          candidateId: 'candidate:semantic-open-before-commit',
          source: {
            kind: 'gmail',
            sourceId: SOURCE_ID,
            sourceRecordId: 'semantic-open-before-commit',
            sourceVersion: 'v1',
            observedAt: '2026-09-25T10:00:00.000Z',
            timezone: 'Asia/Shanghai',
          },
          statementMode: 'assertion',
          candidate: {
            id: 'candidate:semantic-open-before-commit',
            kind: 'application_submitted',
            target: { company: 'Example' },
            objectConfidence: 'low',
            eventConfidence: 'high',
            evidenceRefs: ['gmail:semantic-open-before-commit'],
            sourceVersionRefs: ['semantic-open-before-commit:v1'],
          },
        },
        state: 'open',
        createdAt: '2026-09-25T10:00:00.000Z',
        updatedAt: '2026-09-25T10:00:00.000Z',
      }],
    })
    const result = reconcileIngestionDebt(base, NOW)
    expect(result.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'semantic_decision_open',
    })
  })

  it.each([false, true])('keeps same-company multi-role ambiguity active even if candidates are terminal: %s', (terminal) => {
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
      processes: [process('opp-a', terminal ? { stage: 'closed', result: 'rejected' } : {}), process('opp-b', terminal ? { stage: 'closed', result: 'rejected' } : {})],
    })

    const result = reconcileIngestionDebt(base, NOW)
    expect(result.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'unlinked_unresolved',
    })
    const coverage = summarizeCoverage(result.snapshot.data.timeline, { now: NOW })
    expect(coverage.activeUnresolvedCount).toBe(1)
    expect(coverage.allCaughtUp).toBe(false)
  })

  it('settles a legacy Gmail link-only capability boundary without deleting the original unresolved ledger', () => {
    const record = unresolved({
      sourceRecordId: 'legacy-link-only',
      reason: 'Linked pages are NOT_SUPPORTED; no link is opened or treated as verified source content.',
    })
    const base = snapshot({ timeline: [record, zeroRun()] })
    const result = reconcileIngestionDebt(base, NOW)
    expect(result.snapshot.data.timeline.some((item) => item.id === record.id)).toBe(true)
    expect(result.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'historical_only',
      reason: 'legacy_capability_boundary_only',
      targetIngestionTimelineId: record.id,
    })
    const coverage = summarizeCoverage(result.snapshot.data.timeline, { now: NOW })
    expect(coverage.lifetimeUnresolvedCount).toBe(1)
    expect(coverage.activeUnresolvedCount).toBe(0)
  })

  it('settles a legacy Gmail attachment+link capability boundary only when no stronger unresolved signal exists', () => {
    const record = unresolved({
      sourceRecordId: 'legacy-attachment-link-only',
      reason: 'Attachment content is NOT_SUPPORTED; inspect the original mail if it contains material details. Linked pages are NOT_SUPPORTED; no link is opened or treated as verified source content.',
    })
    const result = reconcileIngestionDebt(snapshot({ timeline: [record, zeroRun()] }), NOW)
    expect(result.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'historical_only',
      reason: 'legacy_capability_boundary_only',
    })
  })

  it('does not clear Gmail link records that also contain a genuine quoted-context ambiguity', () => {
    const record = unresolved({
      sourceRecordId: 'legacy-link-plus-ambiguity',
      reason: 'Linked pages are NOT_SUPPORTED; no link is opened or treated as verified source content. Quoted/forwarded context requires clarification; no facts were inferred automatically.',
    })
    const result = reconcileIngestionDebt(snapshot({ timeline: [record, zeroRun()] }), NOW)
    expect(result.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'unlinked_unresolved',
    })
    expect(summarizeCoverage(result.snapshot.data.timeline, { now: NOW }).activeUnresolvedCount).toBe(1)
  })

  it('does not let legacy capability text clear a source record already linked to a live opportunity', () => {
    const record = unresolved({
      sourceRecordId: 'legacy-link-live',
      reason: 'Linked pages are NOT_SUPPORTED; no link is opened or treated as verified source content.',
      opportunityId: 'opp-live-capability',
    })
    const base = snapshot({
      timeline: [record, zeroRun()],
      opportunities: [opportunity('opp-live-capability')],
      processes: [process('opp-live-capability')],
    })
    const result = reconcileIngestionDebt(base, NOW)
    expect(result.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'live_process_ambiguity',
    })
  })

  it('does not clear capability-only text when a current issueKind still marks an interpretation failure', () => {
    const record = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: SOURCE_ID,
      sourceRecordId: 'legacy-link-with-issue-kind',
      runId: 'run:legacy-link-with-issue-kind',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:legacy-link-with-issue-kind',
      receivedAt: '2026-09-20T00:00:00.000Z',
      accountedAt: '2026-09-20T00:00:00.000Z',
      reason: 'Linked pages are NOT_SUPPORTED; no link is opened or treated as verified source content.',
      issueKinds: ['interpretation_failure'],
    })
    const result = reconcileIngestionDebt(snapshot({ timeline: [record, zeroRun()] }), NOW)
    expect(result.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'unlinked_unresolved',
    })
  })

  it('keeps an open semantic decision active even when the legacy reason is capability-only text', () => {
    const record = unresolved({
      sourceRecordId: 'legacy-link-semantic-open',
      reason: 'Linked pages are NOT_SUPPORTED; no link is opened or treated as verified source content.',
    })
    const base = snapshot({
      timeline: [record, zeroRun()],
      semanticReceipts: [{
        id: 'semantic-receipt:legacy-link-semantic-open',
        inputId: 'gmail:legacy-link-semantic-open:reconciliation-v1',
        sourceKind: 'gmail',
        sourceId: SOURCE_ID,
        sourceRecordId: 'legacy-link-semantic-open',
        sourceVersion: 'reconciliation-v1',
        status: 'decision_required',
        summary: 'Decision required.',
        affectedObjects: [{ type: 'decision_request', id: 'decision:legacy-link-semantic-open' }],
        decisionRequestIds: ['decision:legacy-link-semantic-open'],
        undoAvailable: false,
        createdAt: '2026-09-25T10:00:00.000Z',
        updatedAt: '2026-09-25T10:00:00.000Z',
      }],
      decisionRequests: [{
        id: 'decision:legacy-link-semantic-open',
        reason: 'ambiguous_target',
        affectedObjects: [{ type: 'source', id: 'gmail:legacy-link-semantic-open' }],
        question: 'Which target is correct?',
        choices: [
          { id: 'one', label: 'One', consequence: 'Use one target.' },
          { id: 'two', label: 'Two', consequence: 'Use another target.' },
        ],
        evidenceRefs: ['gmail:legacy-link-semantic-open'],
        payloadBinding: {
          contractVersion: 1,
          inputId: 'gmail:legacy-link-semantic-open:reconciliation-v1',
          candidateId: 'candidate:legacy-link-semantic-open',
          source: {
            kind: 'gmail',
            sourceId: SOURCE_ID,
            sourceRecordId: 'legacy-link-semantic-open',
            sourceVersion: 'reconciliation-v1',
            observedAt: '2026-09-25T10:00:00.000Z',
            timezone: 'Asia/Shanghai',
          },
          statementMode: 'assertion',
          candidate: {
            id: 'candidate:legacy-link-semantic-open',
            kind: 'application_submitted',
            target: { company: 'Example' },
            objectConfidence: 'low',
            eventConfidence: 'high',
            evidenceRefs: ['gmail:legacy-link-semantic-open'],
            sourceVersionRefs: ['legacy-link-semantic-open:reconciliation-v1'],
          },
        },
        state: 'open',
        createdAt: '2026-09-25T10:00:00.000Z',
        updatedAt: '2026-09-25T10:00:00.000Z',
      }],
    })
    const result = reconcileIngestionDebt(base, NOW)
    expect(result.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'semantic_decision_open',
    })
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

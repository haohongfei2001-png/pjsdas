import { describe, expect, it } from 'vitest'
import { createGmailFragmentReprocessWriteHandler, planFragmentReprocessWrite } from '../gateway/gmailFragmentReprocessWriteHandler.js'
import { fragmentLimitReprocessTargetIds } from '../gateway/gmailFragmentReprocessDryRunHandler.js'
import { createIngestionLedgerTimeline } from '../src/ingestion.js'
import { createSnapshot, upgradeSnapshotToLatest, validateSnapshot } from '../src/snapshot.js'
import type { GmailSemanticRecord } from '../src/gmailSemanticIntake.js'
import type { TimelineRecord } from '../src/model.js'

const checkedAt = '2026-09-28T00:00:00.000Z'

function legacyTarget(id: string) {
  const ingestion = createIngestionLedgerTimeline({
    sourceKind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: id,
    runId: `legacy:${id}`, recordType: 'recruiting_message', outcome: 'unresolved',
    fingerprint: `fp:${id}`, receivedAt: '2026-09-25T00:00:00.000Z',
    accountedAt: '2026-09-25T00:00:00.000Z',
    reason: 'Message exceeds the 20-fragment interpretation limit.',
  })
  const resolution: TimelineRecord = {
    id: `resolution:${id}`, kind: 'ingestion_resolution_recorded', category: 'data', source: 'system',
    occurredAt: '2026-09-27T00:00:00.000Z', recordedAt: '2026-09-27T00:00:00.000Z',
    title: 'Legacy active debt',
    ingestionResolution: {
      version: 1, sourceKind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: id,
      targetIngestionTimelineId: ingestion.id, targetFingerprint: ingestion.ingestion!.fingerprint,
      outcome: 'active_unresolved', reason: 'unlinked_unresolved', evidenceRefs: [ingestion.id],
      reconciledAt: '2026-09-27T00:00:00.000Z',
    },
  }
  return [ingestion, resolution]
}

function record(id: string, gaps: string[] = []): GmailSemanticRecord {
  return {
    receivedAt: '2026-09-25T00:00:00.000Z', gaps,
    observation: {
      contractVersion: 1, inputId: `gmail:${id}:fragment-reprocess-v2`,
      source: {
        kind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: id,
        sourceVersion: 'fragment-reprocess-v2', observedAt: checkedAt,
        assertedAt: checkedAt, timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion', candidates: [],
    },
  }
}

describe('Gmail fragment settlement write', () => {
  it('commits only fully parsed, conclusively settled targets and preserves historical ledger rows', () => {
    const original = createSnapshot({
      opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
      timeline: [...legacyTarget('complete'), ...legacyTarget('gap'), ...legacyTarget('action'), ...legacyTarget('decision')],
    }, '2026-09-27T00:00:00.000Z')
    const originalIds = original.data.timeline.map((item) => item.id)
    const targets = fragmentLimitReprocessTargetIds(original)
    expect(targets).toEqual(['action', 'complete', 'decision', 'gap'])
    const action = record('action')
    action.observation.candidates = [{
      id: 'manual-action', kind: 'manual_action', title: 'Follow up with recruiter',
      objectConfidence: 'high', eventConfidence: 'high',
      evidenceRefs: ['fragment-reprocess'], sourceVersionRefs: ['action:fragment-reprocess-v2'],
    }]
    const decision = record('decision')
    decision.observation.candidates = [{
      id: 'uncertain-action', kind: 'manual_action', title: 'Unclear recruiter request',
      objectConfidence: 'low', eventConfidence: 'low',
      evidenceRefs: ['fragment-reprocess'], sourceVersionRefs: ['decision:fragment-reprocess-v2'],
    }]
    const plan = planFragmentReprocessWrite(original, [record('complete'), record('gap', ['parser gap']), action, decision], {
      checkedAt, workspaceVersion: 'txn:770', targetIds: targets,
    })
    expect(plan.selectedIds).toEqual(['action', 'complete'])
    expect(plan.snapshot.data.actions).toHaveLength(1)
    expect(plan.compensation?.payload.domainCompensations).toHaveLength(1)
    expect(plan.snapshot.data.decisionRequests).toHaveLength(0)
    expect(plan.snapshot.data.timeline.map((item) => item.id)).toEqual(expect.arrayContaining(originalIds))
    const persisted = upgradeSnapshotToLatest(createSnapshot(plan.snapshot.data, plan.snapshot.exportedAt))
    expect(fragmentLimitReprocessTargetIds(persisted)).toEqual(['decision', 'gap'])
    expect(persisted.data.timeline.some((item) => item.ingestion?.sourceRecordId === 'gap'
      && item.ingestion.runId.startsWith('gmail:fragment-reprocess-write:'))).toBe(false)
    validateSnapshot(persisted)
  })

  it('requires an explicit write route and exact projection before external access', async () => {
    const handler = createGmailFragmentReprocessWriteHandler({
      supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'publishable',
      supabaseServiceRoleKey: 'service-role', tokenEncryptionKey: 'token-key',
      googleClientId: 'client', googleClientSecret: 'secret',
      fetchImpl: async () => { throw new Error('External access must not occur.') },
    })
    const url = 'https://example.invalid/api/automation-gmail?__pjsdas_gmail_route=fragment_reprocess_write'
    const headers = { authorization: 'Bearer worker', 'content-type': 'application/json' }
    expect((await handler(new Request(url, { method: 'POST', headers, body: '{}' }))).status).toBe(409)
    expect((await handler(new Request(`${url}&write=1`, { method: 'POST', headers, body: '{}' }))).status).toBe(400)
    expect((await handler(new Request(`${url}&write=1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 770, expectedProjectedSettledCount: 39 }),
    }))).status).toBe(401)
  })
})

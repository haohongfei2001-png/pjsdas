import { describe, expect, it } from 'vitest'
import { fragmentLimitReprocessTargetIds, createGmailFragmentReprocessDryRunHandler } from '../gateway/gmailFragmentReprocessDryRunHandler.js'
import { createIngestionLedgerTimeline } from '../src/ingestion.js'
import { createSnapshot } from '../src/snapshot.js'
import type { TimelineRecord } from '../src/model.js'

function resolution(target: TimelineRecord, reason: 'unlinked_unresolved' | 'semantic_decision_open' = 'unlinked_unresolved'): TimelineRecord {
  return {
    id: `resolution:${target.id}`,
    kind: 'ingestion_resolution_recorded',
    category: 'data',
    source: 'system',
    occurredAt: target.occurredAt,
    recordedAt: '2026-09-27T00:00:00.000Z',
    title: 'resolution',
    ingestionResolution: {
      version: 1,
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: target.ingestion!.sourceRecordId,
      targetIngestionTimelineId: target.id,
      targetFingerprint: target.ingestion!.fingerprint,
      outcome: 'active_unresolved',
      reason,
      evidenceRefs: [target.id],
      reconciledAt: '2026-09-27T00:00:00.000Z',
    },
  }
}

function fragmentRecord(id: string, reason = 'Message exceeds the 20-fragment interpretation limit.') {
  return createIngestionLedgerTimeline({
    sourceKind: 'gmail',
    sourceId: 'gmail:primary',
    sourceRecordId: id,
    runId: `run:${id}`,
    recordType: 'recruiting_message',
    outcome: 'unresolved',
    fingerprint: `fp:${id}`,
    receivedAt: '2026-09-25T00:00:00.000Z',
    accountedAt: '2026-09-25T00:00:00.000Z',
    reason,
  })
}

describe('Gmail fragment-limit reprocess dry-run', () => {
  it('targets only current unlinked active Gmail records with the legacy 20-fragment gap', () => {
    const a = fragmentRecord('fragment-a')
    const b = fragmentRecord('fragment-b')
    const c = fragmentRecord('other', 'Other unresolved reason.')
    const snapshot = createSnapshot({
      opportunities: [],
      processes: [],
      processEvents: [],
      actions: [],
      prep: [],
      applicationGroups: [],
      timeline: [
        a, b, c,
        resolution(a),
        resolution(b, 'semantic_decision_open'),
        resolution(c),
      ],
    }, '2026-09-27T00:00:00.000Z')
    expect(fragmentLimitReprocessTargetIds(snapshot)).toEqual(['fragment-a'])
  })

  it('refuses any non-dry-run invocation before touching external state', async () => {
    const handler = createGmailFragmentReprocessDryRunHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      supabaseServiceRoleKey: 'service-role',
      tokenEncryptionKey: 'token-key',
      googleClientId: 'client',
      googleClientSecret: 'secret',
    })
    const response = await handler(new Request(
      'https://example.invalid/api/automation-gmail?__pjsdas_gmail_route=fragment_reprocess_dry_run',
      { headers: { authorization: 'Bearer worker' } },
    ))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'DRY_RUN_REQUIRED' })
  })
})

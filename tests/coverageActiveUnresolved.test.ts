import { describe, expect, it } from 'vitest'
import { invokeCoverageStatus } from '../gateway/coverageTool.js'
import {
  buildIngestionRunSummary,
  createIngestionLedgerTimeline,
  createIngestionRunTimeline,
  PJSDAS_EXPECTED_INGESTION_SOURCES,
} from '../src/ingestion.js'
import { reconcileIngestionDebt } from '../src/ingestionResolution.js'
import { createSnapshot } from '../src/snapshot.js'
import type { WorkspaceSource } from '../gateway/workspaceSource.js'

function snapshot() {
  const unresolved = createIngestionLedgerTimeline({
    sourceKind: 'gmail',
    sourceId: 'gmail:primary',
    sourceRecordId: 'historical-ad',
    runId: 'legacy-run',
    recordType: 'recruiting_message',
    outcome: 'unresolved',
    fingerprint: 'fp:historical-ad',
    receivedAt: '2026-08-01T00:00:00.000Z',
    accountedAt: '2026-08-01T00:00:00.000Z',
    reason: 'Generic recruiting ad / marketing newsletter; no actionable business fact.',
  })
  const runs = PJSDAS_EXPECTED_INGESTION_SOURCES.map((source) =>
    createIngestionRunTimeline(buildIngestionRunSummary({
      runId: `${source.sourceId}:latest`,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      producer: 'server_scheduler',
      startedAt: '2026-09-26T11:54:00.000Z',
      completedAt: '2026-09-26T11:55:00.000Z',
      records: [],
      sourcePolicy: {
        version: 1,
        enabled: true,
        cadenceMinutes: source.cadenceMinutes ?? 10,
        freshnessSlaMinutes: source.freshnessSlaMinutes ?? 20,
        label: source.label,
      },
    })),
  )
  return reconcileIngestionDebt(createSnapshot({
    opportunities: [],
    processes: [],
    processEvents: [],
    actions: [],
    prep: [],
    applicationGroups: [],
    timeline: [unresolved, ...runs],
  }, '2026-09-26T12:00:00.000Z'), new Date('2026-09-26T12:00:00.000Z')).snapshot
}

describe('get_coverage_status active/lifetime unresolved contract', () => {
  it('reports lifetime audit separately and does not let settled historical debt block green status', async () => {
    const snap = snapshot()
    const source: WorkspaceSource = {
      async read() {
        return {
          snapshot: snap,
          context: {
            workspaceVersion: 'txn:9',
            now: new Date('2026-09-26T12:00:00.000Z'),
          },
        }
      },
    }
    const result = await invokeCoverageStatus(source)
    expect(result.isError).not.toBe(true)
    const structured = result.structuredContent as any
    expect(structured.coverage).toMatchObject({
      allCaughtUp: true,
      unresolvedCount: 0,
      activeUnresolvedCount: 0,
      lifetimeUnresolvedCount: 1,
      settledHistoricalUnresolvedCount: 1,
    })
    expect(structured.assurance).toContain('0 active unresolved')
    expect(structured.assurance).toContain('Lifetime audit retains 1')
  })
})

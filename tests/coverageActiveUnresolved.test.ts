import { describe, expect, it } from 'vitest'
import { invokeCoverageStatus } from '../gateway/coverageTool.js'
import {
  buildIngestionRunSummary,
  createIngestionLedgerTimeline,
  createIngestionRunTimeline,
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
  const run = createIngestionRunTimeline(buildIngestionRunSummary({
    runId: 'gmail:latest',
    sourceKind: 'gmail',
    sourceId: 'gmail:primary',
    producer: 'server_scheduler',
    startedAt: '2026-09-26T11:54:00.000Z',
    completedAt: '2026-09-26T11:55:00.000Z',
    records: [],
    sourcePolicy: {
      enabled: true,
      cadenceMinutes: 10,
      freshnessSlaMinutes: 20,
      label: 'Gmail',
      policySource: 'run',
    },
  }))
  return reconcileIngestionDebt(createSnapshot({
    opportunities: [],
    processes: [],
    processEvents: [],
    actions: [],
    prep: [],
    applicationGroups: [],
    timeline: [unresolved, run],
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

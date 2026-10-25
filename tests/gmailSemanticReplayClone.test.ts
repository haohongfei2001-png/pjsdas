import { describe, expect, it, vi } from 'vitest'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import { createSnapshot } from '../src/snapshot.js'
const at = '2026-10-25T00:00:00.000Z'
const snapshot = () => createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [{ id: 'synthetic-history', kind: 'baseline_backfill', category: 'data', source: 'system', occurredAt: at, recordedAt: at, title: 'Synthetic retained history', detail: 'Synthetic '.repeat(1000) }] }, at)
const input = { runId: 'synthetic-run', sourceId: 'gmail:primary', checkedAt: at, records: [], authorized: true }
describe('Gmail same-run replay avoids discarded snapshot work', () => {
  it('returns original snapshot and prior run without cloning', () => {
    const first = applyGmailSemanticBatch(snapshot(), input), spy = vi.spyOn(globalThis, 'structuredClone')
    try {
      const replay = applyGmailSemanticBatch(first.snapshot, input)
      expect(replay).toMatchObject({ alreadyApplied: true, compensation: { operation: 'semantic_batch', payload: { domainCompensations: [], decisionRequestIds: [], receiptIds: [] } } })
      expect(replay.snapshot).toBe(first.snapshot); expect(replay.run).toBe(first.run)
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
  it('still checks authorization before replay, without cloning or mutating input', () => {
    const first = applyGmailSemanticBatch(snapshot(), input), before = structuredClone(first.snapshot), spy = vi.spyOn(globalThis, 'structuredClone')
    try { expect(() => applyGmailSemanticBatch(first.snapshot, { ...input, authorized: false })).toThrow('not authorized'); expect(spy).not.toHaveBeenCalled(); expect(first.snapshot).toEqual(before) }
    finally { spy.mockRestore() }
  })
  it('keeps non-replay output deeply isolated and empty-run audit unchanged', () => {
    const base = snapshot(), before = structuredClone(base), result = applyGmailSemanticBatch(base, input)
    expect(result.alreadyApplied).toBe(false); expect(result.snapshot.data.timeline).toHaveLength(2)
    expect(result.snapshot.data.timeline![0]).not.toBe(base.data.timeline![0])
    result.snapshot.data.timeline![0].title = 'Changed output only'
    expect(base).toEqual(before)
  })
  it('a later invalid record cannot expose earlier partial work to the caller', () => {
    const base = snapshot(), before = structuredClone(base)
    const record = (id: string) => ({ receivedAt: at, gaps: [], observation: { contractVersion: 1 as const, inputId: id, source: { kind: 'gmail' as const, sourceId: 'gmail:primary', sourceRecordId: id, observedAt: at, timezone: 'UTC' }, statementMode: 'assertion' as const, candidates: [] } })
    const bad = record('second'); bad.observation.inputId = ''
    expect(() => applyGmailSemanticBatch(base, { ...input, records: [record('first'), bad] })).toThrow('inputId')
    expect(base).toEqual(before)
  })
})

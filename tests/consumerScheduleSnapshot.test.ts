import { describe, expect, it } from 'vitest'
import { todayScheduleSnapshot, patchConsumerSnapshot } from '../src/today/consumerScheduleSnapshot.js'
import { instantDenseWorkspace, INSTANT_NOW } from './fixtures/instantDenseWorkspace.js'
import type { TimelineRecord } from '../src/model.js'

describe('incremental Today completion evidence', () => {
  it('keeps full audit intact and updates the current day by record delta', () => {
    const snapshot = instantDenseWorkspace()
    const old = snapshot.data.timeline![0]
    const cold = todayScheduleSnapshot(snapshot, INSTANT_NOW, 'Asia/Shanghai')
    expect(cold.data.timeline!.length).toBeLessThan(snapshot.data.timeline!.length)
    const fact: TimelineRecord = { ...old, id: 'current-completion', occurredAt: INSTANT_NOW.toISOString(), recordedAt: INSTANT_NOW.toISOString() }
    const next = patchConsumerSnapshot(snapshot, { contract: 'delta-v1', baseRevision: 1204, changes: [{ collection: 'timeline', id: fact.id, before: null, after: fact as any }] })
    const warm = todayScheduleSnapshot(next, INSTANT_NOW, 'Asia/Shanghai')
    expect(warm.data.timeline).toContainEqual(fact)
    expect(snapshot.data.timeline).toHaveLength(3940)
    expect(next.data.timeline).toHaveLength(3941)
    const removed = patchConsumerSnapshot(next, { contract: 'delta-v1', baseRevision: 1205, changes: [{ collection: 'timeline', id: fact.id, before: fact as any, after: null }] })
    expect(todayScheduleSnapshot(removed, INSTANT_NOW, 'Asia/Shanghai').data.timeline).not.toContainEqual(fact)
  })
  it('respects browser day boundaries and a historical row moved into today', () => {
    const snapshot = instantDenseWorkspace()
    const row = { ...snapshot.data.timeline![0], occurredAt: '2026-09-30T23:30:00Z' }
    snapshot.data.timeline = [row]
    expect(todayScheduleSnapshot(snapshot, INSTANT_NOW, 'Asia/Shanghai').data.timeline).toHaveLength(1)
    expect(todayScheduleSnapshot(snapshot, INSTANT_NOW, 'UTC').data.timeline).toHaveLength(0)
    const next = patchConsumerSnapshot(snapshot, { contract: 'delta-v1', baseRevision: 1, changes: [{ collection: 'timeline', id: row.id, before: { id: row.id, occurredAt: row.occurredAt }, after: { id: row.id, occurredAt: INSTANT_NOW.toISOString() } }] })
    expect(todayScheduleSnapshot(next, INSTANT_NOW, 'UTC').data.timeline?.[0].occurredAt).toBe(INSTANT_NOW.toISOString())
    expect(next.data.timeline?.[0].title).toBe(row.title)
  })
})

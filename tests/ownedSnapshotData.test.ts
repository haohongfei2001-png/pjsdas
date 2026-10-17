import { describe, expect, it, vi } from 'vitest'
import { createSnapshot, createSnapshotFromOwnedData } from '../src/snapshot.js'
import { instantDenseWorkspace } from './fixtures/instantDenseWorkspace.js'

const now = '2026-10-01T01:00:00.000Z'
describe('owned snapshot normalization', () => {
  it.each([0, 100, 3940])('matches the defensive-copy API with %i historical rows', count => {
    const data = instantDenseWorkspace(count).data
    const expected = createSnapshot(data, now)
    const owned = structuredClone(data)
    const actual = createSnapshotFromOwnedData(owned, now)
    expect(actual).toEqual(expected)
    expect(actual.data).toBe(owned)
    expect(actual.data.timeline).toBe(owned.timeline)
    expect(actual.data.timeline).toHaveLength(count)
  })

  it('keeps the existing public API detached from all caller-owned nested data', () => {
    const data = instantDenseWorkspace(2).data
    const original = structuredClone(data)
    const result = createSnapshot(data, now)
    expect(data).toEqual(original)
    expect(result.data).not.toBe(data)
    result.data.actions[0].title = 'different title'
    result.data.timeline![0].detail = 'different historical evidence'
    expect(data).toEqual(original)
  })

  it('performs the same legacy schedule and optional-array normalization', () => {
    const data = instantDenseWorkspace(2).data
    delete data.scheduleNodes
    delete data.decisionRequests
    delete data.semanticReceipts
    delete data.reminderIntents
    delete data.reminderOutbox
    const expected = createSnapshot(data, now)
    expect(createSnapshotFromOwnedData(structuredClone(data), now)).toEqual(expected)
    expect(expected.data.scheduleNodes!.length).toBeGreaterThan(0)
  })

  it('does not clone the full owned history again', () => {
    const owned = instantDenseWorkspace(3940).data
    const clone = vi.spyOn(globalThis, 'structuredClone')
    try {
      createSnapshotFromOwnedData(owned, now)
      expect(clone.mock.calls.some(([value]) => value === owned || value === owned.timeline)).toBe(false)
    } finally { clone.mockRestore() }
  })

  it('retains validation failures for corrupt historical evidence', () => {
    const data = instantDenseWorkspace(2).data
    data.timeline![1].recordedAt = 'not a timestamp'
    let expected: unknown
    try { createSnapshot(data, now) } catch (error) { expected = error }
    expect(expected).toBeInstanceOf(Error)
    expect(() => createSnapshotFromOwnedData(structuredClone(data), now)).toThrow((expected as Error).message)
  })
})

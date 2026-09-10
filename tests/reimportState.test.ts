import { describe, expect, it } from 'vitest'
import { mergeActionsForReimport } from '../src/reimportState'
import type { Action } from '../src/model'

function action(id: string, overrides: Partial<Action> = {}): Action {
  return {
    id,
    kind: 'apply',
    title: id,
    opportunityId: 'OPP-001',
    estimatedMinutes: 30,
    leverage: 80,
    delayCost: 80,
    status: 'todo',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('spreadsheet re-import action state', () => {
  it('preserves stable completion/skip state and local Process Event actions', () => {
    const previous = [
      action('apply:stable', {
        status: 'done',
        updatedAt: '2026-09-09T08:00:00.000Z',
      }),
      action('apply:removed', { status: 'skipped' }),
      action('event-action:evt-1', {
        kind: 'manual',
        processEventId: 'evt-1',
        processStage: 'assessment',
        timingMode: 'deadline',
        dueAt: '2026-09-12T15:59:00.000Z',
        status: 'doing',
      }),
    ]

    const nextImport = [
      action('apply:stable', {
        title: 'updated workbook title',
        status: 'todo',
        updatedAt: '2026-09-10T10:00:00.000Z',
      }),
      action('apply:new'),
    ]

    const merged = mergeActionsForReimport(nextImport, previous)
    const byId = new Map(merged.map((item) => [item.id, item]))

    expect(merged.map((item) => item.id)).toEqual([
      'apply:stable',
      'apply:new',
      'event-action:evt-1',
    ])
    expect(byId.get('apply:stable')?.title).toBe('updated workbook title')
    expect(byId.get('apply:stable')?.status).toBe('done')
    expect(byId.get('apply:stable')?.updatedAt).toBe('2026-09-09T08:00:00.000Z')
    expect(byId.get('apply:new')?.status).toBe('todo')
    expect(byId.get('event-action:evt-1')?.status).toBe('doing')
    expect(byId.has('apply:removed')).toBe(false)
  })
})

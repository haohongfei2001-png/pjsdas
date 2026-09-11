import { describe, expect, it } from 'vitest'
import { mergeActionsForReimport } from '../src/reimportState.js'
import type { Action } from '../src/model.js'

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

  it('keeps browser-side actions authoritative for locally managed opportunities', () => {
    const previous = [
      action('apply:local', {
        opportunityId: 'LOCAL-1',
        title: '本地已处理的岗位',
        status: 'done',
        sourceLabel: '自然语言更新',
      }),
      action('progress-action:plan', {
        kind: 'manual',
        opportunityId: undefined,
        title: '本地安排',
        sourceLabel: '自然语言更新',
      }),
      action('apply:normal-old', { opportunityId: 'NORMAL-1', status: 'done' }),
    ]

    const nextImport = [
      action('apply:local', {
        opportunityId: 'LOCAL-1',
        title: '旧 Excel 又要求投递',
        status: 'todo',
      }),
      action('follow-up:local', {
        kind: 'follow_up',
        opportunityId: 'LOCAL-1',
        title: '旧 Excel 复核动作',
      }),
      action('apply:normal-old', {
        opportunityId: 'NORMAL-1',
        title: '正常岗位的新 Excel 标题',
        status: 'todo',
      }),
      action('apply:normal-new', { opportunityId: 'NORMAL-2' }),
    ]

    const merged = mergeActionsForReimport(nextImport, previous, new Set(['LOCAL-1']))
    const byId = new Map(merged.map((item) => [item.id, item]))

    expect(byId.get('apply:local')?.title).toBe('本地已处理的岗位')
    expect(byId.get('apply:local')?.status).toBe('done')
    expect(byId.has('follow-up:local')).toBe(false)
    expect(byId.get('progress-action:plan')?.title).toBe('本地安排')
    expect(byId.get('apply:normal-old')?.title).toBe('正常岗位的新 Excel 标题')
    expect(byId.get('apply:normal-old')?.status).toBe('done')
    expect(byId.has('apply:normal-new')).toBe(true)
  })
})

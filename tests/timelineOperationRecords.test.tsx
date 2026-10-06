import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TimelineRecord } from '../src/model.js'
import TimelineView from '../src/TimelineView.js'

const state = vi.hoisted(() => ({ language: 'en' }))
vi.mock('../src/uiLanguage.js', () => ({ useUiLanguage: () => ({ lang: state.language }) }))

function record(id: string, overrides: Partial<TimelineRecord> = {}): TimelineRecord {
  return {
    id, kind: 'opportunity_updated', category: 'opportunity', source: 'user_action',
    title: id, recordedAt: '2026-10-06T14:00:00Z', occurredAt: '2026-09-01T09:00:00Z',
    ...overrides,
  }
}
const render = (records: TimelineRecord[]) => renderToStaticMarkup(<TimelineView records={records} />)
const recordIds = (html: string) => [...html.matchAll(/data-record-id="([^"]+)"/g)].map(match => match[1])
const dayLabels = (html: string) => [...html.matchAll(/class="timeline-day-label"><strong>(.*?)<\/strong>/g)].map(match => match[1])
const day = (value: string) => new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' }).format(new Date(value))

beforeEach(() => { state.language = 'en' })

describe('Settings operation-record chronology', () => {
  it('groups records by recordedAt and retains the distinct event date only as secondary context', () => {
    const records = [record('earlier-event'), record('later-event', { occurredAt: '2026-12-25T13:00:00Z' })]
    const original = structuredClone(records)
    const html = render(records)
    expect(dayLabels(html)).toEqual([day(records[0].recordedAt)])
    expect(html.match(/class="timeline-recorded-time">Recorded /g)).toHaveLength(2)
    expect(html).toContain('<time dateTime="2026-10-06T14:00:00Z">')
    expect(html).toContain('Event time: <time dateTime="2026-09-01T09:00:00Z">')
    expect(html).toContain('Event time: <time dateTime="2026-12-25T13:00:00Z">')
    expect(records).toEqual(original)
  })

  it('sorts actual operation instants across time-zone offsets rather than ISO string order', () => {
    const html = render([
      record('earlier', { recordedAt: '2026-10-06T10:30:00+08:00' }),
      record('later', { recordedAt: '2026-10-06T05:00:00Z' }),
      record('yesterday', { recordedAt: '2026-10-05T08:00:00Z', occurredAt: '2026-12-31T00:00:00Z' }),
    ])
    expect(recordIds(html)).toEqual(['later', 'earlier', 'yesterday'])
    expect(dayLabels(html)).toEqual([day('2026-10-06T05:00:00Z'), day('2026-10-05T08:00:00Z')])
  })

  it('puts missing or invalid operation timestamps in one unknown bucket without borrowing event time', () => {
    const values = [undefined, null, '', ' ', 'invalid-date', '0', '2026-02-30T10:00:00Z']
    const html = render([
      ...values.map((recordedAt, index) => record(`unknown-${index}`, { recordedAt: recordedAt as string })),
      record('known'),
    ])
    expect(recordIds(html)).toEqual(['known', ...values.map((_, index) => `unknown-${index}`)])
    expect(dayLabels(html)).toEqual([day('2026-10-06T14:00:00Z'), 'Operation time unknown'])
    expect(html.match(/class="timeline-recorded-time">Operation time unknown/g)).toHaveLength(values.length)
    expect(html.match(/class="timeline-recorded-time">Recorded /g)).toHaveLength(1)
    expect(html).not.toContain('Invalid Date')
  })

  it('does not call an exact midnight operation date-only or duplicate identical event time', () => {
    const timestamp = '2026-10-06T00:00:00Z'
    const html = render([record('midnight', { recordedAt: timestamp, occurredAt: timestamp })])
    expect(html).not.toContain('Date only')
    expect(html).not.toContain('timeline-event-time')
  })

  it('retains original audit details and command evidence without trying to format an invalid event time', () => {
    const html = render([record('command', {
      occurredAt: 'invalid-event-time', detail: 'Original source evidence', company: 'Synthetic company', role: 'Synthetic role',
      commandId: 'synthetic-command-id', commandOperation: 'action.status.set',
      changes: { status: { before: 'done', after: 'todo' } },
    })])
    for (const text of ['Original source evidence', 'Synthetic company', 'Synthetic role', 'synthetic-command-id', 'action.status.set', 'done', 'todo']) expect(html).toContain(text)
    expect(html).not.toContain('timeline-event-time')
  })

  it('uses matching Chinese labels for operations, unknown time, event time, and filters', () => {
    state.language = 'zh'
    const html = render([record('known'), record('unknown', { recordedAt: '' })])
    for (const text of ['全部记录', '搜索操作记录', '记录类型', '记录来源', '记录于', '操作时间未知', '事件时间：']) expect(html).toContain(text)
    expect(render([])).toContain('没有匹配的操作记录')
  })
})

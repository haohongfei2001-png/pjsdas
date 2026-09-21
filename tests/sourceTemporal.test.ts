import { describe, expect, it } from 'vitest'
import { resolveSourceTemporal } from '../src/sourceTemporal.js'
const source = { receivedAt: '2026-09-20T23:55:00Z', timezone: 'Asia/Shanghai' }
describe('source temporal resolution', () => {
  it('resolves tomorrow against original local source day across UTC boundaries', () => {
    expect(resolveSourceTemporal('明天 14:30 面试', source)?.startAt).toBe('2026-09-22T14:30:00+08:00')
    expect(resolveSourceTemporal('Interview tomorrow 2:30 pm', source)?.startAt).toBe('2026-09-22T14:30:00+08:00')
    expect(resolveSourceTemporal('Interview tomorrow 2:30 PM', source)?.startAt).toBe('2026-09-22T14:30:00+08:00')
  })
  it('preserves calendar precision and explicit week semantics', () => {
    expect(resolveSourceTemporal('下周五 截止', { ...source, mode: 'deadline' })).toMatchObject({ shape: 'date_only', date: '2026-10-02', rawExpression: '下周五' })
    expect(resolveSourceTemporal('this Sunday 09:00', source)?.startAt).toBe('2026-09-27T09:00:00+08:00')
    expect(resolveSourceTemporal('本周天 09:00', source)?.startAt).toBe('2026-09-27T09:00:00+08:00')
    expect(resolveSourceTemporal('下周天 09:00', source)?.startAt).toBe('2026-10-04T09:00:00+08:00')
  })
  it('does not normalize impossible or ambiguous date/time expressions', () => {
    for (const text of ['2026-02-30 14:00', '2026-09-22或2026-09-23 14:00', '明天或后天 14:00', '明天 25:00', '明天 14:00 PST', '2026-09-22T14:30:00Z', '2026-09-22 14:30 Asia/Tokyo', ...['CET', 'CEST', 'JST', 'KST', 'IST'].map((zone) => `2026-09-22 14:30 ${zone}`)]) expect(resolveSourceTemporal(text, source)).toBeUndefined()
  })
  it('fails closed for ambiguous/nonexistent DST local time', () => {
    const ny = { receivedAt: source.receivedAt, timezone: 'America/New_York' }
    expect(resolveSourceTemporal('2026-11-01 01:30', ny)).toBeUndefined()
    expect(resolveSourceTemporal('2026-03-08 02:30', ny)).toBeUndefined()
    expect(resolveSourceTemporal('2026-11-01 03:30', ny)?.startAt).toBe('2026-11-01T03:30:00-05:00')
  })
})

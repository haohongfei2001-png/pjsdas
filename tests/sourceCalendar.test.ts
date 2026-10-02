import { describe, expect, it } from 'vitest'
import { validSourceDate, validSourceInstant } from '../src/sourceCalendar.js'
describe('strict source calendar evidence', () => {
  it.each(['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00'])('rejects impossible calendar %s in dates and instants', value => {
    expect(validSourceDate(value)).toBe(false)
    expect(validSourceInstant(value + 'T12:00:00Z')).toBe(false)
    expect(validSourceInstant(value + 'T12:00:00+08:00')).toBe(false)
  })
  it.each(['2026-10-02T12:00:00', '2026-10-02T24:00:00Z', '2026-10-02T12:60:00Z', '2026-10-02T12:00:60Z', '2026-10-02T12:00:00+14:01', '2026-10-02T12:00:00+15:00', '2026-10-02'])('rejects invalid/implicit source instant %s', value => expect(validSourceInstant(value)).toBe(false))
  it.each(['2028-02-29T23:59:59Z', '2026-10-02T12:30+08:00', '2026-10-02T12:30:01.123-05:30', '2026-10-02T00:00:00+14:00'])('preserves explicit valid source instant %s', value => expect(validSourceInstant(value)).toBe(true))
})

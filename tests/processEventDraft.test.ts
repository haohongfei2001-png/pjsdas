import { describe, expect, it } from 'vitest'
import {
  localProcessEventDateTimeValue,
  occurredAtWhenOpeningProcessEventDraft,
} from '../src/processEventDraft.js'

describe('process-event draft notification time', () => {
  it('refreshes an untouched default to the time the dock is actually opened', () => {
    const mountedAt = new Date('2026-09-14T08:00:00.000Z')
    const openedAt = new Date('2026-09-14T13:45:00.000Z')
    const staleDefault = localProcessEventDateTimeValue(mountedAt)

    expect(occurredAtWhenOpeningProcessEventDraft(staleDefault, false, openedAt))
      .toBe(localProcessEventDateTimeValue(openedAt))
  })

  it('preserves a time the user explicitly edited', () => {
    const edited = '2026-09-14T09:30'
    expect(occurredAtWhenOpeningProcessEventDraft(
      edited,
      true,
      new Date('2026-09-14T13:45:00.000Z'),
    )).toBe(edited)
  })
})

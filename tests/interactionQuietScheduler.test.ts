import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInteractionQuietScheduler, markInteractionActivity } from '../src/cloud/interactionActivity.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('deferred passive refresh ownership', () => {
  it('coalesces a requested refresh and resumes only after the latest input is quiet', () => {
    vi.useFakeTimers()
    const now = vi.spyOn(performance, 'now').mockReturnValue(100)
    const resume = vi.fn()
    const scheduler = createInteractionQuietScheduler('quiet-route', resume)
    markInteractionActivity('quiet-route')
    scheduler.schedule(); scheduler.schedule()
    expect(vi.getTimerCount()).toBe(1)
    now.mockReturnValue(900); markInteractionActivity('quiet-route')
    now.mockReturnValue(1100); vi.advanceTimersByTime(1000)
    expect(resume).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    now.mockReturnValue(2100); vi.advanceTimersByTime(1000)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels on route/account owner cleanup without a late read', () => {
    vi.useFakeTimers()
    const resume = vi.fn()
    const scheduler = createInteractionQuietScheduler('departed-account', resume)
    scheduler.schedule(); scheduler.cancel()
    vi.advanceTimersByTime(2000)
    expect(resume).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

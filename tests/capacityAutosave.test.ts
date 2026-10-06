import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPACITY_AUTOSAVE_DELAY_MS, capacityMinutesFromHours, createCapacityAutosaver } from '../src/today/capacityAutosave.js'

const intent = (minutes: number, scope = 'local-day-a') => ({ minutes, scope })
const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
afterEach(() => vi.useRealTimers())
describe('capacity autosave', () => {
  it.each(['', ' ', '-', 'NaN', 'Infinity', '-1', '24.1'])('does not turn incomplete or invalid %s into a write', value => {
    expect(capacityMinutesFromHours(value)).toBeUndefined()
  })
  it.each([['0', 0], ['3', 180], ['6', 360], ['3.25', 195], ['0.1', 6]])('converts explicit %s hours into %s minutes', (value, minutes) => {
    expect(capacityMinutesFromHours(String(value))).toBe(minutes)
  })
  it('coalesces rapid valid typing and flushes blur/Enter immediately', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async () => {}), notify = vi.fn()
    const queue = createCapacityAutosaver(save, notify)
    queue.schedule(intent(60)); queue.schedule(intent(180)); queue.schedule(intent(195))
    await vi.advanceTimersByTimeAsync(CAPACITY_AUTOSAVE_DELAY_MS - 1)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save.mock.calls).toEqual([[intent(195)]])
    queue.schedule(intent(360)); queue.flush()
    expect(save).toHaveBeenLastCalledWith(intent(360))
    await vi.runAllTimersAsync()
    expect(notify).toHaveBeenLastCalledWith({ pending: false, intent: intent(360) })
  })
  it('serializes writes and suppresses an old rejection when there is a newer edit', async () => {
    const first = deferred(), second = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise), notify = vi.fn()
    const queue = createCapacityAutosaver(save, notify)
    queue.schedule(intent(180)); queue.flush()
    queue.schedule(intent(360)); queue.flush()
    expect(save).toHaveBeenCalledTimes(1)
    first.reject(new Error('old failure'))
    await Promise.resolve(); await Promise.resolve()
    expect(save.mock.calls).toEqual([[intent(180)], [intent(360)]])
    expect(notify.mock.calls.some(([state]) => state.error)).toBe(false)
    second.resolve(); await Promise.resolve()
    expect(notify).toHaveBeenLastCalledWith({ pending: false, intent: intent(360) })
  })
  it('shows the latest failure and permits the next edit to retry', async () => {
    const error = new Error('write failed'), save = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined), notify = vi.fn()
    const queue = createCapacityAutosaver(save, notify)
    queue.schedule(intent(180)); queue.flush(); await Promise.resolve()
    expect(notify).toHaveBeenLastCalledWith({ pending: false, intent: intent(180), error })
    queue.schedule(intent(180)); queue.flush(); await Promise.resolve()
    expect(notify).toHaveBeenLastCalledWith({ pending: false, intent: intent(180) })
  })
  it('cancels empty drafts and old date/timezone scopes without writing a zero or moving dates', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async () => {}), notify = vi.fn()
    const queue = createCapacityAutosaver(save, notify)
    queue.schedule(intent(180, 'Shanghai:2026-10-07')); queue.cancel()
    await vi.runAllTimersAsync()
    expect(save).not.toHaveBeenCalled()
    queue.schedule(intent(360, 'Los_Angeles:2026-10-06')); queue.flush(); await Promise.resolve()
    expect(save).toHaveBeenCalledExactlyOnceWith(intent(360, 'Los_Angeles:2026-10-06'))
  })
  it('finishes an accepted navigation edit behind an in-flight save without updating detached UI', async () => {
    const first = deferred(), save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined), notify = vi.fn()
    const queue = createCapacityAutosaver(save, notify)
    queue.schedule(intent(180)); queue.flush(); queue.schedule(intent(360)); queue.detach()
    const notifications = notify.mock.calls.length
    first.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(save.mock.calls).toEqual([[intent(180)], [intent(360)]])
    expect(notify).toHaveBeenCalledTimes(notifications)
  })
  it('can reattach after StrictMode effect replay', async () => {
    const save = vi.fn(async () => {}), notify = vi.fn()
    const queue = createCapacityAutosaver(save, notify)
    queue.detach(); queue.attach(); queue.schedule(intent(0)); queue.flush(); await Promise.resolve()
    expect(notify).toHaveBeenLastCalledWith({ pending: false, intent: intent(0) })
  })
  it('shares one owner queue across view remounts so the new view supersedes an old queued value', async () => {
    const first = deferred()
    let stored = 0
    const save = vi.fn(async ({ minutes }: { minutes: number }) => {
      if (minutes === 180) await first.promise
      stored = minutes
    })
    const ownerState = vi.fn()
    const owner = createCapacityAutosaver(save, ownerState)
    owner.schedule(intent(180)); owner.flush()
    owner.schedule(intent(360)); owner.flush()
    // The view leaves and reopens, but its App owner and queue remain mounted.
    owner.schedule(intent(240)); owner.flush()
    first.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(save.mock.calls.map(([value]) => value.minutes)).toEqual([180, 240])
    expect(stored).toBe(240)
    expect(ownerState).toHaveBeenLastCalledWith({ pending: false, intent: intent(240) })
  })

  it('reports a failed accepted write after an empty draft without replacing that draft', async () => {
    const first = deferred(), notify = vi.fn()
    const owner = createCapacityAutosaver(() => first.promise, notify)
    owner.schedule(intent(180)); owner.flush(); owner.cancelDraft()
    const error = new Error('accepted write failed')
    first.reject(error); await Promise.resolve()
    expect(notify).toHaveBeenLastCalledWith({ pending: false, intent: intent(180), error, outdated: true })
  })
  it('does not leak an old scope failure into the next account or day', async () => {
    const first = deferred(), notify = vi.fn()
    const owner = createCapacityAutosaver(() => first.promise, notify)
    owner.schedule(intent(180)); owner.flush(); owner.cancel()
    first.reject(new Error('old account')); await Promise.resolve()
    expect(notify).toHaveBeenLastCalledWith({ pending: false })
  })

})

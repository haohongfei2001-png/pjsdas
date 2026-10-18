import { describe, expect, it, vi } from 'vitest'
import { createCapturePreviewPresentation } from '../src/capturePreviewPresentation.js'

describe('capture preview presentation cannot move an occupied confirmation target', () => {
  it('publishes immediately when no interaction owns the target', () => {
    const gate = createCapturePreviewPresentation(), show = vi.fn()
    gate.begin().publish(show)
    expect(show).toHaveBeenCalledOnce()
  })
  it.each(['pointer', 'focus'] as const)('defers completion during %s without gating a save', kind => {
    const gate = createCapturePreviewPresentation(), show = vi.fn(), save = vi.fn()
    const request = gate.begin(); gate.hold(kind, true)
    request.publish(show); save()
    expect(show).not.toHaveBeenCalled(); expect(save).toHaveBeenCalledOnce()
    gate.hold(kind, false)
    expect(show).toHaveBeenCalledOnce()
  })
  it.each(['pointer', 'focus'] as const)('requires both pointer and focus to leave, releasing %s first', first => {
    const gate = createCapturePreviewPresentation(), show = vi.fn()
    gate.hold('pointer', true); gate.hold('focus', true); gate.begin().publish(show)
    gate.hold(first, false); expect(show).not.toHaveBeenCalled()
    gate.hold(first === 'pointer' ? 'focus' : 'pointer', false); expect(show).toHaveBeenCalledOnce()
  })
  it.each(['text edit', 'account change', 'session change', 'save start'] as const)('drops queued and late responses after %s', () => {
    const gate = createCapturePreviewPresentation(), old = vi.fn(), current = vi.fn()
    const request = gate.begin(); gate.hold('pointer', true); request.publish(old)
    gate.invalidate(); request.publish(old); gate.hold('pointer', false)
    expect(old).not.toHaveBeenCalled()
    gate.begin().publish(current); expect(current).toHaveBeenCalledOnce()
  })
  it('cancels a request without cancelling a newer response or releasing occupancy', () => {
    const gate = createCapturePreviewPresentation(), old = vi.fn(), current = vi.fn()
    gate.hold('pointer', true)
    const first = gate.begin(), second = gate.begin()
    second.publish(current); first.cancel(); first.publish(old)
    expect(current).not.toHaveBeenCalled()
    gate.hold('pointer', false)
    expect(current).toHaveBeenCalledOnce(); expect(old).not.toHaveBeenCalled()
  })
  it('close/reset drops pending content and clears both interaction owners', () => {
    const gate = createCapturePreviewPresentation(), old = vi.fn(), reopened = vi.fn()
    gate.hold('pointer', true); gate.hold('focus', true)
    const request = gate.begin(); request.publish(old); gate.reset(); request.publish(old)
    gate.begin().publish(reopened)
    expect(old).not.toHaveBeenCalled(); expect(reopened).toHaveBeenCalledOnce()
  })
  it('only displays the last result from the current generation on release', () => {
    const gate = createCapturePreviewPresentation(), old = vi.fn(), latest = vi.fn()
    gate.hold('pointer', true)
    const request = gate.begin(); request.publish(old); request.publish(latest)
    gate.hold('pointer', false); gate.hold('pointer', false)
    expect(old).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledOnce()
  })
})

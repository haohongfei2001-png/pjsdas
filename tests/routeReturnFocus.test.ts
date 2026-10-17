import { describe, expect, it, vi } from 'vitest'
import { scheduleRouteReturnPosition } from '../src/routeReturnFocus.js'

function frameClock() {
  let pending: FrameRequestCallback[] = []
  return {
    requestAnimationFrame(callback: FrameRequestCallback) { pending.push(callback); return pending.length },
    frame() { const ready = pending; pending = []; ready.forEach(callback => callback(0)) },
  }
}

describe('delayed detail return position', () => {
  const body = { isConnected: true } as HTMLElement
  const documentElement = { isConnected: true } as HTMLElement
  it.each([null, body, documentElement, { isConnected: false } as HTMLElement])('restores the opener when focus is vacant (%s)', activeElement => {
    const restore = vi.fn()
    const clock = frameClock()
    scheduleRouteReturnPosition(clock, { activeElement, body, documentElement }, restore)
    clock.frame()
    expect(restore).not.toHaveBeenCalled()
    clock.frame()
    expect(restore).toHaveBeenCalledOnce()
  })
  it('preserves a newer focused search input, including scroll position', () => {
    const restore = vi.fn()
    const clock = frameClock()
    const activeElement = { isConnected: true } as HTMLInputElement
    scheduleRouteReturnPosition(clock, { activeElement, body, documentElement }, restore)
    clock.frame(); clock.frame()
    expect(restore).not.toHaveBeenCalled()
  })
  it('reads focus at callback time instead of capturing the old detail control', () => {
    const restore = vi.fn()
    const clock = frameClock()
    const document = { activeElement: body, body, documentElement }
    scheduleRouteReturnPosition(clock, document, restore)
    clock.frame()
    document.activeElement = { isConnected: true } as HTMLButtonElement
    clock.frame()
    expect(restore).not.toHaveBeenCalled()
    document.activeElement = body
    scheduleRouteReturnPosition(clock, document, restore)
    clock.frame(); clock.frame()
    expect(restore).toHaveBeenCalledOnce()
  })
})

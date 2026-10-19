import { describe, expect, it } from 'vitest'
import { capturePopoverLayout } from '../src/capture/popoverLayout.js'

describe('nonmodal capture stays anchored inside the visible viewport', () => {
  it('expands left from the actual desktop trigger', () => {
    expect(capturePopoverLayout({ top: 8, right: 1360 }, { left: 0, top: 0, width: 1440, height: 900 }))
      .toEqual({ left: 740, top: 8, width: 620, maxHeight: 884 })
  })
  for (const width of [320, 390, 700]) it(`uses the full mobile edge width at ${width}`, () => {
    const box = capturePopoverLayout({ top: 8, right: width - 60 }, { left: 0, top: 0, width, height: 844 })
    expect(box.left).toBe(12)
    expect(box.width).toBe(Math.min(620, width - 24))
    expect(box.left + box.width).toBeLessThanOrEqual(width - 12)
  })
  it('clamps stale or scrolled-off anchors to the visible viewport', () => {
    for (const anchor of [{ top: -500, right: -10 }, { top: 5000, right: 5000 }, undefined]) {
      const box = capturePopoverLayout(anchor, { left: 100, top: 200, width: 800, height: 350 })
      expect(box.left).toBeGreaterThanOrEqual(112)
      expect(box.left + box.width).toBeLessThanOrEqual(888)
      expect(box.top).toBeGreaterThanOrEqual(208)
      expect(box.top + box.maxHeight).toBeLessThanOrEqual(542)
    }
  })
  it('follows a resized visual viewport above a mobile keyboard', () => {
    expect(capturePopoverLayout({ top: 8, right: 330 }, { left: 0, top: 120, width: 390, height: 300 }))
      .toEqual({ left: 12, top: 128, width: 366, maxHeight: 284 })
  })
})

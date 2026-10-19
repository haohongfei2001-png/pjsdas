export interface CaptureViewport { left: number; top: number; width: number; height: number }
export interface CaptureAnchor { top: number; right: number }

/** Position the nonmodal composer in the visible viewport, aligned to its trigger. */
export function capturePopoverLayout(anchor: CaptureAnchor | undefined, viewport: CaptureViewport) {
  const margin = 12
  const width = Math.max(0, Math.min(620, viewport.width - margin * 2))
  const left = viewport.width <= 700 ? viewport.left + margin
    : Math.max(viewport.left + margin, Math.min((anchor?.right ?? viewport.left + viewport.width - margin) - width, viewport.left + viewport.width - margin - width))
  const top = Math.max(viewport.top + 8, Math.min(anchor?.top ?? viewport.top + 8, viewport.top + Math.max(8, viewport.height - 64)))
  return { left, top, width, maxHeight: Math.max(44, viewport.top + viewport.height - top - 8) }
}

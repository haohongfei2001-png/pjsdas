/** Keep an async preview from moving confirmation controls under an active
 * pointer/focus. This gate owns presentation only, never command admission. */
export function createCapturePreviewPresentation() {
  let generation = 0
  let pointer = false, focus = false
  let pending: (() => void) | undefined
  const flush = () => {
    if (pointer || focus) return
    const update = pending
    pending = undefined
    update?.()
  }
  return {
    hold(kind: 'pointer' | 'focus', value: boolean) {
      if (kind === 'pointer') pointer = value
      else focus = value
      flush()
    },
    invalidate() { generation++; pending = undefined },
    reset() { generation++; pending = undefined; pointer = false; focus = false },
    begin() {
      const own = ++generation
      pending = undefined
      return {
        publish(update: () => void) {
          if (own !== generation) return
          pending = () => { if (own === generation) update() }
          flush()
        },
        cancel() { if (own === generation) { generation++; pending = undefined } },
      }
    },
  }
}

/** Recovery locks an exact input; only reuse a settled preview of that input. */
export function canRetainRecoveryPreview(locked: boolean, current: readonly unknown[], settled: readonly unknown[] | undefined): boolean {
  return locked && settled !== undefined && current.length === settled.length
    && current.every((value, index) => Object.is(value, settled[index]))
}

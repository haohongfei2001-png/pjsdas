/** A delayed route return must not override a newer keyboard/pointer focus. */
export function scheduleRouteReturnPosition(
  window: Pick<Window, 'requestAnimationFrame'>,
  document: Pick<Document, 'activeElement' | 'body' | 'documentElement'>,
  restore: () => void,
) {
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    const active = document.activeElement
    if (active && active !== document.body && active !== document.documentElement && active.isConnected) return
    restore()
  }))
}

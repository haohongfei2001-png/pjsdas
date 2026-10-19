type FocusDocument = Pick<Document, 'activeElement' | 'body' | 'documentElement'>

export function captureFocusIsVacant(document: FocusDocument) {
  const active = document.activeElement
  return !active || active === document.body || active === document.documentElement || !active.isConnected
}

/** Owns only the current composer's async presentation and focus, never writes. */
export function createCaptureOperationLifecycle() {
  let generation = 0
  let view: { open: boolean; accountKey: string | null } | undefined
  let current: ReturnType<typeof begin> | undefined
  let flight: ReturnType<typeof begin> | undefined

  function invalidate() {
    generation++
    current = undefined
    view = undefined
  }

  function begin(sheet: HTMLElement | null, document: FocusDocument, invokedControl?: HTMLElement) {
    if (!view?.open || !sheet?.isConnected || flight?.pending) return undefined
    const own = generation
    const accountKey = view.accountKey
    const active = document.activeElement
    const focusedControl = active && sheet.contains(active) && typeof (active as HTMLElement).focus === 'function'
      ? active as HTMLElement
      // Native accessibility activation can invoke Save without focusing it.
      : captureFocusIsVacant(document) && invokedControl && sheet.contains(invokedControl) ? invokedControl : undefined
    let ownsFocus = Boolean(focusedControl)
    const operation = {
      pending: true,
      isCurrent: () => own === generation && current === operation && sheet.isConnected,
      canReconcileDraft(submittedText: string, currentText: string) {
        // A confirmed write can consume only its unchanged reopened draft.
        // This does not renew the old view's focus ownership.
        return flight === operation && operation.pending && Boolean(view?.open)
          && view?.accountKey === accountKey && currentText === submittedText
      },
      releaseFocus() { ownsFocus = false },
      settle() {
        operation.pending = false
        if (flight === operation) flight = undefined
        return operation.isCurrent()
      },
      restoreFocus(fallback: HTMLElement | null | undefined) {
        if (operation.pending || !operation.isCurrent() || !ownsFocus) return
        ownsFocus = false
        // Never override a newer focus, even another control in this composer.
        if (document.activeElement !== sheet) return
        const target = [focusedControl, fallback].find(control => control?.isConnected
          && sheet.contains(control) && !control.matches(':disabled'))
        target?.focus({ preventScroll: true })
      },
    }
    current = operation
    // View resets must not admit a second invocation before the first has
    // finished, including the pre-journal authority work and reconciliation.
    flight = operation
    // Park before React disables/removes the invoking control. The stable sheet
    // keeps scoped Escape working throughout Save/Undo, including onChanged.
    if (ownsFocus) {
      sheet.focus({ preventScroll: true })
      ownsFocus = document.activeElement === sheet
    }
    return operation
  }

  return {
    updateView(open: boolean, accountKey: string | null) {
      if (!view || view.open !== open || view.accountKey !== accountKey) invalidate()
      view = { open, accountKey }
    },
    invalidate,
    begin,
    releaseFocus() { current?.releaseFocus() },
    restoreFocus(fallback: HTMLElement | null | undefined) { current?.restoreFocus(fallback) },
  }
}

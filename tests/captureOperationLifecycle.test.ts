import { describe, expect, it, vi } from 'vitest'
import { createCaptureOperationLifecycle } from '../src/capture/operationLifecycle.js'

function fixture() {
  const document = { activeElement: null as Element | null, body: null as unknown as HTMLElement, documentElement: null as unknown as HTMLElement }
  function control(parent?: HTMLElement) {
    let disabled = false
    const element = {
      isConnected: true,
      parent,
      contains(node: unknown): boolean {
        return node === element || Boolean(node && element.contains((node as typeof element).parent))
      },
      matches: vi.fn(() => disabled),
      focus: vi.fn(() => { document.activeElement = element as unknown as HTMLElement }),
    }
    return { element: element as unknown as HTMLElement, disable: () => { disabled = true } }
  }
  document.body = control().element
  document.documentElement = control().element
  const sheet = control().element
  const save = control(sheet)
  const input = control(sheet).element
  const outside = control().element
  const lifecycle = createCaptureOperationLifecycle()
  lifecycle.updateView(true, 'account-a')
  document.activeElement = save.element
  return { document, control, sheet, save, input, outside, lifecycle }
}

describe('capture operation presentation and owned focus', () => {
  it.each(['Save', 'Undo'])('parks %s focus before disabling/removing its control, throughout reconciliation', () => {
    const { lifecycle, document, sheet, save, input } = fixture()
    const operation = lifecycle.begin(sheet, document)!
    expect(document.activeElement).toBe(sheet)
    expect(sheet.focus).toHaveBeenCalledWith({ preventScroll: true })
    save.disable()
    Object.defineProperty(save.element, 'isConnected', { value: false })
    lifecycle.restoreFocus(input)
    expect(document.activeElement).toBe(sheet)
    expect(operation.isCurrent()).toBe(true)
    expect(operation.settle()).toBe(true)
    lifecycle.restoreFocus(input)
    expect(document.activeElement).toBe(input)
    expect(input.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('returns to the original enabled control after an error or a non-writing result', () => {
    const { lifecycle, document, sheet, save, input } = fixture()
    lifecycle.begin(sheet, document)!.settle()
    lifecycle.restoreFocus(input)
    expect(document.activeElement).toBe(save.element)
    expect(input.focus).not.toHaveBeenCalled()
    lifecycle.restoreFocus(input)
    expect(save.element.focus).toHaveBeenCalledOnce()
  })

  it('returns to an enabled manual field when the emptied Save button stays disabled', () => {
    const { lifecycle, document, sheet, save, control } = fixture()
    const company = control(sheet).element
    const operation = lifecycle.begin(sheet, document)!
    save.disable()
    operation.settle()
    lifecycle.restoreFocus(company)
    expect(document.activeElement).toBe(company)
  })

  it('keeps the stable sheet focused if recovery leaves all inputs disabled', () => {
    const { lifecycle, document, sheet, save, control } = fixture()
    const input = control(sheet)
    lifecycle.begin(sheet, document)!.settle()
    save.disable(); input.disable()
    lifecycle.restoreFocus(input.element)
    expect(document.activeElement).toBe(sheet)
  })

  it('uses the explicitly invoked button for native accessibility activation with vacant DOM focus', () => {
    const { lifecycle, document, sheet, save } = fixture()
    document.activeElement = document.body
    lifecycle.begin(sheet, document, save.element)!
    expect(document.activeElement).toBe(sheet)
  })

  it('does not claim vacant focus without an owned invoking control', () => {
    const { lifecycle, document, sheet, input, outside } = fixture()
    document.activeElement = document.body
    lifecycle.begin(sheet, document, outside)!.settle()
    lifecycle.restoreFocus(input)
    expect(document.activeElement).toBe(document.body)
    expect(sheet.focus).not.toHaveBeenCalled()
  })

  it('does not take focus from an actual outside control even with an invoked-button fallback', () => {
    const { lifecycle, document, sheet, save, input, outside } = fixture()
    document.activeElement = outside
    lifecycle.begin(sheet, document, save.element)!.settle()
    lifecycle.restoreFocus(input)
    expect(document.activeElement).toBe(outside)
    expect(sheet.focus).not.toHaveBeenCalled()
  })

  it.each(['outside pointer', 'outside keyboard focus', 'outside accessibility activation'])('revokes restoration after %s without suppressing the authoritative receipt', () => {
    const { lifecycle, document, sheet, input, outside } = fixture()
    const operation = lifecycle.begin(sheet, document)!
    lifecycle.releaseFocus()
    document.activeElement = outside
    expect(operation.isCurrent()).toBe(true)
    operation.settle()
    // Even if focus later becomes vacant or returns, ownership stays revoked.
    document.activeElement = document.body
    lifecycle.restoreFocus(input)
    expect(document.activeElement).toBe(document.body)
    document.activeElement = sheet
    lifecycle.restoreFocus(input)
    expect(document.activeElement).toBe(sheet)
  })

  it('does not override a newer focused control within the composer', () => {
    const { lifecycle, document, sheet, input, control } = fixture()
    const more = control(sheet).element
    lifecycle.begin(sheet, document)!.settle()
    document.activeElement = more
    lifecycle.restoreFocus(input)
    expect(document.activeElement).toBe(more)
  })

  it('rejects duplicate invocation while pending without losing ownership on an ordinary render', () => {
    const { lifecycle, document, sheet } = fixture()
    const operation = lifecycle.begin(sheet, document)!
    lifecycle.updateView(true, 'account-a')
    expect(lifecycle.begin(sheet, document)).toBeUndefined()
    expect(operation.isCurrent()).toBe(true)
    expect(operation.settle()).toBe(true)
    expect(lifecycle.begin(sheet, document)).toBeDefined()
  })

  it.each(['close and reopen', 'account switch and return', 'explicit dismissal'])('drops stale UI after %s without admitting another execution before completion', transition => {
    const { lifecycle, document, sheet, input } = fixture()
    const old = lifecycle.begin(sheet, document)!
    if (transition === 'close and reopen') {
      lifecycle.updateView(false, 'account-a')
      lifecycle.updateView(true, 'account-a')
    } else if (transition === 'account switch and return') {
      lifecycle.updateView(true, 'account-b')
      lifecycle.updateView(true, 'account-a')
    } else {
      lifecycle.invalidate()
      lifecycle.updateView(true, 'account-a')
    }
    // The underlying authority call can still be preparing its durable journal.
    // A fresh view may edit, but cannot start a duplicate write or Undo.
    document.activeElement = input
    expect(old.isCurrent()).toBe(false)
    expect(lifecycle.begin(sheet, document)).toBeUndefined()
    expect(old.settle()).toBe(false)
    const current = lifecycle.begin(sheet, document)!
    expect(current.isCurrent()).toBe(true)
    expect(document.activeElement).toBe(sheet)
    // An old finally must neither release a newer flight nor restore its focus.
    expect(old.settle()).toBe(false)
    lifecycle.restoreFocus(input)
    expect(document.activeElement).toBe(sheet)
    lifecycle.invalidate()
    lifecycle.updateView(true, 'account-a')
    expect(lifecycle.begin(sheet, document)).toBeUndefined()
    expect(current.settle()).toBe(false)
    expect(lifecycle.begin(sheet, document)).toBeDefined()
  })

  it.each(['account-a', null])('allows a confirmed write to consume only its unchanged reopened draft for %s', accountKey => {
    const { lifecycle, document, sheet, input } = fixture()
    lifecycle.updateView(true, accountKey)
    const operation = lifecycle.begin(sheet, document)!
    lifecycle.updateView(false, accountKey)
    lifecycle.updateView(true, accountKey)
    document.activeElement = input
    expect(operation.isCurrent()).toBe(false)
    expect(operation.canReconcileDraft('original draft', 'original draft')).toBe(true)
    expect(operation.canReconcileDraft('original draft', 'newer draft')).toBe(false)
    expect(operation.canReconcileDraft(' original draft ', 'original draft')).toBe(false)
    lifecycle.restoreFocus(input)
    expect(document.activeElement).toBe(input)
    expect(operation.settle()).toBe(false)
    expect(operation.canReconcileDraft('original draft', 'original draft')).toBe(false)
  })

  it.each(['closed', 'other account', 'missing account', 'unmounted'])('does not reconcile a late confirmed write into a %s view', transition => {
    const { lifecycle, document, sheet } = fixture()
    const operation = lifecycle.begin(sheet, document)!
    if (transition === 'closed') lifecycle.updateView(false, 'account-a')
    else if (transition === 'other account') lifecycle.updateView(true, 'account-b')
    else if (transition === 'missing account') lifecycle.updateView(true, null)
    else lifecycle.invalidate()
    expect(operation.canReconcileDraft('original draft', 'original draft')).toBe(false)
  })

  it('rejects closed or detached sheets and late work after unmount', () => {
    const { lifecycle, document, sheet, input } = fixture()
    lifecycle.updateView(false, 'account-a')
    expect(lifecycle.begin(sheet, document)).toBeUndefined()
    lifecycle.updateView(true, 'account-a')
    const operation = lifecycle.begin(sheet, document)!
    Object.defineProperty(sheet, 'isConnected', { value: false })
    expect(operation.isCurrent()).toBe(false)
    expect(operation.settle()).toBe(false)
    lifecycle.restoreFocus(input)
    expect(input.focus).not.toHaveBeenCalled()
    expect(lifecycle.begin(sheet, document)).toBeUndefined()
  })
})

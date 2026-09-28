import React from 'react'
import { createRoot } from 'react-dom/client'
import { RootErrorBoundary } from '../../src/StartupRecovery.js'

/** Test-only root render fault, including exceptions thrown by synchronous selectors. */
export function mount() {
  const host = document.createElement('div')
  host.id = 'startup-recovery-test'
  document.body.append(host)
  ;(window as any).__recoveryThrow = true
  function Fault() {
    if ((window as any).__recoveryThrow) throw new Error('Injected selector failure')
    return <p>Recovered render</p>
  }
  createRoot(host).render(<RootErrorBoundary><Fault /></RootErrorBoundary>)
}

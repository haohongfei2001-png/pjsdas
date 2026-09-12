import { Suspense, lazy } from 'react'

const HeavyContinuousDiscoveryDock = lazy(() => import('./ContinuousDiscoveryDockHeavy.js'))

export default function ContinuousDiscoveryDock() {
  return (
    <Suspense fallback={<span className="surface-muted" aria-busy="true">…</span>}>
      <HeavyContinuousDiscoveryDock />
    </Suspense>
  )
}

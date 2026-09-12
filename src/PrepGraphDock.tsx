import { Suspense, lazy } from 'react'

const HeavyPrepGraphDock = lazy(() => import('./PrepGraphDockHeavy.js'))

export default function PrepGraphDock() {
  return (
    <Suspense fallback={<span className="surface-muted" aria-busy="true">…</span>}>
      <HeavyPrepGraphDock />
    </Suspense>
  )
}

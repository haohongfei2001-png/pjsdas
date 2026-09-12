import { Suspense, lazy } from 'react'

const HeavyApplicationPortfolioDock = lazy(() => import('./ApplicationPortfolioDockHeavy.js'))

export default function ApplicationPortfolioDock() {
  return (
    <Suspense fallback={<span className="surface-muted" aria-busy="true">…</span>}>
      <HeavyApplicationPortfolioDock />
    </Suspense>
  )
}

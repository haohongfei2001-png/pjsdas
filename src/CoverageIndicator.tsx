import { Suspense, lazy } from 'react'
import './coverageIndicator.css'

const HeavyCoverageIndicator = lazy(() => import('./CoverageIndicatorHeavy.js'))

export default function CoverageIndicator() {
  return (
    <Suspense fallback={<span className="coverage-indicator" aria-busy="true" aria-label="正在加载 Coverage">…</span>}>
      <HeavyCoverageIndicator />
    </Suspense>
  )
}

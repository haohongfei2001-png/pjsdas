import { Suspense, lazy } from 'react'
import { useUiLanguage } from './uiLanguage.js'
import './coverageIndicator.css'

const HeavyCoverageIndicator = lazy(() => import('./CoverageIndicatorHeavy.js'))

export default function CoverageIndicator() {
  const { lang } = useUiLanguage()
  return (
    <Suspense fallback={<span className="coverage-indicator" aria-busy="true" aria-label={lang === 'zh' ? '正在加载系统健康状态' : 'Loading system health status'}>…</span>}>
      <HeavyCoverageIndicator />
    </Suspense>
  )
}

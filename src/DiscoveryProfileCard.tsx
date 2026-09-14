import { Suspense, lazy } from 'react'
import { useUiLanguage } from './uiLanguage.js'

const HeavyDiscoveryProfileCard = lazy(() => import('./DiscoveryProfileCardHeavy.js'))

export default function DiscoveryProfileCard() {
  const { lang } = useUiLanguage()
  return (
    <Suspense fallback={<div className="empty-card" aria-busy="true">{lang === 'zh' ? '正在读取岗位发现偏好…' : 'Loading job-discovery preferences…'}</div>}>
      <HeavyDiscoveryProfileCard />
    </Suspense>
  )
}

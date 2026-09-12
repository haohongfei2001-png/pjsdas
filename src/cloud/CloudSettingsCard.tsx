import { Suspense, lazy } from 'react'

const HeavyCloudSettingsCard = lazy(() => import('./CloudSettingsCardHeavy.js'))

export default function CloudSettingsCard() {
  return (
    <Suspense fallback={<div className="empty-card" aria-busy="true">…</div>}>
      <HeavyCloudSettingsCard />
    </Suspense>
  )
}

import { Suspense, lazy } from 'react'

const HeavyDiscoveryProfileCard = lazy(() => import('./DiscoveryProfileCardHeavy.js'))

export default function DiscoveryProfileCard() {
  return (
    <Suspense fallback={<div className="empty-card" aria-busy="true">…</div>}>
      <HeavyDiscoveryProfileCard />
    </Suspense>
  )
}

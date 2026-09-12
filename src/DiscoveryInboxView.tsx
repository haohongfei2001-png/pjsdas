import { Suspense, lazy } from 'react'

const HeavyDiscoveryInboxView = lazy(() => import('./DiscoveryInboxViewHeavy.js'))

export default function DiscoveryInboxView() {
  return (
    <Suspense fallback={<div className="empty-card" aria-busy="true">…</div>}>
      <HeavyDiscoveryInboxView />
    </Suspense>
  )
}

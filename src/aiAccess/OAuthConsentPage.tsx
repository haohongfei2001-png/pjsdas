import { Suspense, lazy } from 'react'

const HeavyOAuthConsentPage = lazy(() => import('./OAuthConsentPageHeavy.js'))

export default function OAuthConsentPage() {
  return (
    <Suspense fallback={<main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }} aria-busy="true">…</main>}>
      <HeavyOAuthConsentPage />
    </Suspense>
  )
}

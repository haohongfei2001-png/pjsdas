import { Suspense, lazy } from 'react'
const Heavy = lazy(() => import('./ScopedManagementConsentPageHeavy.js'))
export default function ScopedManagementConsentPage() {
  return (
    <Suspense
      fallback={
        <main className="ta-consent" aria-busy="true">
          正在读取授权页面…
        </main>
      }
    >
      <Heavy />
    </Suspense>
  )
}

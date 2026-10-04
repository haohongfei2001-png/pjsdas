import { lazy, Suspense } from 'react'

const ReviewerSignInPageHeavy = lazy(() => import('./ReviewerSignInPageHeavy.js'))

export default function ReviewerSignInPage() {
  return <Suspense fallback={<main aria-busy="true">正在载入演示账号登录…</main>}><ReviewerSignInPageHeavy /></Suspense>
}

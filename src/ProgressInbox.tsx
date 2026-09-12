import { Suspense, lazy } from 'react'

const HeavyProgressInbox = lazy(() => import('./ProgressInboxHeavy.js'))

interface ProgressInboxProps {
  onChanged?: () => void
}

export default function ProgressInbox(props: ProgressInboxProps) {
  return (
    <Suspense fallback={(
      <button className="progress-inbox-trigger" type="button" disabled aria-busy="true">
        更新进展 / 事项
      </button>
    )}>
      <HeavyProgressInbox {...props} />
    </Suspense>
  )
}

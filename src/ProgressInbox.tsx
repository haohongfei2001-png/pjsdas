import { Suspense, lazy } from 'react'
import { useUiLanguage } from './uiLanguage.js'

const HeavyProgressInbox = lazy(() => import('./ProgressInboxHeavy.js'))

interface ProgressInboxProps {
  onChanged?: () => void
}

export default function ProgressInbox(props: ProgressInboxProps) {
  const { lang } = useUiLanguage()
  return (
    <Suspense fallback={(
      <button className="progress-inbox-trigger" type="button" disabled aria-busy="true">
        {lang === 'zh' ? '更新进展 / 事项' : 'Update progress / task'}
      </button>
    )}>
      <HeavyProgressInbox {...props} />
    </Suspense>
  )
}

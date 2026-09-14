import { useEffect, useMemo, useState } from 'react'
import { applyActionStatusChangeSet, getAllActions } from './db.js'
import { isUnresolvedPastProcessEvent } from './fixedEventGuardLogic.js'
import { useUiLanguage } from './uiLanguage.js'
import type { Action } from './model.js'
import './fixedEventGuard.css'

interface FixedEventGuardProps {
  onChanged?: () => void
}

export default function FixedEventGuard({ onChanged }: FixedEventGuardProps) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [actions, setActions] = useState<Action[]>([])
  const [now, setNow] = useState(() => new Date())
  const [busy, setBusy] = useState(false)

  async function reload() {
    setNow(new Date())
    setActions(await getAllActions())
  }

  useEffect(() => {
    void reload()
    const timer = window.setInterval(() => { void reload() }, 60_000)
    const handleFocus = () => { void reload() }
    window.addEventListener('focus', handleFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', handleFocus)
    }
  }, [])

  const overdue = useMemo(
    () => actions
      .filter((action) => isUnresolvedPastProcessEvent(action, now))
      .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? '')),
    [actions, now],
  )

  if (overdue.length === 0) return null
  const current = overdue[0]

  async function confirmCompleted() {
    setBusy(true)
    try {
      await applyActionStatusChangeSet(current.id, 'done')
      await reload()
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="fixed-guard" role="alert" aria-label={zh ? '过期流程节点待确认' : 'Past recruiting event needs confirmation'}>
      <div className="fixed-guard-copy">
        <div className="eyebrow">PROCESS EVENT · CONFIRMATION</div>
        <strong>{current.title}</strong>
        <p>{zh
          ? `原节点 ${formatDateTime(current.dueAt!, zh)} 已经过期。系统不会把它继续当成可执行任务，也不会假定你已经完成。`
          : `The original event at ${formatDateTime(current.dueAt!, zh)} has passed. PJSDAS will not keep treating it as executable work, and it will not assume you completed it.`}</p>
        {overdue.length > 1 ? <small>{zh ? `另外还有 ${overdue.length - 1} 个流程节点待确认。` : `${overdue.length - 1} more recruiting event${overdue.length - 1 === 1 ? '' : 's'} need confirmation.`}</small> : null}
      </div>
      <div className="fixed-guard-actions">
        <button type="button" onClick={confirmCompleted} disabled={busy}>
          {busy ? (zh ? '处理中…' : 'Processing…') : (zh ? '确认已完成' : 'Confirm completed')}
        </button>
        <small>{zh
          ? '如果实际没有完成，不要点完成；先确认是否还能补做、联系招聘方，或记录新的流程通知。'
          : 'If it was not completed, do not mark it done. Check whether it can still be completed, contact the recruiter, or record the new recruiting event.'}</small>
      </div>
    </aside>
  )
}

function formatDateTime(iso: string, zh: boolean) {
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

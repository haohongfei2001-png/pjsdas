import { useEffect, useMemo, useState } from 'react'
import { getAllActions, updateActionStatus } from './db'
import { isUnresolvedPastProcessEvent } from './fixedEventGuardLogic'
import type { Action } from './model'
import './fixedEventGuard.css'

interface FixedEventGuardProps {
  onChanged?: () => void
}

export default function FixedEventGuard({ onChanged }: FixedEventGuardProps) {
  const [actions, setActions] = useState<Action[]>([])
  const [now, setNow] = useState(() => new Date())
  const [busy, setBusy] = useState(false)

  async function reload() {
    setNow(new Date())
    setActions(await getAllActions())
  }

  useEffect(() => {
    reload()
    const timer = window.setInterval(reload, 60_000)
    const handleFocus = () => reload()
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
      await updateActionStatus(current.id, 'done')
      await reload()
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="fixed-guard" role="alert">
      <div className="fixed-guard-copy">
        <div className="eyebrow">PROCESS EVENT NEEDS CONFIRMATION</div>
        <strong>{current.title}</strong>
        <p>
          原节点 {formatDateTime(current.dueAt!)} 已经过期。
          系统不会把它继续当成可执行任务，也不会假定你已经完成。
        </p>
        {overdue.length > 1 ? <small>另外还有 {overdue.length - 1} 个流程节点待确认。</small> : null}
      </div>
      <div className="fixed-guard-actions">
        <button type="button" onClick={confirmCompleted} disabled={busy}>
          {busy ? '处理中…' : '确认已完成'}
        </button>
        <small>如果实际没有完成，不要点完成；先确认是否还能补做、联系招聘方，或记录新的流程通知。</small>
      </div>
    </aside>
  )
}

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

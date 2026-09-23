import { useMemo, useState } from 'react'
import type { DecisionRequest } from './model.js'
import {
  resolveWebDecision,
  undoWebSemanticChange,
  type LocalSemanticUndoToken,
} from './webSemanticIntake.js'
import { useUiLanguage } from './uiLanguage.js'
import { useCloud } from './cloud/CloudContext.js'
import { ensureAuthoritativePersistence } from './cloud/authoritativePersistence.js'
import { connectedWorkspaceAuthorityEnabled } from './cloud/connectedWorkspaceRepository.js'
import './ultimateWeb.css'

export default function DecisionRequestsView({
  requests,
  focusRequestId,
  onShowAll,
  onChanged,
}: {
  requests: DecisionRequest[]
  focusRequestId?: string
  onShowAll: () => void
  onChanged: () => Promise<void>
}) {
  const { lang } = useUiLanguage()
  const cloud = useCloud()
  const zh = lang === 'zh'
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState<{ text: string; undo?: LocalSemanticUndoToken }>()

  const open = useMemo(() => [...requests]
    .filter((item) => item.state === 'open')
    .sort((a, b) => {
      const ae = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY
      const be = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY
      return ae - be || a.createdAt.localeCompare(b.createdAt)
    }), [requests])
  const visible = focusRequestId ? open.filter((item) => item.id === focusRequestId) : open

  async function choose(request: DecisionRequest, choiceId: string) {
    if (busyId) return
    setBusyId(request.id)
    setError('')
    try {
      const result = await resolveWebDecision(request.id, choiceId, { accountKey: cloud.session?.user.id })
      if (result.changed && cloud.session && !connectedWorkspaceAuthorityEnabled()) await ensureAuthoritativePersistence(true, cloud.syncNow)
      setReceipt({
        text: result.status === 'DISMISSED'
          ? (zh ? '已记录你的选择，没有执行额外写入。' : 'Your choice was recorded without an additional write.')
          : result.summary,
        undo: result.undo,
      })
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyId(undefined)
    }
  }

  async function undoLast() {
    if (!receipt?.undo || busyId) return
    setBusyId('undo')
    setError('')
    try {
      await undoWebSemanticChange(receipt.undo)
      if (cloud.session && !connectedWorkspaceAuthorityEnabled()) await ensureAuthoritativePersistence(true, cloud.syncNow)
      setReceipt({ text: zh ? '刚才的决定已撤销。' : 'The last decision was undone.' })
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <section className="ultimate-decisions-page">
      <header className="ultimate-page-header">
        <div className="eyebrow">NEEDS YOUR DECISION</div>
        <h1>{zh ? '只处理真正需要你决定的事' : 'Only decisions that genuinely need you'}</h1>
        <p>{zh
          ? '自动化能安全判断的事实不会出现在这里。这里只保留目标歧义、共享名额、外部后果或其他必须由你选择的情况。'
          : 'Facts automation can resolve safely stay out of this view. Only ambiguity, shared constraints, external consequences, or other genuine choices appear here.'}</p>
      </header>
      {focusRequestId ? <button className="settings-secondary-link" type="button" onClick={onShowAll}>
        {zh ? '查看所有待决定事项' : 'View all open decisions'}
      </button> : null}

      {receipt ? (
        <div className="ultimate-receipt" role="status" aria-live="polite">
          <div><strong>{zh ? '决定已处理' : 'Decision handled'}</strong><span>{receipt.text}</span></div>
          {receipt.undo ? <button type="button" onClick={() => { void undoLast() }}>{zh ? '撤销' : 'Undo'}</button> : null}
        </div>
      ) : null}
      {error ? <div className="ultimate-inline-error" role="alert">{error}</div> : null}

      {visible.length === 0 ? (
        <div className="ultimate-quiet-state">
          <strong>{focusRequestId
            ? (zh ? '这项决定已不再待处理' : 'This decision is no longer open')
            : (zh ? '现在没有需要你决定的事' : 'Nothing needs your decision right now')}</strong>
          <span>{focusRequestId
            ? (zh ? '查看所有待决定事项，或返回刚才的机会。' : 'View all open decisions, or return to the opportunity.')
            : (zh ? '这就是正常状态。PJSDAS 会继续自动处理明确事实。' : 'That is the normal state. PJSDAS keeps handling clear facts automatically.')}</span>
        </div>
      ) : (
        <div className="ultimate-decision-list">
          {visible.map((request) => (
            <article className="ultimate-decision-card" key={request.id}>
              <div className="ultimate-decision-copy">
                <span className="ultimate-decision-reason">{zh ? '需要你决定' : 'Needs your decision'}</span>
                <h2>{request.question}</h2>
                {request.recommendationBasis ? <p>{request.recommendationBasis}</p> : null}
                {request.expiresAt ? <small>{zh ? '建议在' : 'Best answered by'} {formatWhen(request.expiresAt, zh)}</small> : null}
              </div>
              <div className="ultimate-decision-choices">
                {request.choices.map((choice) => {
                  const recommended = choice.id === request.recommendedChoiceId
                  return (
                    <button
                      key={choice.id}
                      type="button"
                      className={recommended ? 'recommended' : ''}
                      disabled={Boolean(busyId)}
                      onClick={() => { void choose(request, choice.id) }}
                    >
                      <span>
                        <strong>{choice.label}</strong>
                        {recommended ? <em>{zh ? '建议' : 'Recommended'}</em> : null}
                      </span>
                      <small>{choice.consequence}</small>
                    </button>
                  )
                })}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function formatWhen(value: string, zh: boolean) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

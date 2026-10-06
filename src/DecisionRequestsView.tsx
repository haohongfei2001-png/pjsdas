import { groupOpenDecisions, presentDecision, presentChoice, decisionText } from './decisionPresentation.js'
import { partitionDecisions } from './decisionActionability.js'
import { useMemo, useState } from 'react'
import type { DecisionRequest, Opportunity, ReminderIntent, ScheduleNode } from './model.js'
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
  opportunities = [],
  scheduleNodes = [],
  reminderIntents = [],
  focusRequestId,
  onShowAll,
  onReturnOpportunity,
  onChanged,
}: {
  requests: DecisionRequest[]
  opportunities?: Opportunity[]
  scheduleNodes?: ScheduleNode[]
  reminderIntents?: ReminderIntent[]
  focusRequestId?: string
  onShowAll: () => void
  onReturnOpportunity?: () => void
  onChanged: () => Promise<void>
}) {
  const { lang } = useUiLanguage()
  const cloud = useCloud()
  const zh = lang === 'zh'
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState<{ text: string; undo?: LocalSemanticUndoToken }>()

  const classified = useMemo(() => partitionDecisions(requests, {
    opportunities, scheduleNodes, reminderIntents, now: new Date(),
  }), [requests, opportunities, scheduleNodes, reminderIntents])
  const open = useMemo(() => [...classified.actionable]
    .sort((a, b) => {
      const ae = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY
      const be = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY
      return ae - be || a.createdAt.localeCompare(b.createdAt)
    }), [classified])
  const groups = useMemo(() => groupOpenDecisions(open), [open])
  const groupById = useMemo(() => new Map(groups.map(group => [group[0].id, group])), [groups])
  const visible = focusRequestId ? open.filter((item) => item.id === focusRequestId) : groups.map(group => group[0])
  const quarantinedFocused = focusRequestId
    ? classified.dataQuality.find(item => item.id === focusRequestId)
    : undefined

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
        <div className="eyebrow">{zh ? '待决定事项' : 'NEEDS YOUR DECISION'}</div>
        <h1>{zh ? '只处理真正需要你决定的事' : 'Only decisions that genuinely need you'}</h1>
        <p>{zh
          ? '自动化能安全判断的事实不会出现在这里。这里只保留目标歧义、共享名额、外部后果或其他必须由你选择的情况。'
          : 'Facts automation can resolve safely stay out of this view. Only ambiguity, shared constraints, external consequences, or other genuine choices appear here.'}</p>
      </header>
      {focusRequestId ? <button className="settings-secondary-link" type="button" onClick={onShowAll}>
        {zh ? '查看所有待决定事项' : 'View all open decisions'}
      </button> : null}
      {focusRequestId && onReturnOpportunity ? <button className="settings-secondary-link" type="button" onClick={onReturnOpportunity}>
        {zh ? '返回刚才的机会' : 'Return to opportunity'}
      </button> : null}

      {receipt ? (
        <div className="ultimate-receipt" role="status" aria-live="polite">
          <div><strong>{zh ? '决定已处理' : 'Decision handled'}</strong><span>{zh && receipt.text.match(/^[A-Za-z]/) ? '操作结果已记录，可查看相关岗位和历史。' : receipt.text}</span></div>
          {receipt.undo ? <button type="button" onClick={() => { void undoLast() }}>{zh ? '撤销' : 'Undo'}</button> : null}
        </div>
      ) : null}
      {error ? <div className="ultimate-inline-error" role="alert">{zh && error.match(/^[A-Za-z]/) ? '暂时无法完成操作，已有记录已保留。请刷新后重试。' : error}</div> : null}

      {visible.length === 0 ? (
        <div className="ultimate-quiet-state">
          <strong>{focusRequestId
            ? quarantinedFocused
              ? (zh ? '这条记录仍待核对，当前没有可回答的选择' : 'This source record is still open for review, without an answerable choice')
              : (zh ? '这项决定已不再待处理' : 'This decision is no longer open')
            : (zh ? '现在没有需要你决定的事' : 'Nothing needs your decision right now')}</strong>
          <span>{focusRequestId
            ? quarantinedFocused
              ? (zh ? '原始记录和来源证据已保留在活动记录中；系统不会要求你猜测缺失事实。' : 'The original record and source evidence remain in activity history; no missing fact needs to be guessed.')
              : (zh ? '查看所有待决定事项，或返回刚才的机会。' : 'View all open decisions, or return to the opportunity.')
            : (zh ? '这就是正常状态。TodayAction 会继续自动处理明确事实。' : 'That is the normal state. TodayAction keeps handling clear facts automatically.')}</span>
          {quarantinedFocused ? <a href={(import.meta.env.BASE_URL ?? '/') + 'history'}>{zh ? '查看操作记录' : 'View operation records'}</a> : null}
        </div>
      ) : (
        <div className="ultimate-decision-list">
          {visible.map((request) => {
            const presentation = presentDecision(request, opportunities, zh)
            return (
            <article className="ultimate-decision-card" key={request.id}>
              <div className="ultimate-decision-copy">
                <span className="ultimate-decision-reason">{zh ? '需要你决定' : 'Needs your decision'}</span>
                <h2>{presentation.title}</h2><p>{presentation.explanation}</p><p>{presentation.context}</p>{presentation.sourceUrl ? <a href={presentation.sourceUrl} target="_blank" rel="noreferrer">{zh ? '查看来源邮件' : 'View source email'}</a> : null}
                {request.recommendationBasis ? <p>{decisionText(request.recommendationBasis, zh)}</p> : null}
                {request.expiresAt ? <small>{zh ? '建议在' : 'Best answered by'} {formatWhen(request.expiresAt, zh)}</small> : null}
              </div>
              {!focusRequestId && (groupById.get(request.id)?.length ?? 0) > 1 ? <details><summary>{zh ? '同一来源的重复记录（逐条保留）' : 'Repeated source records (all retained)'}</summary>{groupById.get(request.id)!.map(item => <a key={item.id} href={(import.meta.env.BASE_URL ?? '/') + 'decisions/' + encodeURIComponent(item.id)}>{item.createdAt} · {item.id.slice(-8)}</a>)}</details> : null}
              <div className="ultimate-decision-choices">
                {request.choices.map((choice) => {
                  const recommended = choice.id === request.recommendedChoiceId
                  const copy = presentChoice(choice, zh)
                  return (
                    <button
                      key={choice.id}
                      type="button"
                      className={recommended ? 'recommended' : ''}
                      disabled={Boolean(busyId)}
                      onClick={() => { void choose(request, choice.id) }}
                    >
                      <span>
                        <strong>{copy.label}</strong>
                        {recommended ? <em>{zh ? '建议' : 'Recommended'}</em> : null}
                      </span>
                      <small>{copy.consequence}</small>
                    </button>
                  )
                })}
              </div>
            </article>
          )})}
        </div>
      )}
      {classified.dataQuality.length > 0 && !focusRequestId ? <details className="ultimate-quiet-state">
        <summary>{zh ? '历史待核对 / 数据质量' : 'Historical review / Data quality'} · {classified.dataQuality.length}</summary>
        <p>{zh ? '这些来源记录仍保留在历史与审计中，但目前缺少可由选择补齐的事实，或已不属于当前任务。可在设置的操作记录中查看来源和处理过程。' : 'Source records remain in history and audit. They do not currently offer an answerable business choice or are no longer current.'}</p>
        <a href={(import.meta.env.BASE_URL ?? '/') + 'history'}>{zh ? '查看操作记录' : 'View operation records'}</a>
      </details> : null}
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

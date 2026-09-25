import { useState } from 'react'
import type { Action, Opportunity } from '../model.js'
import { localDateKey, type TodayBriefAction, type TodayBriefCoverageWarning } from '../todayBrief.js'
import type { TodayWebSelection } from './todayWebSelector.js'
import type { ScheduleStream } from '../schedule/scheduleStream.js'
import { ScheduleWindowList } from '../schedule/ScheduleFeature.js'
import { useUiLanguage } from '../uiLanguage.js'
import './today.css'

export type TodayFreshnessState = 'local' | 'initial' | 'refreshing' | 'current' | 'updated' | 'cached' | 'blocked' | 'unavailable'
export interface TodayFreshnessView {
  state: TodayFreshnessState
  observedAt?: string
  latencyMs?: number
  detail?: string
}
interface TodayFeatureProps {
  selection: TodayWebSelection
  criticalWarnings: TodayBriefCoverageWarning[]
  stream: ScheduleStream
  opportunities: Opportunity[]
  readOnly?: boolean
  now: Date
  workspaceEmpty: boolean
  freshness: TodayFreshnessView
  onStart: () => void
  onRetry: () => void
  onOpenDecisions: () => void
  onOpenDecision: (id: string) => void
  onOpenAgenda: () => void
  onOpenUnresolved: () => void
  onExecute: (item: TodayBriefAction) => Promise<void>
  onMark: (id: string, status: Action['status']) => Promise<void>
  onOpenOpportunity: (id: string) => void
}
function timeLabel(item: TodayBriefAction, zh: boolean) {
  const timing = item.timing
  if (!timing) return zh ? '今天' : 'Today'
  if (timing.precision === 'date' && timing.date) return timing.date
  const at = timing.startAt ?? timing.deadlineAt
  if (!at) return zh ? '今天' : 'Today'
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return zh ? '时间待定' : 'Time TBD'
  const formatted = new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timing.timezone || undefined }).format(date)
  return timing.deadlineAt && !timing.startAt ? (zh ? '截止 ' : 'Due ') + formatted : formatted
}
function actionLabel(item: TodayBriefAction, zh: boolean) {
  if (item.execution.operation === 'open_application') return item.execution.externalUrl ? (zh ? '打开申请' : 'Open application') : (zh ? '查看岗位' : 'View job')
  if (item.execution.operation === 'start_prep') return zh ? '开始准备' : 'Start prep'
  if (item.execution.operation === 'open_process') return zh ? '查看流程' : 'View process'
  return !item.opportunityId && item.execution.operation === 'open_action' ? (zh ? '开始' : 'Start') : (zh ? '查看' : 'Open')
}
export default function TodayFeature({ selection, criticalWarnings, stream, opportunities, readOnly = false, now, workspaceEmpty, freshness, onStart, onRetry, onOpenDecisions, onOpenDecision, onOpenAgenda, onOpenUnresolved, onExecute, onMark, onOpenOpportunity }: TodayFeatureProps) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [mobileView, setMobileView] = useState<'tasks' | 'nodes'>('tasks')
  const [pendingId, setPendingId] = useState<string>()
  const [showCompleted, setShowCompleted] = useState(false)
  const zhDateParts = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', timeZone: stream.timezone }).formatToParts(now)
  const date = zh
    ? `${zhDateParts.find((part) => part.type === 'month')?.value ?? ''}月${zhDateParts.find((part) => part.type === 'day')?.value ?? ''}日 · ${new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: stream.timezone }).format(now)}`
    : new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric', weekday: 'short', timeZone: stream.timezone }).format(now)
  const todayKey = localDateKey(now, stream.timezone)
  const completedToday = stream.sections.history.filter((item) => item.date === todayKey && (item.state === 'completed' || item.timeline?.kind === 'action_status_changed'))
  const awaiting = freshness.state === 'initial' && workspaceEmpty
  const unavailable = freshness.state === 'unavailable' && workspaceEmpty
  async function act(id: string, operation: () => Promise<void>) {
    if (pendingId) return
    setPendingId(id)
    try { await operation() } finally { setPendingId(undefined) }
  }
  return <section className="tsui-today" data-testid="cgr02-today">
    <header className="tsui-page-heading"><div><p>{date}</p><h1>{zh ? '今天' : 'Today'}</h1><span>{zh ? '把今天该做的事，一件件做好。' : 'Make progress on what matters today.'}</span></div>
    </header>
    {criticalWarnings.map((item) => <div className="tsui-alert" role="alert" key={item.code}><strong>{item.title}</strong> · {item.detail}</div>)}
    {readOnly ? <div className="tsui-alert" role="alert">{zh ? '今天暂时只读；已有记录和回执保留。' : 'Today is temporarily read only; existing records and receipts are retained.'}</div> : null}
    {freshness.state === 'cached' || freshness.state === 'blocked' || freshness.state === 'unavailable' ? <div className="tsui-status" role="status">{freshness.state === 'cached' ? (zh ? '使用已验证缓存，暂时无法刷新。' : 'Showing verified cache; refresh unavailable.') : freshness.detail ?? (zh ? '暂时无法读取最新状态。' : 'Current state is unavailable.')} <button type="button" onClick={onRetry}>{zh ? '重试' : 'Retry'}</button></div> : null}
    {awaiting || unavailable ? <div className="tsui-empty" role="status">{awaiting ? (zh ? '正在确认最新状态…' : 'Checking the latest state…') : (zh ? '暂时无法确认今天，请重试。' : 'Today is unavailable; please retry.')}</div> : <>
      <div className="tsui-mobile-switch" role="group" aria-label={zh ? '今天内容' : 'Today content'}><button type="button" className={mobileView === 'tasks' ? 'active' : ''} onClick={() => setMobileView('tasks')}>{zh ? '任务' : 'Tasks'} <span>{selection.actionCount + selection.decisionCount}</span></button><button type="button" className={mobileView === 'nodes' ? 'active' : ''} onClick={() => setMobileView('nodes')}>{zh ? '节点' : 'Nodes'} <span>{stream.counts.upcoming}</span></button></div>
      <div className="tsui-today-grid">
        <section className={'tsui-panel tsui-task-panel' + (mobileView === 'nodes' ? ' mobile-hidden' : '') + (selection.actionCount + selection.decisionCount <= 1 ? ' is-sparse' : '')} aria-label={zh ? '今天的任务' : 'Tasks for today'}>
          <div className="tsui-panel-header"><div><h2>{zh ? '今日任务' : 'Today’s tasks'} <span className="tsui-count">{selection.actionCount + selection.decisionCount}</span></h2></div></div>
          {selection.overBudgetMinutes > 0 ? <div className="tsui-inline-notice" role="status">{zh ? '今天的硬截止与可用时间可能冲突；请先查看有明确时间的事项。' : 'Time commitments may exceed today’s available time. Review timed items first.'}</div> : null}
          {selection.actions.length === 0 && selection.decisions.length === 0 ? <div className="tsui-empty">{workspaceEmpty ? <><strong>{zh ? '先让 PJSDAS 了解你的求职进展' : 'Start by adding your job search'}</strong><button type="button" onClick={onStart}>{zh ? '打开设置' : 'Open settings'}</button></> : <strong>{zh ? '现在没有必须处理的任务' : 'Nothing requires action right now'}</strong>}</div> : null}
          <div className="tsui-task-list">
            {selection.decisions.map((item) => <article className="tsui-task-row" data-icon="?" key={item.id}><div className="tsui-task-copy"><small>{zh ? '需要你决定' : 'Decision needed'}</small><strong>{item.request.question}</strong></div><button className="tsui-row-action" type="button" onClick={() => onOpenDecision(item.request.id)}>{zh ? '处理' : 'Review'}</button></article>)}
            {selection.actions.map((item) => <article className="tsui-task-row" key={item.actionId} data-action-id={item.actionId} data-icon={item.company?.slice(0, 1) ?? '✓'}><div className="tsui-task-copy">{item.opportunityId ? <button className="tsui-task-context" type="button" onClick={() => onOpenOpportunity(item.opportunityId!)}>{[item.company, item.role].filter(Boolean).join(' · ')}</button> : <small>{zh ? '独立任务' : 'Independent task'}</small>}<h3>{item.title}</h3><span>{timeLabel(item, zh)}</span></div><div className="tsui-task-actions"><button className="tsui-row-action" type="button" disabled={!!pendingId || readOnly} onClick={() => { void act(item.actionId, () => onExecute(item)) }}>{actionLabel(item, zh)}</button><button className={item.kind === 'apply' ? 'tsui-done-action tsui-submission-action' : 'tsui-done-action'} type="button" disabled={!!pendingId || readOnly} onClick={() => { void act(item.actionId, () => onMark(item.actionId, 'done')) }}>{pendingId === item.actionId ? (zh ? '处理中…' : 'Working…') : (item.kind === 'apply' ? (zh ? '我已投递' : 'I applied') : (zh ? '完成' : 'Done'))}</button></div></article>)}
          </div>
          {completedToday.length > 0 ? <section className="tsui-completed"><button type="button" aria-expanded={showCompleted} onClick={() => setShowCompleted((value) => !value)}>{zh ? '今日已完成' : 'Completed today'} · {completedToday.length} <span>{showCompleted ? '⌃' : '⌄'}</span></button>{showCompleted ? completedToday.map((entry) => <div key={entry.id}>{entry.title}</div>) : null}</section> : null}
          {selection.decisionCount > 0 ? <button type="button" className="tsui-all-decisions" onClick={onOpenDecisions}>{zh ? '查看全部待决定事项' : 'View all decisions'}</button> : null}
        </section>
        <aside className={'tsui-panel tsui-node-panel' + (mobileView === 'tasks' ? ' mobile-hidden' : '') + (stream.counts.upcoming === 0 ? ' is-empty' : '')} aria-label={zh ? '近期节点' : 'Upcoming nodes'}><div className="tsui-panel-header"><div><h2>{zh ? '近期节点' : 'Upcoming nodes'}</h2><p>{zh ? '面试、笔试与真实截止时间' : 'Interviews, tests and real deadlines'}</p></div><button type="button" className="tsui-panel-link" onClick={onOpenAgenda}>{zh ? '打开日程' : 'Open schedule'} ›</button></div>{stream.counts.unresolved > 0 ? <button type="button" className="tsui-unresolved-link" onClick={onOpenUnresolved}>{zh ? '↶ ' + stream.counts.unresolved + ' 项过去安排待确认' : '↶ ' + stream.counts.unresolved + ' past items to resolve'} <span aria-hidden="true">›</span></button> : null}<div className="tsui-node-scroll"><ScheduleWindowList key={stream.key} stream={stream} section="upcoming" opportunities={opportunities} onOpenOpportunity={onOpenOpportunity} /></div></aside>
      </div>
    </>}
  </section>
}

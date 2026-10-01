import { presentDecision } from '../decisionPresentation.js'
import { formatScheduleTemporal } from '../scheduleDisplayTime.js'
import { useEffect, useState } from 'react'
import type { Action, Opportunity } from '../model.js'
import { localDateKey, type TodayBriefAction } from '../todayBrief.js'
import type { TodayWebSelection } from './todayWebSelector.js'
import type { ScheduleStream } from '../schedule/scheduleStream.js'
import { ScheduleWindowList } from '../schedule/ScheduleFeature.js'
import { useUiLanguage } from '../uiLanguage.js'
import './today.css'
import { hasRepeatedApplicationContext } from './taskContext.js'

export type TodayFreshnessState = 'local' | 'initial' | 'refreshing' | 'current' | 'updated' | 'cached' | 'blocked' | 'unavailable'
export interface TodayFreshnessView {
  state: TodayFreshnessState
  observedAt?: string
  latencyMs?: number
  detail?: string
}
interface TodayFeatureProps {
  selection: TodayWebSelection
  stream: ScheduleStream
  opportunities: Opportunity[]
  readOnly?: boolean
  now: Date
  workspaceEmpty: boolean
  freshness: TodayFreshnessView
  onStart: () => void
  onSetTodayCapacity: (minutes: number) => Promise<void>
  onRetry: () => void
  onOpenDecision: (id: string) => void
  onOpenAgenda: () => void
  onExecute: (item: TodayBriefAction) => Promise<void>
  onMark: (id: string, status: Action['status'], intent?: 'application_submission') => Promise<void>
  onOpenOpportunity: (id: string, opener?: HTMLElement) => void
}
function timeLabel(item: TodayBriefAction, zh: boolean, displayTimezone: string) {
  const timing = item.timing
  if (!timing) return zh ? '今天' : 'Today'
  if (timing.precision === 'date' && timing.date) return timing.date
  const at = timing.startAt ?? timing.deadlineAt
  if (!at) return zh ? '今天' : 'Today'
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return zh ? '时间待定' : 'Time TBD'
  const formatted = formatScheduleTemporal(timing, zh, displayTimezone)
  return timing.deadlineAt && !timing.startAt ? (zh ? '截止 ' : 'Due ') + formatted : formatted
}
function actionLabel(item: TodayBriefAction, zh: boolean) {
  if (item.execution.operation === 'open_application') return item.execution.externalUrl ? (zh ? '打开申请' : 'Open application') : (zh ? '查看岗位' : 'View job')
  if (item.execution.operation === 'start_prep') return zh ? '开始准备' : 'Start prep'
  if (item.execution.operation === 'open_process') return zh ? '查看流程' : 'View process'
  return !item.opportunityId && item.execution.operation === 'open_action' ? (zh ? '开始' : 'Start') : (zh ? '查看' : 'Open')
}
export default function TodayFeature({ selection, stream, opportunities, readOnly = false, now, workspaceEmpty, freshness, onStart, onSetTodayCapacity, onRetry, onOpenDecision, onOpenAgenda, onExecute, onMark, onOpenOpportunity }: TodayFeatureProps) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [mobileView, setMobileView] = useState<'tasks' | 'nodes'>('tasks')
  const [pendingId, setPendingId] = useState<string>()
  const [showCompleted, setShowCompleted] = useState(false)
  const [capacityHours, setCapacityHours] = useState(selection.capacityMinutes === undefined ? '' : String(selection.capacityMinutes / 60))
  const [capacitySaving, setCapacitySaving] = useState(false)
  const [capacityError, setCapacityError] = useState('')
  useEffect(() => { setCapacityHours(selection.capacityMinutes === undefined ? '' : String(selection.capacityMinutes / 60)) }, [selection.capacityMinutes])
  const zhDateParts = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', timeZone: stream.timezone }).formatToParts(now)
  const date = zh
    ? `${zhDateParts.find((part) => part.type === 'month')?.value ?? ''}月${zhDateParts.find((part) => part.type === 'day')?.value ?? ''}日 · ${new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: stream.timezone }).format(now)}`
    : new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric', weekday: 'short', timeZone: stream.timezone }).format(now)
  const todayKey = localDateKey(now, stream.timezone)
  const completedToday = stream.sections.history.filter((item) => item.date === todayKey && (item.state === 'completed' || item.timeline?.kind === 'action_status_changed'))
  const awaiting = freshness.state === 'initial' && workspaceEmpty
  const unavailable = freshness.state === 'unavailable' && workspaceEmpty
  const verifiedEmpty = workspaceEmpty && (freshness.state === 'current' || freshness.state === 'updated')
  const uncertainEmpty = freshness.state === 'cached' || freshness.state === 'blocked'
  const fixedConflict = selection.businessConflicts.find(item => item.kind === 'fixed_overlap')
  const deadlineConflict = selection.businessConflicts.find(item => item.kind === 'hard_deadline_capacity')
  const selectedHard = selection.actions.filter(item => deadlineConflict?.selectedIds?.includes(item.actionId))
  const notSelectedHard = selection.notSelectedHardActions ?? []
  const tradeoffLabel = (item: TodayBriefAction) => [item.company, item.role].filter(Boolean).join(' · ')
    ? `${[item.company, item.role].filter(Boolean).join(' · ')}：${item.title}` : item.title
  const dueToday = (item: TodayBriefAction) => item.timing?.precision === 'date' ? item.timing.date === todayKey
    : Boolean(item.timing?.deadlineAt && localDateKey(new Date(item.timing.deadlineAt), selection.displayTimezone) === todayKey)
  const fixedNotice = fixedConflict ? <div className="tsui-inline-notice tsui-deadline-notice" role="status"><strong>{zh ? '两个固定安排时间冲突。' : 'Two fixed commitments overlap.'}</strong> <span>{fixedConflict.relatedIds.map(id => stream.sections.upcoming.find(entry => entry.nodeId === id)?.title ?? id).join(' · ')}</span> <button type="button" onClick={onOpenAgenda}>{zh ? '查看相关安排' : 'Review commitments'}</button></div> : null
  const deadlineNotice = deadlineConflict ? <div className="tsui-inline-notice tsui-deadline-notice" role="status">
    <strong>{zh ? '按剩余时间取舍硬截止事项' : 'Choose deadlines that fit the remaining time'}</strong>
    <p>{selectedHard.length ? (zh ? '剩余时间预计可完成：' : 'Expected to fit: ') + selectedHard.map(tradeoffLabel).join('、')
      : (zh ? '按当前剩余时间，没有可完整完成的硬截止任务。' : 'No complete deadline task fits the remaining time.')}</p>
    <p>{zh ? '以下事项未选入今天：' : 'Not selected for today: '}</p>
    <ul>{notSelectedHard.map(item => <li key={item.actionId}>
      <button type="button" data-deferred-action-id={item.actionId} onClick={event => item.opportunityId ? onOpenOpportunity(item.opportunityId, event.currentTarget) : onOpenAgenda()}>{tradeoffLabel(item)}</button>
      {' · '}{dueToday(item) ? (zh ? '建议放弃本次截止' : 'Consider skipping this deadline') : (zh ? '需调整安排或放弃本次截止' : 'Reschedule the work or skip this deadline')}
    </li>)}</ul>
    <button type="button" onClick={onOpenAgenda}>{zh ? '查看相关安排' : 'Review commitments'}</button>
  </div> : null
  async function act(id: string, operation: () => Promise<void>) {
    setPendingId(id)
    try { await operation() } finally { setPendingId(undefined) }
  }
  return <section className="tsui-today" data-testid="cgr02-today">
    <header className="tsui-page-heading"><div><p>{date}</p><h1>{zh ? '今天' : 'Today'}</h1><span>{zh ? '把今天该做的事，一件件做好。' : 'Make progress on what matters today.'}</span></div>
      <details className="tsui-capacity"><summary>{selection.capacityMinutes === undefined ? (zh ? '设置今天可用时间' : 'Set today’s available time') : (zh ? `今天可用 ${selection.capacityMinutes / 60} 小时 · 调整` : `${selection.capacityMinutes / 60} hours available · Adjust`)}</summary><form onSubmit={event => { event.preventDefault(); const minutes = Math.round(Number(capacityHours) * 60); setCapacitySaving(true); setCapacityError(''); const editor = event.currentTarget.closest('details'); void onSetTodayCapacity(minutes).then(() => { if (editor) editor.open = false }).catch(caught => setCapacityError(caught instanceof Error ? caught.message : String(caught))).finally(() => setCapacitySaving(false)) }}><label>{zh ? '今天可用小时' : 'Hours available today'} <input type="number" min="0" max="24" step="0.5" required value={capacityHours} onChange={event => setCapacityHours(event.target.value)} /></label><button type="submit" disabled={capacitySaving || readOnly}>{capacitySaving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}</button>{capacityError ? <span role="alert">{capacityError}</span> : null}</form></details>
    </header>
    {readOnly ? <div className="tsui-alert" role="alert">{zh ? '今天暂时只读；已有记录和回执保留。' : 'Today is temporarily read only; existing records and receipts are retained.'}</div> : null}
    {freshness.state === 'cached' ? <p className="tsui-freshness-note">{zh ? '显示已保存记录，等待更新。' : 'Showing saved records while updates are unavailable.'}</p> : null}
    {freshness.state === 'blocked' || (freshness.state === 'unavailable' && !workspaceEmpty) ? <div className="tsui-status tsui-compact-state" role="status">{freshness.state === 'blocked' ? (zh ? '本机状态待核对' : 'Review this device’s sync state') : (zh ? '暂时无法读取最新状态' : 'Latest state unavailable')} <button type="button" onClick={freshness.state === 'blocked' ? onStart : onRetry}>{freshness.state === 'blocked' ? (zh ? '打开设置' : 'Open settings') : (zh ? '重试' : 'Retry')}</button></div> : null}
    {awaiting || unavailable ? <div className="tsui-empty" role="status">{awaiting ? (zh ? '正在确认最新状态…' : 'Checking the latest state…') : <>{zh ? '暂时无法确认今天。' : 'Today is unavailable.'} <button type="button" onClick={onRetry}>{zh ? '重试' : 'Retry'}</button></>}</div> : <>
      <div className="tsui-mobile-switch" role="group" aria-label={zh ? '今天内容' : 'Today content'}><button type="button" className={mobileView === 'tasks' ? 'active' : ''} onClick={() => setMobileView('tasks')}>{zh ? '任务' : 'Tasks'} <span>{selection.actionCount + selection.decisionCount}</span></button><button type="button" className={mobileView === 'nodes' ? 'active' : ''} onClick={() => setMobileView('nodes')}>{zh ? '节点' : 'Nodes'} <span>{stream.counts.upcoming}</span></button></div>
      <div className="tsui-today-grid">
        <section className={'tsui-panel tsui-task-panel' + (mobileView === 'nodes' ? ' mobile-hidden' : '') + (selection.actionCount + selection.decisionCount <= 1 ? ' is-sparse' : '')} aria-label={zh ? '今天的任务' : 'Tasks for today'}>
          <div className="tsui-panel-header"><div><h2>{zh ? '今日任务' : 'Today’s tasks'} <span className="tsui-count">{selection.actionCount + selection.decisionCount}</span></h2></div></div>
          {deadlineNotice}
          {selection.actions.length === 0 && selection.decisions.length === 0 ? <div className="tsui-empty">{uncertainEmpty ? <><strong>{zh ? '现有记录中没有今日任务' : 'No today tasks in the available records'}</strong><p>{freshness.state === 'cached' ? (zh ? '已保存记录中暂无今日任务；联网后会自动更新。' : 'No tasks in saved records; this updates when connected.') : (zh ? '本机状态待核对，请从上方进入设置。' : 'Review this device’s state in Settings above.')}</p></> : workspaceEmpty ? <><strong>{verifiedEmpty ? (zh ? '账号工作区已读取，目前没有今日任务' : 'Account workspace checked; no tasks for today') : (zh ? '先让 TodayAction 了解你的求职进展' : 'Start by adding your job search')}</strong><p>{verifiedEmpty ? (zh ? '可以记录新的进展，或在设置中检查连接。' : 'Record new progress or check your connections in Settings.') : (zh ? '在设置中连接已有账号，或使用上方“告诉 TodayAction”记录进展。' : 'Connect your existing account in Settings or record progress with Tell TodayAction above.')}</p><button type="button" onClick={onStart}>{zh ? '打开设置' : 'Open settings'}</button></> : <strong>{zh ? '现在没有必须处理的任务' : 'Nothing requires action right now'}</strong>}</div> : null}
          <div className="tsui-task-list">
            {selection.decisions.map((item) => <article className="tsui-task-row" data-icon="?" key={item.id}><div className="tsui-task-copy"><small>{zh ? '需要你决定' : 'Decision needed'}</small><strong>{presentDecision(item.request, opportunities, zh).title}</strong><span>{presentDecision(item.request, opportunities, zh).context}</span><span>{presentDecision(item.request, opportunities, zh).explanation}</span></div><button className="tsui-row-action" type="button" onClick={() => onOpenDecision(item.request.id)}>{zh ? '处理' : 'Review'}</button></article>)}
            {selection.actions.map((item) => <article className="tsui-task-row" key={item.actionId} data-action-id={item.actionId} data-icon={item.company?.slice(0, 1) ?? '✓'}><div className="tsui-task-copy">{item.opportunityId ? !hasRepeatedApplicationContext(item) ? <button className="tsui-task-context" type="button" onClick={event => onOpenOpportunity(item.opportunityId!, event.currentTarget)}>{[item.company, item.role].filter(Boolean).join(' · ')}</button> : null : <small>{zh ? '独立任务' : 'Independent task'}</small>}<h3>{item.title}</h3><span>{timeLabel(item, zh, selection.displayTimezone)}</span></div><div className="tsui-task-actions"><button className="tsui-row-action" type="button" disabled={pendingId === item.actionId || readOnly} onClick={() => { void act(item.actionId, () => onExecute(item)) }}>{actionLabel(item, zh)}</button><button className={item.kind === 'apply' ? 'tsui-done-action tsui-submission-action' : 'tsui-done-action'} type="button" disabled={pendingId === item.actionId || readOnly} onClick={() => { void act(item.actionId, () => onMark(item.actionId, 'done', item.kind === 'apply' ? 'application_submission' : undefined)) }}>{pendingId === item.actionId ? (zh ? '处理中…' : 'Working…') : (item.kind === 'apply' ? (zh ? '我已投递' : 'I applied') : (zh ? '完成' : 'Done'))}</button></div></article>)}
          </div>
          {completedToday.length > 0 ? <section className="tsui-completed"><button type="button" aria-expanded={showCompleted} onClick={() => setShowCompleted((value) => !value)}>{zh ? '今日已完成' : 'Completed today'} · {completedToday.length} <span>{showCompleted ? '⌃' : '⌄'}</span></button>{showCompleted ? completedToday.map((entry) => <div key={entry.id}>{entry.title}</div>) : null}</section> : null}
        </section>
        <aside className={'tsui-panel tsui-node-panel' + (mobileView === 'tasks' ? ' mobile-hidden' : '') + (stream.counts.upcoming === 0 ? ' is-empty' : '')} aria-label={zh ? '近期节点' : 'Upcoming nodes'}>
          <div className="tsui-panel-header"><div><h2>{zh ? '近期节点' : 'Upcoming nodes'}</h2><p>{zh ? '面试、笔试与真实截止时间' : 'Interviews, tests and real deadlines'}</p></div><button type="button" className="tsui-panel-link" onClick={onOpenAgenda}>{zh ? '打开日程' : 'Open schedule'} ›</button></div>
          {fixedNotice}
          <div className="tsui-node-scroll"><ScheduleWindowList key={stream.key} stream={stream} section="upcoming" opportunities={opportunities} onOpenOpportunity={onOpenOpportunity} /></div>
        </aside>
      </div>
    </>}
  </section>
}

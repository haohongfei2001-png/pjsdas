import { useUiLanguage } from '../uiLanguage.js'
import { presentRankingReasons } from '../rankingReasonPresentation.js'
import type { Action } from '../model.js'
import type {
  TodayBrief,
  TodayBriefAction,
  TodayBriefAgendaNode,
  TodayBriefRecentChange,
} from '../todayBrief.js'
import './today.css'

export type TodayFreshnessState = 'local' | 'initial' | 'refreshing' | 'current' | 'updated' | 'cached' | 'blocked'

export interface TodayFreshnessView {
  state: TodayFreshnessState
  observedAt?: string
  latencyMs?: number
  detail?: string
}

interface TodayFeatureProps {
  brief: TodayBrief
  now: Date
  budgetMinutes: number
  agendaExpanded: boolean
  workspaceEmpty: boolean
  freshness: TodayFreshnessView
  onBudgetChange: (minutes: number) => void
  onStart: () => void
  onOpenDecisions: () => void
  onOpenAgenda: () => void
  onExecute: (item: TodayBriefAction) => Promise<void>
  onMark: (id: string, status: Action['status']) => Promise<void>
  onOpenOpportunity: (id: string) => void
}

function formatDateOnly(iso: string, zh: boolean) {
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(iso))
}

function formatMinutes(minutes: number, zh: boolean) {
  if (minutes < 60) return zh ? `${minutes} 分钟` : `${minutes} min`
  const hours = minutes / 60
  const value = Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
  return zh ? `${value} 小时` : `${value} hr`
}

function formatBriefDateTime(value: string, zh: boolean) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function relativeReceiptTime(value: string, now: Date, zh: boolean) {
  const delta = Math.max(0, now.getTime() - new Date(value).getTime())
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return zh ? '刚刚' : 'just now'
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`
  return formatDateOnly(value, zh)
}

function agendaGroupTitle(relation: 'unresolved' | 'today' | 'tomorrow' | 'later', date: string | undefined, zh: boolean) {
  if (relation === 'unresolved') return zh ? '已过时间 · 待确认' : 'Past · needs resolution'
  if (relation === 'today') return zh ? '今天' : 'Today'
  if (relation === 'tomorrow') return zh ? '明天' : 'Tomorrow'
  return date ?? (zh ? '之后' : 'Later')
}

function agendaNodeLabel(kind: TodayBriefAgendaNode['kind'], zh: boolean) {
  const labels: Record<TodayBriefAgendaNode['kind'], [string, string]> = {
    interview: ['面试', 'Interview'],
    written_test: ['笔试', 'Written test'],
    assessment: ['测评', 'Assessment'],
    application_deadline: ['申请截止', 'Application deadline'],
    follow_up: ['复核', 'Follow-up'],
    prep_trigger: ['准备节点', 'Prep trigger'],
  }
  return labels[kind][zh ? 0 : 1]
}

function agendaNodeTime(node: TodayBriefAgendaNode, zh: boolean) {
  const temporal = node.temporal
  if (temporal.precision === 'date' && temporal.date) return temporal.date
  if (temporal.shape === 'availability_window' && temporal.startAt && temporal.endAt) {
    return (zh ? '可参加 ' : 'Available ') + formatBriefDateTime(temporal.startAt, zh) + ' – ' + formatBriefDateTime(temporal.endAt, zh)
  }
  if (temporal.startAt) return formatBriefDateTime(temporal.startAt, zh)
  if (temporal.deadlineAt) return (zh ? '截止 ' : 'By ') + formatBriefDateTime(temporal.deadlineAt, zh)
  if (temporal.endAt) return formatBriefDateTime(temporal.endAt, zh)
  return zh ? '时间待定' : 'Time TBD'
}

function actionTiming(item: TodayBriefAction, zh: boolean) {
  const timing = item.timing
  if (!timing) return undefined
  if (timing.precision === 'date' && timing.date) return (zh ? '日期：' : 'Date: ') + timing.date
  if (timing.startAt) return (zh ? '开始：' : 'Starts: ') + formatBriefDateTime(timing.startAt, zh)
  if (timing.deadlineAt) return (zh ? '截止：' : 'Deadline: ') + formatBriefDateTime(timing.deadlineAt, zh)
  return undefined
}

function freshnessCopy(freshness: TodayFreshnessView, zh: boolean) {
  if (freshness.state === 'local') return { label: zh ? '本机模式' : 'Local mode', tone: 'neutral' }
  if (freshness.state === 'initial') return { label: zh ? '正在确认最新状态' : 'Checking latest state', tone: 'working' }
  if (freshness.state === 'refreshing') return { label: zh ? '正在刷新' : 'Refreshing', tone: 'working' }
  if (freshness.state === 'updated') return { label: zh ? '刚刚同步到最新' : 'Updated just now', tone: 'good' }
  if (freshness.state === 'current') {
    const suffix = freshness.latencyMs !== undefined ? ` · ${freshness.latencyMs}ms` : ''
    return { label: (zh ? '已是最新' : 'Up to date') + suffix, tone: 'good' }
  }
  if (freshness.state === 'blocked') return { label: zh ? '本机有未合并变化' : 'Local changes need attention', tone: 'warning' }
  return { label: zh ? '使用缓存 · 暂时无法刷新' : 'Cached · refresh unavailable', tone: 'warning' }
}

function primaryLabel(item: TodayBriefAction, zh: boolean) {
  if (item.execution.operation === 'open_application') {
    return item.execution.externalUrl ? (zh ? '打开申请' : 'Open application') : (zh ? '查看岗位' : 'View opportunity')
  }
  if (item.execution.operation === 'start_prep') return zh ? '开始准备' : 'Start prep'
  if (item.execution.operation === 'open_process') return zh ? '查看流程' : 'Open process'
  if (item.execution.operation === 'open_group_decision') return zh ? '比较机会' : 'Compare opportunities'
  return zh ? '开始' : 'Start'
}

function recentChangeState(item: TodayBriefRecentChange, zh: boolean) {
  if (item.status === 'undone') return zh ? '已撤销' : 'Undone'
  if (item.status === 'decision_required') return zh ? '待你决定' : 'Needs decision'
  return zh ? '已处理' : 'Handled'
}

export default function TodayFeature({
  brief,
  now,
  budgetMinutes,
  agendaExpanded,
  workspaceEmpty,
  freshness,
  onBudgetChange,
  onStart,
  onOpenDecisions,
  onOpenAgenda,
  onExecute,
  onMark,
  onOpenOpportunity,
}: TodayFeatureProps) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const primary = brief.nextAction
  const criticalWarnings = brief.materialCoverageWarnings.filter((item) => item.severity === 'critical')
  const coverageWarnings = brief.materialCoverageWarnings.filter((item) => item.severity !== 'critical')
  const fresh = freshnessCopy(freshness, zh)
  const awaitingServer = freshness.state === 'initial' && workspaceEmpty

  function reasonText(item: TodayBriefAction) {
    return item.whyNow.length
      ? presentRankingReasons(item.whyNow, zh).join(' · ')
      : (zh ? '当前最值得处理' : 'Highest-value next move')
  }

  return (
    <section className="cgr-today" data-testid="cgr02-today">
      <header className="cgr-today-header">
        <div>
          <div className="cgr-kicker">{formatDateOnly(now.toISOString(), zh)}</div>
          <h1>{zh ? '今天' : 'Today'}</h1>
          <p>{zh ? '先做最重要的一件事。接下来的面试、笔试和截止时间都在旁边。' : 'Start with the most important next move. Interviews, tests, and deadlines stay alongside it.'}</p>
        </div>
        <div className="cgr-today-header-actions">
          <span className={`cgr-freshness tone-${fresh.tone}`} title={freshness.detail}>{fresh.label}</span>
          {brief.relevantDecisionRequests.length > 0 ? (
            <button className="cgr-decision-entry" type="button" onClick={onOpenDecisions}>
              <span>{zh ? '需要你决定' : 'Needs your decision'}</span>
              <strong>{brief.relevantDecisionRequests.length}</strong>
            </button>
          ) : null}
        </div>
      </header>

      {criticalWarnings.length ? (
        <div className="cgr-critical-stack" role="status">
          {criticalWarnings.map((item) => (
            <div className="cgr-critical-warning" key={item.code}>
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="cgr-today-grid">
        <main className="cgr-focus-column">
          {awaitingServer ? (
            <div className="cgr-today-loading" role="status" aria-live="polite">
              <span className="cgr-loading-mark" aria-hidden="true" />
              <div><strong>{zh ? '正在确认服务器里的最新 Today' : 'Checking your latest Today'}</strong><small>{zh ? '不会先闪现“没有任务”的空状态。' : 'PJSDAS will not flash a false empty state first.'}</small></div>
            </div>
          ) : primary ? (
            <article className="cgr-primary-action">
              <div className="cgr-kicker">{zh ? '下一步' : 'NEXT ACTION'}</div>
              {primary.company ? <div className="cgr-action-context">{primary.company}{primary.role ? ' · ' + primary.role : ''}</div> : null}
              <h2>{primary.title}</h2>
              <p className="cgr-action-reason">{reasonText(primary)}</p>
              <div className="cgr-action-meta">
                {actionTiming(primary, zh) ? <span>{actionTiming(primary, zh)}</span> : null}
                <span>{zh ? '预计 ' : 'Est. '}{formatMinutes(primary.estimatedMinutes, zh)}</span>
                {primary.protectedByLatestStart ? <strong>{zh ? '已进入最迟开工保护' : 'Latest-start protected'}</strong> : null}
              </div>
              <div className="cgr-action-controls">
                <button className="cgr-primary-button" type="button" onClick={() => { void onExecute(primary) }}>{primaryLabel(primary, zh)}</button>
                <button className="cgr-secondary-button" type="button" onClick={() => { void onMark(primary.actionId, 'done') }}>{zh ? '标记完成' : 'Mark done'}</button>
                {primary.opportunityId ? (
                  <button className="cgr-text-button" type="button" onClick={() => onOpenOpportunity(primary.opportunityId!)}>{zh ? '岗位详情' : 'Opportunity'}</button>
                ) : null}
              </div>
            </article>
          ) : workspaceEmpty ? (
            <article className="cgr-quiet-card">
              <div className="cgr-kicker">{zh ? '开始' : 'GET STARTED'}</div>
              <h2>{zh ? '先让 PJSDAS 知道你的求职现状' : 'Give PJSDAS your current job-search state'}</h2>
              <p>{zh ? '连接来源，或导入现有求职表。Today 只会显示有依据的下一步，不会为了填满页面制造任务。' : 'Connect a source or import your existing job-search workbook. Today only shows grounded next moves.'}</p>
              <button className="cgr-primary-button" type="button" onClick={onStart}>{zh ? '打开设置' : 'Open settings'}</button>
            </article>
          ) : (
            <div className="cgr-quiet-card">
              <strong>{zh ? '现在没有必须处理的行动' : 'Nothing requires action right now'}</strong>
              <span>{zh ? '这是正常状态。未来节点仍保留在近期日程里。' : 'That is a valid state. Upcoming recruiting commitments remain visible in the agenda.'}</span>
            </div>
          )}

          <section className="cgr-next-section" aria-labelledby="today-next-up">
            <div className="cgr-section-head">
              <div><div className="cgr-kicker">NEXT UP</div><h2 id="today-next-up">{zh ? '接下来' : 'Next up'}</h2></div>
              <div className="cgr-budget" role="group" aria-label={zh ? '今日可用时间' : 'Available time today'}>
                {[60, 180, 360].map((value) => (
                  <button key={value} type="button" className={budgetMinutes === value ? 'active' : ''} onClick={() => onBudgetChange(value)}>
                    {formatMinutes(value, zh)}
                  </button>
                ))}
              </div>
            </div>
            {brief.nextActions.length ? (
              <div className="cgr-next-list">
                {brief.nextActions.map((item, index) => (
                  <article className="cgr-next-row" key={item.actionId}>
                    <span className="cgr-order">{index + 2}</span>
                    <button className="cgr-next-copy" type="button" onClick={() => { void onExecute(item) }}>
                      <strong>{item.title}</strong><small>{reasonText(item)}</small>
                    </button>
                    <div className="cgr-next-meta">
                      {actionTiming(item, zh) ? <span>{actionTiming(item, zh)}</span> : null}
                      <span>{formatMinutes(item.estimatedMinutes, zh)}</span>
                    </div>
                    <button className="cgr-done-button" type="button" onClick={() => { void onMark(item.actionId, 'done') }}>{zh ? '完成' : 'Done'}</button>
                  </article>
                ))}
              </div>
            ) : <p className="cgr-section-empty">{zh ? '没有第二优先级任务。' : 'No secondary action needs your time.'}</p>}
          </section>

          {brief.recentChanges.length ? (
            <section className="cgr-recent-section" aria-labelledby="today-recent">
              <div className="cgr-section-head"><div><div className="cgr-kicker">RECENT</div><h2 id="today-recent">{zh ? 'PJSDAS 刚处理的变化' : 'Recently handled'}</h2></div></div>
              <div className="cgr-recent-list">
                {brief.recentChanges.map((item) => (
                  <article key={item.id} className="cgr-recent-row">
                    <div><strong>{item.summary}</strong><small>{relativeReceiptTime(item.updatedAt, now, zh)}</small></div>
                    <span>{recentChangeState(item, zh)}</span>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </main>

        <aside className="cgr-agenda" aria-label={zh ? '近期招聘日程' : 'Upcoming recruiting agenda'}>
          <div className="cgr-section-head">
            <div><div className="cgr-kicker">AGENDA</div><h2>{agendaExpanded ? (zh ? '未来 30 天' : 'Next 30 days') : (zh ? '近期节点' : 'Upcoming')}</h2></div>
            <button className="cgr-text-button" type="button" onClick={onOpenAgenda}>{agendaExpanded ? (zh ? '收起' : 'Summary') : (zh ? '全部日程' : 'All schedule')}</button>
          </div>
          {brief.agendaGroups.length ? (
            <div className="cgr-agenda-groups">
              {brief.agendaGroups.map((group) => (
                <section className={`cgr-agenda-group relation-${group.relation}`} key={group.key}>
                  <h3>{agendaGroupTitle(group.relation, group.date, zh)}</h3>
                  <div>
                    {group.nodes.map((node) => (
                      <button
                        className={`cgr-agenda-node${node.requiresResolution ? ' unresolved' : ''}`}
                        type="button"
                        key={node.nodeId}
                        onClick={() => { if (node.opportunityId) onOpenOpportunity(node.opportunityId) }}
                      >
                        <span className="cgr-agenda-time">{agendaNodeTime(node, zh)}</span>
                        <span className="cgr-agenda-copy"><strong>{agendaNodeLabel(node.kind, zh)}</strong><small>{[node.company, node.role].filter(Boolean).join(' · ') || (zh ? '招聘节点' : 'Recruiting node')}</small></span>
                        <span className="cgr-agenda-state">{node.requiresResolution ? (zh ? '待确认' : 'Resolve') : node.within48Hours ? (zh ? '48h 内' : '<48h') : ''}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="cgr-agenda-empty"><strong>{zh ? '近期没有招聘时间节点' : 'No recruiting nodes coming up'}</strong><span>{zh ? '这里不会显示普通日历事件。' : 'General calendar events do not appear here.'}</span></div>
          )}
        </aside>
      </div>

      {coverageWarnings.length ? (
        <details className="cgr-coverage-details">
          <summary>{zh ? '数据覆盖提示' : 'Coverage notes'} · {coverageWarnings.length}</summary>
          <div>{coverageWarnings.map((item) => <p key={item.code}><strong>{item.title}</strong><span>{item.detail}</span></p>)}</div>
        </details>
      ) : null}
    </section>
  )
}

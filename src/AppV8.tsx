import { useEffect, useMemo, useState } from 'react'
import {
  applyActionStatusChangeSet,
  exportLocalSnapshot,
  replaceImportedData,
} from './db.js'
import { computePriority } from './decisionV3.js'
import { parsePJSDASWorkbook } from './importExcelV2.js'
import { prepPriorityRank, presentPrepPriority, presentPrepSourceState } from './prepSemantics.js'
import { presentStageLabel } from './stagePresentation.js'
import { presentRankingReasons } from './rankingReasonPresentation.js'
import { currentUiLanguage, useUiLanguage } from './uiLanguage.js'
import { DEFAULT_DECISION_RULES, type DecisionRules } from './decisionRules.js'
import RulesView from './RulesView.js'
import TimelineView from './TimelineView.js'
import CloudSettingsCard from './cloud/CloudSettingsCard.js'
import { useCloud } from './cloud/CloudContext.js'
import { ensureAuthoritativePersistence } from './cloud/authoritativePersistence.js'
import DiscoveryProfileCard from './DiscoveryProfileCard.js'
import ApplicationPortfolioDock from './ApplicationPortfolioDock.js'
import PrepGraphDock from './PrepGraphDock.js'
import ProcessEventDock from './ProcessEventDock.js'
import LocalBackupDock from './LocalBackupDock.js'
import ConnectedMigrationCard from './cloud/ConnectedMigrationCard.js'
import OriginTransitionNotice from './OriginTransitionNotice.js'
import OpportunityDetailDrawer, { type OpportunityDetailDestination } from './OpportunityDetailDrawer.js'
import TellPjsdasCapture from './TellPjsdasCapture.js'
import DecisionRequestsView from './DecisionRequestsView.js'
import {
  buildTodayBrief,
  type TodayBrief as TodayBriefModel,
  type TodayBriefAction,
  type TodayBriefAgendaNode,
} from './todayBrief.js'
import type {
  Action,
  ApplicationGroup,
  ImportBundle,
  ImportMeta,
  Opportunity,
  Prep,
  ProcessRecord,
  TimelineRecord,
} from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import './timeplan.css'
import './surfaceConsolidation.css'
import './interactionDetail.css'
import './webConsole.css'
import './ultimateWeb.css'

type Surface = 'today' | 'opportunities' | 'decisions' | 'history' | 'settings'
type PrimarySurface = 'today' | 'opportunities'
type OpportunityTab = 'opportunities' | 'pipeline' | 'prepare'
type CompletionFeedback = { id: string; title: string; previousStatus: Action['status']; error?: string }
type RouteState = {
  surface: Surface
  capture: boolean
  agendaExpanded: boolean
  opportunityId?: string
}

const APP_BASE = import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '')

const surfaceLabels: Record<PrimarySurface, { zh: string; en: string; hintZh: string; hintEn: string }> = {
  today: { zh: '今天', en: 'Today', hintZh: '下一步', hintEn: 'Next' },
  opportunities: { zh: '机会', en: 'Opportunities', hintZh: '岗位与流程', hintEn: 'Jobs' },
}

const primarySurfaces: PrimarySurface[] = ['today', 'opportunities']

const roleLabels: Record<Opportunity['roleType'], [string, string]> = {
  core: ['核心', 'Core'],
  backup: ['保底', 'Backup'],
  reach: ['冲刺', 'Reach'],
  lottery: ['彩票', 'Long shot'],
  practice: ['练手', 'Practice'],
}

function semanticPath(pathname = window.location.pathname) {
  if (APP_BASE && pathname.startsWith(APP_BASE)) return pathname.slice(APP_BASE.length) || '/'
  return pathname || '/'
}

function browserPath(path: string) {
  return `${APP_BASE}${path}` || '/'
}

function routeFromPath(pathname = semanticPath()): RouteState {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/capture') return { surface: 'today', capture: true, agendaExpanded: false }
  if (path === '/decisions') return { surface: 'decisions', capture: false, agendaExpanded: false }
  if (path === '/settings') return { surface: 'settings', capture: false, agendaExpanded: false }
  if (path === '/history') return { surface: 'history', capture: false, agendaExpanded: false }
  if (path === '/today/agenda') return { surface: 'today', capture: false, agendaExpanded: true }
  if (path === '/today' || path === '/') return { surface: 'today', capture: false, agendaExpanded: false }
  if (path === '/opportunities') return { surface: 'opportunities', capture: false, agendaExpanded: false }
  const match = path.match(/^\/opportunities\/([^/]+)$/)
  if (match?.[1]) {
    return {
      surface: 'opportunities',
      capture: false,
      agendaExpanded: false,
      opportunityId: decodeURIComponent(match[1]),
    }
  }
  return { surface: 'today', capture: false, agendaExpanded: false }
}

function LanguageSwitch() {
  const { lang, setLang } = useUiLanguage()
  return (
    <div className="language-switch" role="group" aria-label="Interface language">
      <button className={lang === 'zh' ? 'active' : ''} onClick={() => setLang('zh')}>中文</button>
      <button className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
    </div>
  )
}

export default function AppV8() {
  const { lang } = useUiLanguage()
  const cloud = useCloud()
  const zh = lang === 'zh'
  const [route, setRoute] = useState<RouteState>(() => routeFromPath())
  const [captureReturnPath, setCaptureReturnPath] = useState('/today')
  const [opportunityTab, setOpportunityTab] = useState<OpportunityTab>('opportunities')
  const [opportunityTabExplicit, setOpportunityTabExplicit] = useState(false)
  const [lastCompletedAction, setLastCompletedAction] = useState<CompletionFeedback | null>(null)
  const [snapshot, setSnapshot] = useState<PJSDASSnapshot>()
  const [opportunities, setOpportunities] = useState<Opportunity[]>([])
  const [actions, setActions] = useState<Action[]>([])
  const [processes, setProcesses] = useState<ProcessRecord[]>([])
  const [prep, setPrep] = useState<Prep[]>([])
  const [groups, setGroups] = useState<ApplicationGroup[]>([])
  const [timeline, setTimeline] = useState<TimelineRecord[]>([])
  const [rules, setRules] = useState<DecisionRules>(() => ({ ...DEFAULT_DECISION_RULES, weights: { ...DEFAULT_DECISION_RULES.weights } }))
  const [lastImport, setLastImport] = useState<ImportMeta | undefined>()
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => new Date())
  const [budgetMinutes, setBudgetMinutes] = useState(180)

  const surface = route.surface
  const selectedOpportunityId = route.opportunityId
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  async function reload() {
    const next = await exportLocalSnapshot()
    setSnapshot(next)
    setOpportunities(next.data.opportunities)
    setActions(next.data.actions)
    setProcesses(next.data.processes)
    setPrep(next.data.prep)
    setGroups(next.data.applicationGroups)
    setRules(next.data.decisionRules ?? DEFAULT_DECISION_RULES)
    setTimeline(next.data.timeline ?? [])
    setLastImport(next.data.meta)
  }

  function navigate(path: string, replace = false) {
    const destination = browserPath(path)
    if (replace) window.history.replaceState(null, '', destination)
    else window.history.pushState(null, '', destination)
    setRoute(routeFromPath(path))
  }

  function openCapture() {
    const current = semanticPath()
    setCaptureReturnPath(current === '/capture' ? '/today' : current)
    navigate('/capture')
  }

  function closeCapture() {
    navigate(captureReturnPath || '/today', true)
  }

  useEffect(() => {
    if (semanticPath() === '/') {
      window.history.replaceState(null, '', browserPath('/today'))
      setRoute(routeFromPath('/today'))
    }
    void reload().finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    const refresh = () => { void reload() }
    const pop = () => setRoute(routeFromPath())
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openCapture()
      }
    }
    window.addEventListener('pjsdas:workspace-replaced', refresh)
    window.addEventListener('popstate', pop)
    window.addEventListener('keydown', keyboard)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pjsdas:workspace-replaced', refresh)
      window.removeEventListener('popstate', pop)
      window.removeEventListener('keydown', keyboard)
    }
  }, [route])

  useEffect(() => {
    if (!lastCompletedAction) return
    const timer = window.setTimeout(() => setLastCompletedAction(null), 8_000)
    return () => window.clearTimeout(timer)
  }, [lastCompletedAction])

  useEffect(() => {
    if (loading || opportunityTabExplicit) return
    const hasPipeline = processes.some((item) => ['screening', 'assessment', 'written_test', 'interview', 'offer'].includes(item.stage))
    setOpportunityTab(hasPipeline ? 'pipeline' : 'opportunities')
  }, [loading, opportunityTabExplicit, processes])

  const todayBrief = useMemo<TodayBriefModel | undefined>(() => {
    if (!snapshot) return undefined
    return buildTodayBrief(
      snapshot,
      { availableMinutes: budgetMinutes, agendaHorizonDays: route.agendaExpanded ? 30 : 7 },
      { now, timezone, workspaceVersion: `web:${snapshot.exportedAt}` },
    )
  }, [snapshot, budgetMinutes, route.agendaExpanded, now, timezone])

  const decisionRequests = snapshot?.data.decisionRequests ?? []
  const openDecisionCount = decisionRequests.filter((item) =>
    item.state === 'open' && (!item.expiresAt || new Date(item.expiresAt).getTime() >= now.getTime()),
  ).length
  const workspaceEmpty = opportunities.length === 0 && actions.length === 0 && processes.length === 0 && prep.length === 0
  const selectedOpportunity = selectedOpportunityId ? opportunities.find((item) => item.id === selectedOpportunityId) : undefined
  const selectedProcess = selectedOpportunity
    ? processes.find((item) => item.opportunityId === selectedOpportunity.id)
      ?? processes.find((item) => item.company === selectedOpportunity.company && item.role === selectedOpportunity.role)
    : undefined
  const selectedGroup = selectedOpportunity?.applicationGroupId
    ? groups.find((item) => item.id === selectedOpportunity.applicationGroupId)
    : undefined
  const selectedActions = selectedOpportunity
    ? actions.filter((item) => item.opportunityId === selectedOpportunity.id)
    : []
  const selectedTimeline = selectedOpportunity
    ? timeline.filter((item) => item.opportunityId === selectedOpportunity.id || (item.company === selectedOpportunity.company && item.role === selectedOpportunity.role))
    : []

  async function markAction(id: string, status: Action['status']) {
    const before = actions.find((item) => item.id === id)
    if (!before) return
    try {
      await applyActionStatusChangeSet(id, status)
      if (cloud.session) await ensureAuthoritativePersistence(true, cloud.syncNow)
      await reload()
      if (status === 'done' && before.status !== 'done') {
        setLastCompletedAction({ id: before.id, title: before.title, previousStatus: before.status })
      } else if (lastCompletedAction?.id === id) setLastCompletedAction(null)
    } catch (caught) {
      await reload()
      setLastCompletedAction({
        id: before.id,
        title: before.title,
        previousStatus: before.status,
        error: caught instanceof Error ? caught.message : String(caught),
      })
    }
  }

  async function undoLastCompletion() {
    const item = lastCompletedAction
    if (!item) return
    try {
      await applyActionStatusChangeSet(item.id, item.previousStatus)
      if (cloud.session) await ensureAuthoritativePersistence(true, cloud.syncNow)
      await reload()
      setLastCompletedAction(null)
    } catch (caught) {
      setLastCompletedAction({ ...item, error: caught instanceof Error ? caught.message : String(caught) })
    }
  }

  function chooseOpportunityTab(tab: OpportunityTab) {
    setOpportunityTabExplicit(true)
    setOpportunityTab(tab)
  }

  function navigateFromStart() {
    navigate('/settings')
  }

  function openOpportunity(id: string) {
    navigate('/opportunities/' + encodeURIComponent(id))
  }

  async function executeTodayAction(item: TodayBriefAction) {
    if (item.execution.externalUrl) {
      window.open(item.execution.externalUrl, '_blank', 'noopener,noreferrer')
      return
    }
    if (item.execution.operation === 'start_prep') {
      setOpportunityTabExplicit(true)
      setOpportunityTab('prepare')
      navigate('/opportunities')
      return
    }
    if (item.execution.operation === 'open_group_decision') {
      setOpportunityTabExplicit(true)
      setOpportunityTab('opportunities')
      navigate('/opportunities')
      return
    }
    if (item.opportunityId) {
      openOpportunity(item.opportunityId)
      return
    }
    await markAction(item.actionId, 'doing')
  }

  function navigateFromDetail(destination: OpportunityDetailDestination) {
    if (destination === 'today') navigate('/today')
    if (destination === 'prepare') {
      setOpportunityTabExplicit(true)
      setOpportunityTab('prepare')
      navigate('/opportunities')
    }
    if (destination === 'opportunities') {
      setOpportunityTabExplicit(true)
      setOpportunityTab('opportunities')
      navigate('/opportunities')
    }
    if (destination === 'pipeline') {
      setOpportunityTabExplicit(true)
      setOpportunityTab('pipeline')
      navigate('/opportunities')
    }
  }

  return (
    <div className="app-shell surface-shell ultimate-shell">
      <aside className="sidebar surface-sidebar ultimate-sidebar">
        <div className="brand">
          <span className="brand-mark">P</span>
          <div><strong>PJSDAS</strong><small>{zh ? '求职行动系统' : 'Job-search action system'}</small></div>
        </div>

        <nav className="surface-nav ultimate-primary-nav" aria-label={zh ? '主导航' : 'Primary navigation'}>
          {primarySurfaces.map((item) => {
            const label = surfaceLabels[item]
            return (
              <button
                key={item}
                className={surface === item ? 'nav-item active surface-nav-item' : 'nav-item surface-nav-item'}
                onClick={() => navigate(item === 'today' ? '/today' : '/opportunities')}
              >
                <span>{zh ? label.zh : label.en}</span>
                <small>{zh ? label.hintZh : label.hintEn}</small>
              </button>
            )
          })}
        </nav>

        <div className="surface-sidebar-footer"><span>Today · Opportunities</span></div>
      </aside>

      <main className="main-panel surface-main ultimate-main">
        <header className="ultimate-toolbar" aria-label={zh ? '全局工具栏' : 'Global toolbar'}>
          <button className="ultimate-capture-button" type="button" onClick={openCapture}>
            <span>＋</span><strong>{zh ? '告诉 PJSDAS' : 'Tell PJSDAS'}</strong><kbd>⌘K</kbd>
          </button>
          <div className="ultimate-toolbar-actions">
            {openDecisionCount > 0 ? (
              <button className={surface === 'decisions' ? 'active' : ''} type="button" onClick={() => navigate('/decisions')}>
                {zh ? '需要你决定' : 'Needs your decision'} <strong>{openDecisionCount}</strong>
              </button>
            ) : null}
            <button className={surface === 'settings' ? 'active' : ''} type="button" onClick={() => navigate('/settings')}>
              {zh ? '设置' : 'Settings'}
            </button>
          </div>
        </header>

        {surface === 'settings' ? <OriginTransitionNotice onOpenSettings={() => navigate('/settings')} /> : null}
        {loading ? <div className="empty-card">{zh ? '正在读取工作区…' : 'Loading workspace…'}</div> : null}

        {!loading && surface === 'today' && todayBrief ? (
          <TodaySurface
            brief={todayBrief}
            now={now}
            budgetMinutes={budgetMinutes}
            agendaExpanded={route.agendaExpanded}
            workspaceEmpty={workspaceEmpty}
            onBudgetChange={setBudgetMinutes}
            onStart={navigateFromStart}
            onOpenDecisions={() => navigate('/decisions')}
            onOpenAgenda={() => navigate(route.agendaExpanded ? '/today' : '/today/agenda')}
            onExecute={executeTodayAction}
            onMark={markAction}
            onOpenOpportunity={openOpportunity}
          />
        ) : null}

        {!loading && surface === 'opportunities' ? (
          <OpportunitiesSurface opportunities={opportunities} groups={groups} processes={processes} prep={prep} tab={opportunityTab} onTabChange={chooseOpportunityTab} onOpenOpportunity={openOpportunity} />
        ) : null}
        {!loading && surface === 'decisions' ? <DecisionRequestsView requests={decisionRequests} onChanged={reload} /> : null}
        {!loading && surface === 'history' ? <ActivitySurface timeline={timeline} /> : null}
        {!loading && surface === 'settings' ? <SettingsSurface lastImport={lastImport} rules={rules} onChanged={reload} onOpenActivity={() => navigate('/history')} /> : null}
      </main>

      <button className="ultimate-mobile-capture" type="button" onClick={openCapture}>＋ {zh ? '告诉 PJSDAS' : 'Tell PJSDAS'}</button>

      <TellPjsdasCapture
        open={route.capture}
        onClose={closeCapture}
        onChanged={reload}
        onOpenDecisions={() => navigate('/decisions')}
      />

      {selectedOpportunity ? (
        <OpportunityDetailDrawer
          opportunity={selectedOpportunity}
          process={selectedProcess}
          actions={selectedActions}
          applicationGroup={selectedGroup}
          timeline={selectedTimeline}
          onClose={() => navigate('/opportunities')}
          onNavigate={navigateFromDetail}
        />
      ) : null}

      {lastCompletedAction ? (
        <div className="action-undo-toast" role="status" aria-live="polite">
          <div>
            <strong>{lastCompletedAction.error ? (zh ? '撤销未完成' : 'Undo did not complete') : (zh ? '已标记完成' : 'Marked done')}</strong>
            <span>{lastCompletedAction.error ?? lastCompletedAction.title}</span>
          </div>
          <button type="button" onClick={() => { void undoLastCompletion() }}>{zh ? '撤销' : 'Undo'}</button>
        </div>
      ) : null}
    </div>
  )
}

function TodaySurface({
  brief,
  now,
  budgetMinutes,
  agendaExpanded,
  workspaceEmpty,
  onBudgetChange,
  onStart,
  onOpenDecisions,
  onOpenAgenda,
  onExecute,
  onMark,
  onOpenOpportunity,
}: {
  brief: TodayBriefModel
  now: Date
  budgetMinutes: number
  agendaExpanded: boolean
  workspaceEmpty: boolean
  onBudgetChange: (minutes: number) => void
  onStart: () => void
  onOpenDecisions: () => void
  onOpenAgenda: () => void
  onExecute: (item: TodayBriefAction) => Promise<void>
  onMark: (id: string, status: Action['status']) => Promise<void>
  onOpenOpportunity: (id: string) => void
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const primary = brief.nextAction
  const criticalWarnings = brief.materialCoverageWarnings.filter((item) => item.severity === 'critical')
  const coverageWarnings = brief.materialCoverageWarnings.filter((item) => item.severity !== 'critical')

  function reasonText(item: TodayBriefAction) {
    return item.whyNow.length
      ? presentRankingReasons(item.whyNow, zh).join(' · ')
      : (zh ? '当前最值得处理' : 'Highest-value next move')
  }

  function primaryLabel(item: TodayBriefAction) {
    if (item.execution.operation === 'open_application') {
      return item.execution.externalUrl
        ? (zh ? '打开申请' : 'Open application')
        : (zh ? '查看岗位' : 'View opportunity')
    }
    if (item.execution.operation === 'start_prep') return zh ? '开始准备' : 'Start prep'
    if (item.execution.operation === 'open_process') return zh ? '查看流程' : 'Open process'
    if (item.execution.operation === 'open_group_decision') return zh ? '比较机会' : 'Compare opportunities'
    return zh ? '开始' : 'Start'
  }

  function actionTiming(item: TodayBriefAction) {
    const timing = item.timing
    if (!timing) return undefined
    if (timing.precision === 'date' && timing.date) {
      return (zh ? '日期：' : 'Date: ') + timing.date
    }
    if (timing.startAt) {
      return (zh ? '开始：' : 'Starts: ') + formatBriefDateTime(timing.startAt, zh)
    }
    if (timing.deadlineAt) {
      return (zh ? '截止：' : 'Deadline: ') + formatBriefDateTime(timing.deadlineAt, zh)
    }
    return undefined
  }

  return (
    <section className="surface-page ultimate-today">
      <header className="ultimate-today-header">
        <div>
          <div className="eyebrow">{formatDateOnly(now.toISOString())}</div>
          <h1>{zh ? '今天' : 'Today'}</h1>
          <p>{zh ? '只看现在最值得做的事，以及接下来不能错过的时间节点。' : 'Only what is worth doing now and the recruiting nodes you cannot afford to miss.'}</p>
        </div>
        {brief.relevantDecisionRequests.length > 0 ? (
          <button className="ultimate-decision-entry" type="button" onClick={onOpenDecisions}>
            <span>{zh ? '需要你决定' : 'Needs your decision'}</span>
            <strong>{brief.relevantDecisionRequests.length}</strong>
          </button>
        ) : null}
      </header>

      {criticalWarnings.length ? (
        <div className="ultimate-critical-stack" role="status">
          {criticalWarnings.map((item) => (
            <div className="ultimate-critical-warning" key={item.code}>
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="ultimate-today-layout">
        <div className="ultimate-primary-slot">
          {primary ? (
            <article className="ultimate-next-action">
              <div className="decision-kicker">{zh ? '下一步' : 'Next action'}</div>
              {primary.company ? <div className="ultimate-action-context">{primary.company}{primary.role ? ' · ' + primary.role : ''}</div> : null}
              <h2>{primary.title}</h2>
              <p className="decision-why">{reasonText(primary)}</p>
              <div className="ultimate-action-meta">
                {actionTiming(primary) ? <span>{actionTiming(primary)}</span> : null}
                <span>{zh ? '预计 ' : 'Est. '}{formatMinutes(primary.estimatedMinutes)}</span>
                {primary.protectedByLatestStart ? <strong>{zh ? '已进入最迟开工保护' : 'Latest-start protected'}</strong> : null}
              </div>
              <div className="decision-actions">
                <button className="primary-button" type="button" onClick={() => { void onExecute(primary) }}>
                  {primaryLabel(primary)}
                </button>
                <button className="secondary-button" type="button" onClick={() => { void onMark(primary.actionId, 'done') }}>
                  {zh ? '标记完成' : 'Mark done'}
                </button>
                {primary.opportunityId ? (
                  <button className="text-button" type="button" onClick={() => onOpenOpportunity(primary.opportunityId!)}>
                    {zh ? '岗位详情' : 'Opportunity'}
                  </button>
                ) : null}
              </div>
            </article>
          ) : workspaceEmpty ? (
            <GettingStartedCard onStart={onStart} />
          ) : (
            <div className="ultimate-quiet-state ultimate-primary-quiet">
              <strong>{zh ? '现在没有必须处理的行动' : 'Nothing requires action right now'}</strong>
              <span>{zh ? '未来节点仍会保留在右侧日程，不需要为了填满 Today 制造任务。' : 'Future recruiting nodes remain visible in the agenda; PJSDAS does not invent work just to fill Today.'}</span>
            </div>
          )}
        </div>

        <aside className="ultimate-agenda" aria-label={zh ? '近期招聘日程' : 'Upcoming recruiting agenda'}>
          <div className="ultimate-section-head">
            <div>
              <span className="eyebrow">AGENDA</span>
              <h2>{agendaExpanded ? (zh ? '未来 30 天' : 'Next 30 days') : (zh ? '近期节点' : 'Upcoming')}</h2>
            </div>
            <button className="text-button" type="button" onClick={onOpenAgenda}>
              {agendaExpanded ? (zh ? '收起' : 'Summary') : (zh ? '全部日程' : 'All schedule')}
            </button>
          </div>

          {brief.agendaGroups.length ? (
            <div className="ultimate-agenda-groups">
              {brief.agendaGroups.map((group) => (
                <section className={'ultimate-agenda-group relation-' + group.relation} key={group.key}>
                  <h3>{agendaGroupTitle(group.relation, group.date, zh)}</h3>
                  <div>
                    {group.nodes.map((node) => (
                      <button
                        className={'ultimate-agenda-node' + (node.requiresResolution ? ' unresolved' : '')}
                        type="button"
                        key={node.nodeId}
                        onClick={() => { if (node.opportunityId) onOpenOpportunity(node.opportunityId) }}
                      >
                        <span className="ultimate-agenda-time">{agendaNodeTime(node, zh)}</span>
                        <span className="ultimate-agenda-copy">
                          <strong>{agendaNodeLabel(node.kind, zh)}</strong>
                          <small>{[node.company, node.role].filter(Boolean).join(' · ') || (zh ? '招聘节点' : 'Recruiting node')}</small>
                        </span>
                        <span className="ultimate-agenda-state">
                          {node.requiresResolution
                            ? (zh ? '待确认' : 'Resolve')
                            : node.within48Hours
                              ? (zh ? '48h 内' : '<48h')
                              : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="ultimate-agenda-empty">
              <strong>{zh ? '近期没有招聘时间节点' : 'No recruiting nodes coming up'}</strong>
              <span>{zh ? '这里不会显示普通日历事件。' : 'General calendar events do not appear here.'}</span>
            </div>
          )}
        </aside>

        <section className="ultimate-next-list-section">
          <div className="ultimate-section-head">
            <div>
              <span className="eyebrow">NEXT UP</span>
              <h2>{zh ? '接下来' : 'Next up'}</h2>
            </div>
            <div className="decision-budget" role="group" aria-label={zh ? '今日可用时间' : 'Available time today'}>
              {[60, 180, 360].map((value) => (
                <button key={value} type="button" className={budgetMinutes === value ? 'active' : ''} onClick={() => onBudgetChange(value)}>
                  {formatMinutes(value)}
                </button>
              ))}
            </div>
          </div>

          {brief.nextActions.length ? (
            <div className="ultimate-next-list">
              {brief.nextActions.map((item, index) => (
                <article className="ultimate-next-row" key={item.actionId}>
                  <span className="decision-order">{index + 2}</span>
                  <button className="ultimate-next-copy" type="button" onClick={() => { void onExecute(item) }}>
                    <strong>{item.title}</strong>
                    <small>{reasonText(item)}</small>
                  </button>
                  <div className="ultimate-next-meta">
                    {actionTiming(item) ? <span>{actionTiming(item)}</span> : null}
                    <span>{formatMinutes(item.estimatedMinutes)}</span>
                  </div>
                  <button className="decision-done-button" type="button" onClick={() => { void onMark(item.actionId, 'done') }}>
                    {zh ? '完成' : 'Done'}
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <p className="ultimate-section-empty">{zh ? '没有第二优先级任务。' : 'No secondary action needs your time.'}</p>
          )}
        </section>
      </div>

      {coverageWarnings.length ? (
        <details className="ultimate-coverage-details">
          <summary>{zh ? '数据覆盖提示' : 'Coverage notes'} · {coverageWarnings.length}</summary>
          <div>
            {coverageWarnings.map((item) => (
              <p key={item.code}><strong>{item.title}</strong><span>{item.detail}</span></p>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  )
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
  if (temporal.startAt) return formatBriefDateTime(temporal.startAt, zh)
  if (temporal.deadlineAt) return (zh ? '截止 ' : 'By ') + formatBriefDateTime(temporal.deadlineAt, zh)
  if (temporal.endAt) return formatBriefDateTime(temporal.endAt, zh)
  return zh ? '时间待定' : 'Time TBD'
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

function OpportunitiesSurface({ opportunities, groups, processes, prep, tab, onTabChange, onOpenOpportunity }: {
  opportunities: Opportunity[]
  groups: ApplicationGroup[]
  processes: ProcessRecord[]
  prep: Prep[]
  tab: OpportunityTab
  onTabChange: (tab: OpportunityTab) => void
  onOpenOpportunity: (id: string) => void
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const active = opportunities.filter((item) => item.processStage === 'not_applied' || item.processStage === 'waiting_release').length
  const inPipeline = opportunities.filter((item) => ['screening', 'assessment', 'written_test', 'interview', 'offer'].includes(item.processStage)).length

  return (
    <section className="surface-page opportunities-surface">
      <SurfaceHeader eyebrow="OPPORTUNITIES" title={zh ? '机会、流程和准备在同一个工作面' : 'Opportunities, pipeline, and preparation in one workspace'} text={zh ? '这里承载“值不值得投、推进到哪里、为它准备什么”。后台发现与来源核验不会再制造新的维护队列。' : 'This surface answers what is worth pursuing, where it stands, and what preparation supports it. Background discovery and verification do not create another maintenance queue.'} />

      <div className="surface-context-tabs" role="tablist">
        <button className={tab === 'opportunities' ? 'active' : ''} onClick={() => onTabChange('opportunities')}><span>{zh ? '机会池' : 'Opportunities'}</span><small>{active} {zh ? '活跃' : 'active'}</small></button>
        <button className={tab === 'pipeline' ? 'active' : ''} onClick={() => onTabChange('pipeline')}><span>{zh ? '在途流程' : 'Pipeline'}</span><small>{inPipeline} {zh ? '在途' : 'in progress'}</small></button>
        <button className={tab === 'prepare' ? 'active' : ''} onClick={() => onTabChange('prepare')}><span>{zh ? '准备' : 'Prepare'}</span><small>{prep.length} {zh ? '资产' : 'items'}</small></button>
      </div>

      {tab === 'opportunities' ? <><div className="surface-tool-strip"><div><strong>{zh ? '组合决策' : 'Portfolio decision'}</strong><span>{zh ? '有共享投递名额时，比较整个组合，不为了凑名额推荐弱岗位。' : 'When roles share an application quota, compare the portfolio rather than filling slots.'}</span></div><div className="surface-tool-row"><ApplicationPortfolioDock /></div></div><OpportunityTable opportunities={opportunities} groups={groups} onOpenOpportunity={onOpenOpportunity} /></> : null}
      {tab === 'pipeline' ? <PipelinePanel processes={processes} opportunities={opportunities} onOpenOpportunity={onOpenOpportunity} /> : null}
      {tab === 'prepare' ? <PreparePanel prep={prep} /> : null}
    </section>
  )
}

function OpportunityTable({ opportunities, groups, onOpenOpportunity }: { opportunities: Opportunity[]; groups: ApplicationGroup[]; onOpenOpportunity: (id: string) => void }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'active' | 'all' | 'closed'>('active')
  const now = new Date()
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return [...opportunities]
      .filter((item) => scope === 'all' || (scope === 'closed'
        ? (item.processStage === 'closed' || item.participationStatus === 'abandoned')
        : (item.processStage !== 'closed' && item.participationStatus !== 'abandoned')))
      .filter((item) => !needle || `${item.company} ${item.role}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999))
  }, [opportunities, query, scope])

  return (
    <section className="surface-panel surface-table-panel">
      <div className="surface-panel-head"><div><div className="eyebrow">OPPORTUNITY POOL</div><h2>{zh ? '正式机会池' : 'Opportunity pool'}</h2></div><span>{filtered.length} / {opportunities.length}</span></div>
      <div className="surface-filter-row"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? '搜索公司或岗位' : 'Search company or role'} /><select value={scope} onChange={(event) => setScope(event.target.value as 'active' | 'all' | 'closed')}><option value="active">{zh ? '活跃' : 'Active'}</option><option value="closed">{zh ? '已结束' : 'Closed'}</option><option value="all">{zh ? '全部' : 'All'}</option></select></div>
      {filtered.length ? (
        <>
          <div className="surface-table-wrap surface-opportunity-desktop"><table><thead><tr><th>{zh ? '公司' : 'Company'}</th><th>{zh ? '岗位' : 'Role'}</th><th>{zh ? '定位' : 'Role type'}</th><th>{zh ? '时机' : 'Timing'}</th><th>Fit</th><th>{zh ? '机会价值' : 'Value'}</th><th>{zh ? '截止' : 'Deadline'}</th><th>{zh ? '申请组' : 'Group'}</th></tr></thead><tbody>{filtered.map((item) => <tr className="surface-opportunity-row" key={item.id}><td><strong>{item.company}</strong></td><td><button className="surface-link-button" onClick={() => onOpenOpportunity(item.id)}>{item.role}</button></td><td>{roleLabels[item.roleType][zh ? 0 : 1]}</td><td><PriorityBadge value={computePriority(item, now)} zh={zh} /></td><td>{item.assessmentStatus === 'unassessed' ? (zh ? '未评估' : 'Unassessed') : Math.round(item.fitScore)}</td><td>{item.assessmentStatus === 'unassessed' ? (zh ? '未评估' : 'Unassessed') : Math.round(item.opportunityValue)}</td><td>{item.deadline ? formatDateOnly(item.deadline) : '—'}</td><td>{item.applicationGroupId ?? '—'}</td></tr>)}</tbody></table></div>
          <div className="surface-opportunity-mobile-list">{filtered.map((item) => <button type="button" key={`mobile:${item.id}`} onClick={() => onOpenOpportunity(item.id)}><div><strong>{item.company}</strong><span>{item.role}</span></div><div><span>{roleLabels[item.roleType][zh ? 0 : 1]}</span><span>{item.assessmentStatus === 'unassessed' ? (zh ? '未评估' : 'Unassessed') : `Fit ${Math.round(item.fitScore)}`}</span><span>{item.assessmentStatus === 'unassessed' ? (zh ? '待评估' : 'Pending assessment') : `${zh ? '价值' : 'Value'} ${Math.round(item.opportunityValue)}`}</span></div><small>{item.deadline ? `${zh ? '截止' : 'Deadline'} ${formatDateOnly(item.deadline)}` : presentStageLabel(item.processStage, item.currentStageLabel, lang)}</small></button>)}</div>
        </>
      ) : <EmptyState title={opportunities.length ? (zh ? '没有符合筛选的岗位' : 'No matching opportunities') : (zh ? '机会池还是空的' : 'Opportunity pool is empty')} text={opportunities.length ? (zh ? '调整搜索或筛选条件。' : 'Adjust search or filters.') : (zh ? '符合规则且身份明确的岗位会自动进入这里；也可以在 Settings 配置岗位发现或导入已有岗位。' : 'Eligible, confidently identified jobs appear here automatically. You can also configure discovery or import existing opportunities in Settings.')} />}
      {groups.length ? <p className="surface-footnote">{zh ? `当前有 ${groups.length} 个共享申请组。组合决策只对显式关联到同一 Application Group 的岗位生效。` : `${groups.length} shared Application Groups are present. Portfolio decisions only apply to roles explicitly linked to the same group.`}</p> : null}
    </section>
  )
}

function PipelinePanel({ processes, opportunities, onOpenOpportunity }: { processes: ProcessRecord[]; opportunities: Opportunity[]; onOpenOpportunity: (id: string) => void }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const stageOrder: Record<ProcessRecord['stage'], number> = {
    offer: 0,
    interview: 1,
    written_test: 2,
    assessment: 3,
    screening: 4,
    waiting_release: 5,
    not_applied: 6,
    closed: 7,
  }
  const sorted = [...processes].sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage] || (b.lastProgressAt ?? '').localeCompare(a.lastProgressAt ?? '') || a.company.localeCompare(b.company))
  const opportunityIdFor = (process: ProcessRecord) => process.opportunityId ?? opportunities.find((item) => item.company === process.company && item.role === process.role)?.id
  return (
    <section className="surface-panel">
      <div className="surface-panel-head"><div><div className="eyebrow">PIPELINE</div><h2>{zh ? '在途招聘流程' : 'Recruiting pipeline'}</h2></div><span>{processes.length}</span></div>
      {sorted.length ? <div className="surface-pipeline-grid">{sorted.map((item) => {
        const opportunityId = opportunityIdFor(item)
        return <article className="surface-pipeline-card" key={item.id}><div><strong>{item.company}</strong><h3>{item.role}</h3></div><span className="surface-stage">{presentStageLabel(item.stage, item.stageLabel, lang)}</span><dl><div><dt>{zh ? '最近进展' : 'Last progress'}</dt><dd>{item.lastProgressAt ? formatDateOnly(item.lastProgressAt) : '—'}</dd></div></dl><div className="surface-pipeline-footer">{opportunityId ? <button className="text-button" onClick={() => onOpenOpportunity(opportunityId)}>{zh ? '岗位详情' : 'Details'}</button> : null}</div></article>
      })}</div> : <EmptyState title={zh ? '暂无在途流程' : 'No pipeline yet'} text={zh ? '流程通知通常由 AI / Gmail 自动进入；日常补充请使用“告诉 PJSDAS”，只有恢复异常流程时才进入 Settings。' : 'Process notices normally arrive through AI or Gmail. Use Tell PJSDAS for normal capture and Settings only for exceptional process recovery.'} />}
    </section>
  )
}

function PreparePanel({ prep }: { prep: Prep[] }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const sorted = [...prep].sort((a, b) => prepPriorityRank(a.priorityLabel) - prepPriorityRank(b.priorityLabel) || a.title.localeCompare(b.title))
  return (
    <div className="prepare-context">
      <div className="surface-tool-strip"><div><strong>{zh ? '准备图谱' : 'Prep Graph'}</strong><span>{zh ? '查看一个准备任务覆盖哪些岗位、命中哪些真实缺口。' : 'See which opportunities a prep item supports and which real needs it covers.'}</span></div><div className="surface-tool-row"><PrepGraphDock /></div></div>
      <section className="surface-panel"><div className="surface-panel-head"><div><div className="eyebrow">PREP INVENTORY</div><h2>{zh ? '准备资产' : 'Preparation inventory'}</h2></div><span>{prep.length}</span></div>{sorted.length ? <div className="surface-prep-grid">{sorted.map((item) => <article key={item.id}><div><span>{presentPrepPriority(item.priorityLabel, zh)}</span><span>{presentPrepSourceState(item.sourceStatus, zh)}</span></div><h3>{item.title}</h3><p>{item.minimumOutput ?? (zh ? '暂无最小产出定义' : 'No minimum output defined')}</p><small>{formatMinutes(item.estimatedMinutes)} · {item.triggeredBy ?? (zh ? '无显式触发条件' : 'No explicit trigger')}</small></article>)}</div> : <EmptyState title={zh ? '暂无准备任务' : 'No preparation items'} text={zh ? '准备资产不是为了填满列表；只有明确可复用的准备才值得长期保留。' : 'The Prep inventory is not a checklist to fill; keep reusable preparation with a clear purpose.'} />}</section>
    </div>
  )
}

function ActivitySurface({ timeline }: { timeline: TimelineRecord[] }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  return <section className="surface-page"><SurfaceHeader eyebrow="HISTORY" title={zh ? '历史与审计' : 'History & audit'} text={zh ? '这里只保留发生过什么。日常行动和需要你决定的事分别留在 Today 与 Decisions。' : 'This is the audit trail only. Daily action stays in Today and genuine decisions stay in Decisions.'} /><TimelineView records={timeline} /></section>
}

function SettingsSurface({ lastImport, rules, onChanged, onOpenActivity }: { lastImport?: ImportMeta; rules: DecisionRules; onChanged: () => Promise<void>; onOpenActivity: () => void }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [preview, setPreview] = useState<ImportBundle | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function readWorkbook(file?: File) {
    if (!file) return
    setBusy(true); setError(''); setMessage('')
    try { setPreview(await parsePJSDASWorkbook(file)) }
    catch (caught) { setPreview(null); setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }

  async function commitImport() {
    if (!preview) return
    setBusy(true); setError('')
    try { await replaceImportedData(preview); await onChanged(); setMessage(zh ? `已导入 ${preview.summary.opportunities} 个岗位。` : `Imported ${preview.summary.opportunities} opportunities.`); setPreview(null) }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }

  return (
    <section className="surface-page settings-surface">
      <SurfaceHeader eyebrow="SETTINGS" title={zh ? '连接、自动化和长期控制' : 'Connections, automation, and durable control'} text={zh ? '设置是低频控制面。默认只展开连接状态，其余规则、偏好和恢复工具按需查看。' : 'Settings is a low-frequency control surface. Connection state stays visible; preferences, policy, and recovery expand only when needed.'} />
      <div className="settings-mobile-language" aria-label={zh ? '移动端界面语言' : 'Mobile interface language'}><LanguageSwitch /></div>

      <details className="settings-group" open>
        <summary><div><strong>{zh ? '连接与自动化' : 'Connections & automation'}</strong><span>{zh ? '账户、云同步和后台来源' : 'Account, cloud sync, and background sources'}</span></div></summary>
        <div className="settings-group-body"><CloudSettingsCard /></div>
      </details>

      <details className="settings-group">
        <summary><div><strong>{zh ? '岗位发现偏好' : 'Discovery preferences'}</strong><span>{zh ? '长期搜索边界，不是日常操作' : 'Durable discovery boundaries, not daily work'}</span></div></summary>
        <div className="settings-group-body"><DiscoveryProfileCard /></div>
      </details>

      <details className="settings-group">
        <summary><div><strong>{zh ? '决策规则' : 'Decision policy'}</strong><span>{zh ? '确定性排序和风险阈值' : 'Deterministic ranking and guardrails'}</span></div></summary>
        <div className="settings-group-body"><RulesView rules={rules} onChanged={onChanged} /></div>
      </details>

      <details className="settings-group">
        <summary><div><strong>{zh ? '数据与恢复' : 'Data & recovery'}</strong><span>{zh ? '备份、导入和恢复路径' : 'Backup, import, and recovery paths'}</span></div></summary>
        <div className="settings-group-body">
          <ConnectedMigrationCard />
          <div className="settings-inline-tool"><div><strong>{zh ? '流程恢复工具' : 'Process recovery'}</strong><p>{zh ? '日常输入请使用全局“告诉 PJSDAS”。这里只有自动化无法恢复时才使用的低频流程工具。' : 'Use global Tell PJSDAS for normal input. This low-frequency tool is only for process recovery when automation cannot repair the state.'}</p></div><div className="surface-tool-row"><ProcessEventDock onChanged={() => { void onChanged() }} /></div></div>
          <div className="settings-inline-tool"><div><strong>{zh ? '本地快照' : 'Local snapshot'}</strong><p>{zh ? '大版本调整、换设备或清理浏览器前导出完整快照。' : 'Export a full snapshot before major upgrades, device changes, or browser cleanup.'}</p></div><LocalBackupDock onChanged={() => { void onChanged() }} /></div>
          <div className="surface-import-card"><div><strong>{zh ? 'Excel 初始化 / 恢复' : 'Excel initialization / recovery'}</strong><p>{zh ? 'Excel 已不是日常数据源，只在初始化、历史迁移或恢复时使用。' : 'Excel is no longer the daily source of truth; use it for initialization, migration, or recovery.'}</p></div><label className="file-button">{busy ? (zh ? '处理中…' : 'Processing…') : (zh ? '选择工作簿' : 'Choose workbook')}<input type="file" accept=".xlsx,.xls" disabled={busy} onChange={(event) => { void readWorkbook(event.target.files?.[0]) }} /></label></div>
          {error ? <div className="notice error">{error}</div> : null}
          {message ? <div className="notice success">{message}</div> : null}
          {preview ? <div className="surface-import-preview"><div><strong>{preview.summary.filename}</strong><span>{preview.summary.opportunities} {zh ? '岗位' : 'opportunities'} · {preview.summary.actions} Actions</span></div><button className="primary-button" disabled={busy} onClick={() => { void commitImport() }}>{zh ? '确认导入' : 'Confirm import'}</button></div> : null}
          {lastImport ? <p className="surface-footnote">{zh ? '最近导入' : 'Last import'}：{lastImport.filename} · {formatDateTime(lastImport.importedAt)}</p> : null}
        </div>
      </details>

      <details className="settings-group">
        <summary><div><strong>{zh ? '历史与审计' : 'History & audit'}</strong><span>{zh ? '发生过什么，不占用日常决策界面' : 'What happened, outside the daily decision surface'}</span></div></summary>
        <div className="settings-group-body"><button className="settings-secondary-link" type="button" onClick={onOpenActivity}>{zh ? '查看活动记录' : 'Open activity history'}</button></div>
      </details>

      <details className="settings-group">
        <summary><div><strong>{zh ? '界面' : 'Interface'}</strong><span>{zh ? '显示层，不改变业务数据' : 'Presentation only; business data is unchanged'}</span></div></summary>
        <div className="settings-group-body"><div className="surface-language-card"><div><strong>{zh ? '界面语言' : 'Interface language'}</strong><p>{zh ? '语言只影响界面显示，不改变工作区数据。' : 'Language affects presentation only, not workspace data.'}</p></div><LanguageSwitch /></div></div>
      </details>
    </section>
  )
}

function SurfaceHeader({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <header className="surface-header"><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{text}</p></header>
}

function GettingStartedCard({ onStart }: { onStart: () => void }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  return (
    <article className="usability-start-card">
      <div className="eyebrow">START PJSDAS</div>
      <h2>{zh ? '先让工作区有第一批真实机会' : 'Start with real opportunities'}</h2>
      <p>{zh ? '当前工作区还是空的。先在 Settings 配置岗位发现偏好，或导入已有求职表；符合规则且身份明确的岗位会直接进入机会池，不需要你维护额外的系统队列。' : 'The workspace is empty. Configure discovery preferences or import an existing job-search workbook in Settings. Eligible, confidently identified jobs enter the opportunity pool without creating another maintenance queue.'}</p>
      <div className="usability-start-actions">
        <button className="primary-button" type="button" onClick={onStart}>{zh ? '打开设置' : 'Open settings'}</button>
      </div>
    </article>
  )
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-card"><strong>{title}</strong><p>{text}</p></div>
}

function PriorityBadge({ value, zh }: { value: ReturnType<typeof computePriority>; zh: boolean }) {
  const label = value === 'expired'
    ? (zh ? '已过期' : 'Expired')
    : value === 'none'
      ? (zh ? '流程中' : 'Pipeline')
      : value
  return <span className={`priority-badge priority-${value}`}>{label}</span>
}

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat(currentUiLanguage() === 'zh' ? 'zh-CN' : 'en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
}

function formatDateOnly(iso: string) {
  return new Intl.DateTimeFormat(currentUiLanguage() === 'zh' ? 'zh-CN' : 'en-GB', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(iso))
}

function formatMinutes(minutes: number) {
  const zh = currentUiLanguage() === 'zh'
  if (minutes < 60) return zh ? `${minutes} 分钟` : `${minutes} min`
  const hours = minutes / 60
  const value = Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
  return zh ? `${value} 小时` : `${value} hr`
}

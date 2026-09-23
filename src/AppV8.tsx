import { useEffect, useMemo, useState } from 'react'
import {
  applyActionStatusChangeSet,
  exportLocalSnapshot,
  replaceImportedData,
} from './db.js'
import { parsePJSDASWorkbook } from './importExcelV2.js'
import { prepPriorityRank, presentPrepPriority, presentPrepSourceState } from './prepSemantics.js'
import { presentStageLabel } from './stagePresentation.js'
import { currentUiLanguage, useUiLanguage } from './uiLanguage.js'
import { DEFAULT_DECISION_RULES } from './decisionRules.js'
import RulesView from './RulesView.js'
import TimelineView from './TimelineView.js'
import CloudSettingsCard from './cloud/CloudSettingsCard.js'
import { useCloud } from './cloud/CloudContext.js'
import { ensureAuthoritativePersistence } from './cloud/authoritativePersistence.js'
import { connectedWorkspaceAuthorityEnabled } from './cloud/connectedWorkspaceRepository.js'
import {
  refreshConnectedAuthoritativeCache,
  TODAY_AUTHORITATIVE_REFRESH_INTERVAL_MS,
} from './cloud/authoritativeReadModelClient.js'
import {
  createConnectedCommandId,
  executeConnectedBusinessCommand,
  undoConnectedBusinessCommand,
} from './cloud/authoritativeCommandClient.js'
import DiscoveryProfileCard from './DiscoveryProfileCard.js'
import PrepGraphDock from './PrepGraphDock.js'
import ProcessEventDock from './ProcessEventDock.js'
import LocalBackupDock from './LocalBackupDock.js'
import ConnectedMigrationCard from './cloud/ConnectedMigrationCard.js'
import OriginTransitionNotice from './OriginTransitionNotice.js'
import OpportunityDetailDrawer, { type OpportunityDetailDestination } from './OpportunityDetailDrawer.js'
import OpportunityDecisionList from './OpportunityDecisionList.js'
import {
  buildOpportunityDecisionList,
  getOpportunityDecisionRead,
  type OpportunityDecisionListRead,
} from './opportunityDecisionRead.js'
import TellPjsdasCapture from './TellPjsdasCapture.js'
import TodayFeature, { type TodayFreshnessView } from './today/TodayFeature.js'
import DecisionRequestsView from './DecisionRequestsView.js'
import {
  buildTodayBrief,
  type TodayBrief as TodayBriefModel,
  type TodayBriefAction,
} from './todayBrief.js'
import type {
  Action,
  ImportBundle,
} from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import './timeplan.css'
import './surfaceConsolidation.css'
import './interactionDetail.css'
import './webConsole.css'
import './ultimateWeb.css'
import './opportunityDecision.css'
import './cgr02Tokens.css'

type Surface = 'today' | 'opportunities' | 'decisions' | 'history' | 'settings'
type PrimarySurface = 'today' | 'opportunities'
type OpportunityTab = 'opportunities' | 'prepare'
type CompletionFeedback = { id: string; title: string; previousStatus: Action['status']; commandId?: string; error?: string }
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

function semanticPath(pathname = window.location.pathname) {
  if (APP_BASE && pathname.startsWith(APP_BASE)) return pathname.slice(APP_BASE.length) || '/'
  return pathname || '/'
}

function browserPath(path: string) {
  return `${APP_BASE}${path}` || '/'
}

function routeFromPath(pathname = semanticPath()): RouteState {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/capture' || path === '/today/capture') return { surface: 'today', capture: true, agendaExpanded: false }
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
  const [captureContextOpportunityId, setCaptureContextOpportunityId] = useState<string>()
  const [todayFreshness, setTodayFreshness] = useState<TodayFreshnessView>({ state: 'local' })
  const [opportunityTab, setOpportunityTab] = useState<OpportunityTab>('opportunities')
  const [opportunityTabExplicit, setOpportunityTabExplicit] = useState(false)
  const [lastCompletedAction, setLastCompletedAction] = useState<CompletionFeedback | null>(null)
  const [snapshot, setSnapshot] = useState<PJSDASSnapshot>()
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => new Date())
  const [budgetMinutes, setBudgetMinutes] = useState(180)

  const opportunities = snapshot?.data.opportunities ?? []
  const actions = snapshot?.data.actions ?? []
  const processes = snapshot?.data.processes ?? []
  const prep = snapshot?.data.prep ?? []
  const groups = snapshot?.data.applicationGroups ?? []
  const timeline = snapshot?.data.timeline ?? []
  const rules = snapshot?.data.decisionRules ?? DEFAULT_DECISION_RULES
  const lastImport = snapshot?.data.meta

  const surface = route.surface
  const selectedOpportunityId = route.opportunityId
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  async function reload() {
    const next = await exportLocalSnapshot()
    setSnapshot(next)
  }

  function navigate(path: string, replace = false) {
    const destination = browserPath(path)
    if (replace) window.history.replaceState(null, '', destination)
    else window.history.pushState(null, '', destination)
    setRoute(routeFromPath(path))
  }

  function openCapture() {
    const current = semanticPath()
    setCaptureContextOpportunityId(route.opportunityId)
    setCaptureReturnPath(current === '/capture' || current === '/today/capture' ? '/today' : current)
    navigate('/today/capture')
  }

  function closeCapture() {
    navigate(captureReturnPath || '/today', true)
    setCaptureContextOpportunityId(undefined)
  }

  useEffect(() => {
    const path = semanticPath()
    if (path === '/') {
      window.history.replaceState(null, '', browserPath('/today'))
      setRoute(routeFromPath('/today'))
    } else if (path === '/capture') {
      window.history.replaceState(null, '', browserPath('/today/capture'))
      setRoute(routeFromPath('/today/capture'))
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
    const accountKey = cloud.session?.user.id
    if (surface !== 'today' || !accountKey || !connectedWorkspaceAuthorityEnabled()) {
      setTodayFreshness({ state: 'local' })
      return
    }

    let active = true
    let running = false
    const refresh = async (initial = false) => {
      if (running) return
      running = true
      setTodayFreshness((current) => ({
        ...current,
        state: initial && !snapshot ? 'initial' : 'refreshing',
      }))
      try {
        const result = await refreshConnectedAuthoritativeCache(accountKey)
        if (!active) return
        if (result.state === 'current' || result.state === 'updated') {
          setTodayFreshness({
            state: result.state,
            observedAt: result.observedAt,
            latencyMs: result.latencyMs,
          })
          if (result.changed) await reload()
        } else {
          setTodayFreshness({
            state: 'blocked',
            observedAt: result.observedAt,
            latencyMs: result.latencyMs,
            detail: result.state === 'diverged'
              ? 'Authoritative state changed while this client also has local changes; PJSDAS did not overwrite either side.'
              : result.state === 'local_changes_pending'
                ? 'This client has local changes that have not been projected to authoritative state.'
                : 'A non-empty local workspace has not yet been safely bound to this account.',
          })
        }
      } catch (caught) {
        if (!active) return
        setTodayFreshness({
          state: 'cached',
          detail: caught instanceof Error ? caught.message : String(caught),
        })
      } finally {
        running = false
      }
    }

    void refresh(true)
    const interval = window.setInterval(() => { void refresh() }, TODAY_AUTHORITATIVE_REFRESH_INTERVAL_MS)
    const focus = () => { void refresh() }
    const online = () => { void refresh() }
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', focus)
    window.addEventListener('online', online)
    document.addEventListener('visibilitychange', visible)
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', focus)
      window.removeEventListener('online', online)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [cloud.session?.user.id, surface])

  useEffect(() => {
    if (!lastCompletedAction) return
    const timer = window.setTimeout(() => setLastCompletedAction(null), 8_000)
    return () => window.clearTimeout(timer)
  }, [lastCompletedAction])



  const todayBrief = useMemo<TodayBriefModel | undefined>(() => {
    if (!snapshot) return undefined
    return buildTodayBrief(
      snapshot,
      { availableMinutes: budgetMinutes, agendaHorizonDays: route.agendaExpanded ? 30 : 7 },
      { now, timezone, workspaceVersion: `web:${snapshot.exportedAt}` },
    )
  }, [snapshot, budgetMinutes, route.agendaExpanded, now, timezone])

  const opportunityDecisionList = useMemo<OpportunityDecisionListRead | undefined>(() => {
    if (!snapshot) return undefined
    return buildOpportunityDecisionList(snapshot, {
      now,
      timezone,
      workspaceVersion: `web:${snapshot.exportedAt}`,
    })
  }, [snapshot, now, timezone])


  const decisionRequests = snapshot?.data.decisionRequests ?? []
  const openDecisionCount = decisionRequests.filter((item) =>
    item.state === 'open' && (!item.expiresAt || new Date(item.expiresAt).getTime() >= now.getTime()),
  ).length
  const workspaceEmpty = opportunities.length === 0 && actions.length === 0 && processes.length === 0 && prep.length === 0
  const selectedOpportunity = selectedOpportunityId ? opportunities.find((item) => item.id === selectedOpportunityId) : undefined
  const captureOpportunity = captureContextOpportunityId
    ? opportunities.find((item) => item.id === captureContextOpportunityId)
    : undefined
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
  const selectedOpportunityDecision = selectedOpportunity && snapshot
    ? getOpportunityDecisionRead(snapshot, selectedOpportunity.id, {
        now,
        timezone,
        workspaceVersion: `web:${snapshot.exportedAt}`,
      })
    : undefined


  async function markAction(id: string, status: Action['status']) {
    const before = actions.find((item) => item.id === id)
    if (!before) return
    let authoritativeCommandId: string | undefined
    try {
      if (cloud.session && connectedWorkspaceAuthorityEnabled()) {
        authoritativeCommandId = createConnectedCommandId('web-action')
        const result = await executeConnectedBusinessCommand(cloud.session.user.id, {
          type: 'domain',
          value: {
            commandId: authoritativeCommandId,
            kind: 'set_action_status',
            actionId: id,
            status,
          },
        }, { commandId: authoritativeCommandId })
        if (result.outcome === 'CONFLICT') throw new Error(result.conflict?.message ?? 'Action update conflicted with newer authoritative state.')
      } else {
        await applyActionStatusChangeSet(id, status)
        if (cloud.session) await ensureAuthoritativePersistence(true, cloud.syncNow)
      }
      await reload()
      if (status === 'done' && before.status !== 'done') {
        setLastCompletedAction({
          id: before.id,
          title: before.title,
          previousStatus: before.status,
          commandId: authoritativeCommandId,
        })
      } else if (lastCompletedAction?.id === id) setLastCompletedAction(null)
    } catch (caught) {
      await reload()
      setLastCompletedAction({
        id: before.id,
        title: before.title,
        previousStatus: before.status,
        commandId: authoritativeCommandId,
        error: caught instanceof Error ? caught.message : String(caught),
      })
    }
  }

  async function undoLastCompletion() {
    const item = lastCompletedAction
    if (!item) return
    try {
      if (cloud.session && connectedWorkspaceAuthorityEnabled() && item.commandId) {
        const result = await undoConnectedBusinessCommand(cloud.session.user.id, item.commandId)
        if (result.outcome === 'CONFLICT') throw new Error(result.conflict?.message ?? 'Undo conflicted with a dependent authoritative update.')
      } else {
        await applyActionStatusChangeSet(item.id, item.previousStatus)
        if (cloud.session) await ensureAuthoritativePersistence(true, cloud.syncNow)
      }
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
  }

  return (
    <div className="app-shell surface-shell ultimate-shell cgr-shell cgr-app-shell">
      <aside className="sidebar surface-sidebar ultimate-sidebar cgr-sidebar">
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

      <main className="main-panel surface-main ultimate-main cgr-main">
        <header className="ultimate-toolbar cgr-toolbar" aria-label={zh ? '全局工具栏' : 'Global toolbar'}>
          <button className="ultimate-capture-button cgr-global-capture" type="button" onClick={openCapture}>
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
          <TodayFeature
            brief={todayBrief}
            now={now}
            budgetMinutes={budgetMinutes}
            agendaExpanded={route.agendaExpanded}
            workspaceEmpty={workspaceEmpty}
            freshness={cloud.loading && workspaceEmpty ? { state: 'initial' } : todayFreshness}
            onBudgetChange={setBudgetMinutes}
            onStart={navigateFromStart}
            onOpenDecisions={() => navigate('/decisions')}
            onOpenAgenda={() => navigate(route.agendaExpanded ? '/today' : '/today/agenda')}
            onExecute={executeTodayAction}
            onMark={markAction}
            onOpenOpportunity={openOpportunity}
          />
        ) : null}

        {!loading && surface === 'opportunities' && opportunityDecisionList ? (
          <OpportunitiesSurface read={opportunityDecisionList} prep={prep} tab={opportunityTab} onTabChange={chooseOpportunityTab} onOpenOpportunity={openOpportunity} />
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
        contextLabel={captureOpportunity ? `${captureOpportunity.company} · ${captureOpportunity.role}` : undefined}
        contextRefs={captureOpportunity ? [`opportunity:${captureOpportunity.id}`] : []}
      />

      {selectedOpportunity ? (
        <OpportunityDetailDrawer
          opportunity={selectedOpportunity}
          decision={selectedOpportunityDecision}
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

function OpportunitiesSurface({
  read,
  prep,
  tab,
  onTabChange,
  onOpenOpportunity,
}: {
  read: OpportunityDecisionListRead
  prep: Prep[]
  tab: OpportunityTab
  onTabChange: (tab: OpportunityTab) => void
  onOpenOpportunity: (id: string) => void
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'

  return (
    <section className="surface-page opportunities-surface">
      <SurfaceHeader
        eyebrow="OPPORTUNITIES"
        title={zh ? '哪些在推进，哪些值得继续投入' : 'What is moving, and what is worth pursuing'}
        text={zh
          ? '默认只看当前决策相关的机会。阶段、下一步、最近节点和关键理由放在同一行；评分、来源计数和配额细节按需展开。'
          : 'The default view stays focused on current decisions. Stage, next move, nearest node, and material reasons sit on one row; scores, source counts, and quota details stay progressive.'}
      />

      <div className="surface-context-tabs" role="tablist">
        <button className={tab === 'opportunities' ? 'active' : ''} onClick={() => onTabChange('opportunities')}>
          <span>{zh ? '机会' : 'Opportunities'}</span>
          <small>{read.inProgress.length + read.worthPursuing.length} {zh ? '当前相关' : 'current'}</small>
        </button>
        <button className={tab === 'prepare' ? 'active' : ''} onClick={() => onTabChange('prepare')}>
          <span>{zh ? '准备' : 'Prepare'}</span>
          <small>{prep.length} {zh ? '资产' : 'items'}</small>
        </button>
      </div>

      {tab === 'opportunities' ? <OpportunityDecisionList read={read} onOpenOpportunity={onOpenOpportunity} /> : null}
      {tab === 'prepare' ? <PreparePanel prep={prep} /> : null}
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

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-card"><strong>{title}</strong><p>{text}</p></div>
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

import { useEffect, useMemo, useRef, useState } from 'react'
import BrandMark from './BrandMark.js'
import { BRAND_NAME, brandDocumentTitle } from './brand.js'
import {
  applyActionStatusChangeSet,
  exportLocalSnapshot,
  replaceImportedData,
} from './db.js'
import { parsePJSDASWorkbook } from './importExcelV2.js'
import { prepPriorityRank, presentPrepPriority, presentPrepSourceState } from './prepSemantics.js'
import { buildPrepGraph } from './prepGraph.js'
import { presentPrepGraphLinkExplanation } from './prepGraphPresentation.js'
import { presentStageLabel } from './stagePresentation.js'
import { currentUiLanguage, useUiLanguage } from './uiLanguage.js'
import { DEFAULT_DECISION_RULES, type DecisionRules } from './decisionRules.js'
import RulesView from './RulesView.js'
import TimelineView from './TimelineView.js'
import CloudSettingsCard from './cloud/CloudSettingsCard.js'
import { useCloud } from './cloud/CloudContext.js'
import { ensureAuthoritativePersistence } from './cloud/authoritativePersistence.js'
import { connectedWorkspaceAuthorityEnabled } from './cloud/connectedWorkspaceRepository.js'
import { getAccountCheckpoint } from './cloud/syncState.js'
import {
  refreshConnectedAuthoritativeCache,
  TODAY_AUTHORITATIVE_REFRESH_INTERVAL_MS,
} from './cloud/authoritativeReadModelClient.js'
import {
  createConnectedCommandId,
  confirmConnectedCommand,
  listAccountPendingOperations,
  executeConnectedBusinessCommand,
  undoConnectedBusinessCommand,
} from './cloud/authoritativeCommandClient.js'
import DiscoveryProfileCard from './DiscoveryProfileCard.js'
import DiscoveryInboxView from './DiscoveryInboxView.js'
import PrepGraphDock from './PrepGraphDock.js'
import ProcessEventDock from './ProcessEventDock.js'
import LocalBackupDock from './LocalBackupDock.js'
import ConnectedMigrationCard from './cloud/ConnectedMigrationCard.js'
import OriginTransitionNotice from './OriginTransitionNotice.js'
import OpportunityDetailDrawer, { type OpportunityDetailDestination } from './OpportunityDetailDrawer.js'
import JobLibrary, { type JobFilter } from './jobs/JobLibrary.js'
import {
  buildOpportunityDecisionList,
  getOpportunityDecisionRead,
  type OpportunityDecisionListRead,
} from './opportunityDecisionRead.js'
import TellPjsdasCapture from './TellPjsdasCapture.js'
import TodayFeature, { type TodayFreshnessView } from './today/TodayFeature.js'
import { selectTodayWeb } from './today/todayWebSelector.js'
import { buildScheduleStream, type ScheduleEntry } from './schedule/scheduleStream.js'
import ScheduleFeature from './schedule/ScheduleFeature.js'
import DecisionRequestsView from './DecisionRequestsView.js'
import { type TodayBriefAction } from './todayBrief.js'
import type {
  Action,
  DecisionRequest,
  ImportBundle,
  ImportMeta,
  Prep,
  TimelineRecord,
  ScheduleNodeTemporal,
} from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import './surfaceConsolidation.css'
import './interactionDetail.css'
import './webConsole.css'
import './ultimateWeb.css'
import './opportunityDecision.css'
import './cgr02Tokens.css'
import './tsui02.css'

type Surface = 'today' | 'opportunities' | 'schedule' | 'decisions' | 'history' | 'settings'
type PrimarySurface = 'today' | 'opportunities' | 'schedule'
type OpportunityTab = 'opportunities' | 'prepare' | 'discovery'
type CompletionFeedback = { id: string; title: string; previousStatus: Action['status']; commandId?: string; outcome: 'done' | 'no_write' | 'error'; error?: string }
type RouteState = {
  surface: Surface
  capture: boolean
  agendaExpanded: boolean
  opportunityId?: string
  decisionRequestId?: string
  returnOpportunityId?: string
}

const APP_BASE = import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '')
// Deployment rollback disables the new Today/capture write surface while the
// authoritative read model and receipts stay intact. No old snapshot writer is revived.
const CGR02_TODAY_READ_ONLY = import.meta.env.VITE_PJSDAS_CGR02_READ_ONLY === 'true'

const surfaceLabels: Record<PrimarySurface, { zh: string; en: string; hintZh: string; hintEn: string }> = {
  today: { zh: '今天', en: 'Today', hintZh: '下一步', hintEn: 'Next' },
  opportunities: { zh: '岗位库', en: 'Jobs', hintZh: '岗位与流程', hintEn: 'Jobs' },
  schedule: { zh: '日程', en: 'Schedule', hintZh: '招聘节点', hintEn: 'Schedule' },
}

const primarySurfaces: PrimarySurface[] = ['today', 'opportunities', 'schedule']

function semanticPath(pathname = window.location.pathname) {
  if (APP_BASE && pathname.startsWith(APP_BASE)) return pathname.slice(APP_BASE.length) || '/'
  return pathname || '/'
}

function browserPath(path: string) {
  return `${APP_BASE}${path}` || '/'
}

function routeFromPath(pathname = semanticPath() + window.location.search): RouteState {
  const url = new URL(pathname, 'https://pjsdas.invalid')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  if (path === '/capture' || path === '/today/capture') return { surface: 'today', capture: true, agendaExpanded: false }
  if (path === '/decisions') return { surface: 'decisions', capture: false, agendaExpanded: false }
  const decisionMatch = path.match(/^\/decisions\/([^/]+)$/)
  if (decisionMatch?.[1]) return { surface: 'decisions', capture: false, agendaExpanded: false,
    decisionRequestId: decodeURIComponent(decisionMatch[1]),
    returnOpportunityId: url.searchParams.get('from') || undefined }
  if (path === '/settings') return { surface: 'settings', capture: false, agendaExpanded: false }
  if (path === '/history') return { surface: 'history', capture: false, agendaExpanded: false }
  if (path === '/today/agenda' || path === '/schedule') return { surface: 'schedule', capture: false, agendaExpanded: path === '/today/agenda' }
  if (path === '/today' || path === '/') return { surface: 'today', capture: false, agendaExpanded: false }
  if (path === '/opportunities' || path === '/library') return { surface: 'opportunities', capture: false, agendaExpanded: false }
  const match = path.match(/^\/(?:opportunities|library)\/([^/]+)$/)
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
  const [opportunityView, setOpportunityView] = useState<JobFilter>('all')
  const [jobVisibleCount, setJobVisibleCount] = useState(40)
  const [opportunityQuery, setOpportunityQuery] = useState('')
  const detailOrigin = useRef<{ path: string; scrollY: number; actionId?: string; opportunityId?: string } | null>(null)
  const [lastCompletedAction, setLastCompletedAction] = useState<CompletionFeedback | null>(null)
  const [snapshot, setSnapshot] = useState<PJSDASSnapshot>()
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => new Date())
  const budgetMinutes = 180
  const topbarRef = useRef<HTMLElement>(null)

  // Presentation-only offset follows wrapping and text size; no workspace state.
  useEffect(() => {
    const topbar = topbarRef.current
    const shell = topbar?.closest<HTMLElement>('.cgr-app-shell')
    if (!topbar || !shell) return
    const measure = () => shell.style.setProperty('--ta-header-height', topbar.getBoundingClientRect().height + 'px')
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(topbar)
    return () => { observer.disconnect(); shell.style.removeProperty('--ta-header-height') }
  }, [])

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

  useEffect(() => {
    document.title = brandDocumentTitle(route.capture ? 'capture' : surface, lang)
  }, [surface, route.capture, lang])

  useEffect(() => {
    const origin = detailOrigin.current
    if (selectedOpportunityId || !origin || origin.path !== semanticPath() + window.location.search) return
    detailOrigin.current = null
    restoreDetailOrigin(origin)
  }, [selectedOpportunityId, surface])

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
    if (CGR02_TODAY_READ_ONLY) {
      navigate('/today')
      return
    }
    const current = semanticPath() + window.location.search
    setCaptureContextOpportunityId(route.opportunityId)
    setCaptureReturnPath(current === '/capture' || current === '/today/capture' ? '/today' : current)
    navigate('/today/capture')
  }

  function closeCapture() {
    navigate(captureReturnPath || '/today', true)
    if (captureContextOpportunityId) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('.job-detail-page .job-detail-capture, .opportunity-detail-drawer .cgr-context-capture')?.focus()
      })
    }
    setCaptureContextOpportunityId(undefined)
  }

  useEffect(() => {
    const path = semanticPath()
    // The signed MCP review lives in the URL fragment until the review
    // component verifies it. Keep that fragment through the root redirect.
    const proposalHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).has('pjsdas-proposal')
      ? window.location.hash : ''
    if (path === '/') {
      window.history.replaceState(null, '', `${browserPath('/today')}${proposalHash}`)
      setRoute(routeFromPath('/today'))
    } else if (path === '/capture' || (CGR02_TODAY_READ_ONLY && path === '/today/capture')) {
      const safePath = CGR02_TODAY_READ_ONLY ? '/today' : '/today/capture'
      window.history.replaceState(null, '', `${browserPath(safePath)}${proposalHash}`)
      setRoute(routeFromPath(safePath))
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
    if ((surface !== 'today' && surface !== 'schedule') || !accountKey || !connectedWorkspaceAuthorityEnabled()) {
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
        state: workspaceEmpty && (initial || current.state === 'unavailable') ? 'initial' : 'refreshing',
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
              ? 'Authoritative state changed while this client also has local changes; TodayAction did not overwrite either side.'
              : result.state === 'local_changes_pending'
                ? 'This client has local changes that have not been projected to authoritative state.'
                : 'A non-empty local workspace has not yet been safely bound to this account.',
          })
        }
      } catch (caught) {
        if (!active) return
        const hasVerifiedCache = Boolean(getAccountCheckpoint(accountKey).lastSyncedVersion)
        setTodayFreshness({
          state: hasVerifiedCache ? 'cached' : 'unavailable',
          detail: 'Authoritative refresh is unavailable; no new state was applied.',
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



  const accountKey = cloud.session?.user.id ?? 'local-workspace'
  const workspaceRevision = snapshot ? [cloud.session?.user.id ? getAccountCheckpoint(cloud.session.user.id).lastSyncedVersion ?? 'pending' : 'local', snapshot.exportedAt].join(':') : ''
  const todayWeb = useMemo(() => snapshot ? selectTodayWeb(snapshot, { availableMinutes: budgetMinutes }, { now, timezone, workspaceVersion: workspaceRevision }) : undefined, [snapshot, budgetMinutes, now, timezone, workspaceRevision])
  const criticalTodayWarnings = todayWeb?.criticalWarnings ?? []
  const scheduleStream = useMemo(() => snapshot ? buildScheduleStream(snapshot, { accountKey, workspaceRevision, timezone, now }) : undefined, [snapshot, accountKey, workspaceRevision, timezone, now])

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
  const selectedDecisionRequests: DecisionRequest[] = selectedOpportunity
    ? decisionRequests.filter((request) => request.state === 'open' && (
      request.affectedObjects.some((object) => object.type === 'opportunity' && object.id === selectedOpportunity.id)
      || request.choices.some((choice) => choice.resolution?.opportunityId === selectedOpportunity.id)
    ))
    : []
  const captureOpportunity = captureContextOpportunityId
    ? opportunities.find((item) => item.id === captureContextOpportunityId)
    : undefined
  const selectedProcess = selectedOpportunity
    ? processes.find((item) => item.opportunityId === selectedOpportunity.id)
    : undefined
  const selectedGroup = selectedOpportunity?.applicationGroupId
    ? groups.find((item) => item.id === selectedOpportunity.applicationGroupId)
    : undefined
  const selectedActions = selectedOpportunity
    ? actions.filter((item) => item.opportunityId === selectedOpportunity.id)
    : []
  const selectedTimeline = selectedOpportunity
    ? timeline.filter((item) => item.opportunityId === selectedOpportunity.id)
    : []
  const selectedOpportunityDecision = selectedOpportunity && snapshot
    ? getOpportunityDecisionRead(snapshot, selectedOpportunity.id, {
        now,
        timezone,
        workspaceVersion: `web:${snapshot.exportedAt}`,
      })
    : undefined
  const selectedRelatedPrep = useMemo(() => {
    if (!snapshot || !selectedOpportunityId) return []
    const graph = buildPrepGraph(snapshot.data.prep, snapshot.data.opportunities, snapshot.data.processes, now)
    return graph.nodes.flatMap((node) => {
      const link = node.links.find((item) => item.opportunityId === selectedOpportunityId)
      return link ? [{ id: node.prepId, title: node.title,
        reason: presentPrepGraphLinkExplanation(link, graph.needs, zh) }] : []
    })
  }, [snapshot, selectedOpportunityId, now, zh])


  async function markAction(id: string, status: Action['status']) {
    const before = actions.find((item) => item.id === id)
    if (!before) return
    let authoritativeCommandId: string | undefined
    try {
      if (cloud.session && connectedWorkspaceAuthorityEnabled()) {
        authoritativeCommandId = createConnectedCommandId('web-action')
        const command = before.kind === 'apply' && status === 'done'
          ? { commandId: authoritativeCommandId, kind: 'record_application_submission' as const, opportunityId: before.opportunityId! }
          : { commandId: authoritativeCommandId, kind: 'set_action_status' as const, actionId: id, status }
        if (before.kind === 'apply' && status === 'done' && !before.opportunityId) throw new Error('Application action has no exact opportunity identity.')
        const result = await executeConnectedBusinessCommand(cloud.session.user.id, {
          type: 'domain',
          value: command,
        }, { commandId: authoritativeCommandId })
        if (result.outcome === 'CONFLICT') throw new Error(result.conflict?.message ?? 'Action update conflicted with newer authoritative state.')
        if (result.outcome === 'NO_WRITE') {
          await reload()
          setLastCompletedAction({ id: before.id, title: before.title, previousStatus: before.status, outcome: 'no_write' })
          return
        }
      } else {
        if (before.kind === 'apply' && status === 'done') throw new Error('确认投递需要已连接的账户；此操作未写入。')
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
          outcome: 'done',
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
        outcome: 'error',
      })
    }
  }

  async function undoLastCompletion() {
    const item = lastCompletedAction
    if (!item || item.outcome !== 'done') return
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
      setLastCompletedAction({ ...item, outcome: 'error', error: caught instanceof Error ? caught.message : String(caught) })
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
    const active = document.activeElement as HTMLElement | null
    detailOrigin.current = {
      path: selectedOpportunityId ? '/library' : semanticPath() + window.location.search,
      scrollY: window.scrollY,
      actionId: active?.closest<HTMLElement>('[data-action-id]')?.dataset.actionId,
      opportunityId: active?.closest<HTMLElement>('[data-opportunity-id]')?.dataset.opportunityId,
    }
    navigate('/library/' + encodeURIComponent(id))
    window.requestAnimationFrame(() => window.scrollTo(0, 0))
  }

  function restoreDetailOrigin(origin: { scrollY: number; actionId?: string; opportunityId?: string }) {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      window.scrollTo(0, origin.scrollY)
      if (origin.actionId) {
        const row = [...document.querySelectorAll<HTMLElement>('.tsui-task-row[data-action-id]')]
          .find((element) => element.dataset.actionId === origin.actionId)
        row?.querySelector<HTMLElement>('.tsui-task-context')?.focus()
      } else if (origin.opportunityId) {
        const row = [...document.querySelectorAll<HTMLElement>('.opportunity-decision-row[data-opportunity-id]')]
          .find((element) => element.dataset.opportunityId === origin.opportunityId)
        row?.focus()
      }
    }))
  }

  function closeOpportunity() {
    const origin = detailOrigin.current
    detailOrigin.current = null
    navigate(origin?.path ?? '/library', true)
    if (origin) restoreDetailOrigin(origin)
  }

  async function executeTodayAction(item: TodayBriefAction) {
    if (item.execution.externalUrl) {
      window.open(item.execution.externalUrl, '_blank', 'noopener,noreferrer')
      return
    }
    if (item.execution.operation === 'start_prep') {
      setOpportunityTabExplicit(true)
      setOpportunityTab('prepare')
      navigate('/library')
      return
    }
    if (item.execution.operation === 'open_group_decision') {
      setOpportunityTabExplicit(true)
      setOpportunityTab('opportunities')
      navigate('/library')
      return
    }
    if (item.opportunityId) {
      openOpportunity(item.opportunityId)
      return
    }
    await markAction(item.actionId, 'doing')
  }

  async function scheduleOccurrenceCommand(entry: ScheduleEntry, kind: 'complete' | 'cancel' | 'reschedule', date?: string) {
    const account = cloud.session?.user.id
    if (!account || !connectedWorkspaceAuthorityEnabled() || CGR02_TODAY_READ_ONLY) {
      throw new Error(zh ? '连接权威工作区后才能记录这次安排。' : 'Connect the authoritative workspace before updating this occurrence.')
    }
    if (!entry.occurrenceId || !entry.node) throw new Error('Schedule occurrence identity is unavailable.')
    const pending = listAccountPendingOperations(account).find((item) => {
      const value = item.command?.type === 'domain' ? item.command.value : undefined
      return item.action === 'command' && value && 'occurrenceId' in value
        && value.occurrenceId === entry.occurrenceId
        && ['complete_occurrence', 'cancel_occurrence', 'reschedule_occurrence'].includes(value.kind)
    })
    const commandId = pending?.commandId ?? createConnectedCommandId('web-occurrence')
    function rescheduledTemporal(): ScheduleNodeTemporal {
      const original = entry.node!.temporal
      if (original.precision === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error(zh ? '请先选择真实日期。' : 'Choose a real date first.')
        return { shape: 'date_only', precision: 'date', timezone: 'floating-date',
          date, resolutionBasis: 'user_explicit' }
      }
      const start = date ? new Date(date) : new Date('')
      if (!Number.isFinite(start.getTime())) throw new Error(zh ? '请先选择真实日期和时间。' : 'Choose a real date and time first.')
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      const startAt = start.toISOString()
      if (original.shape === 'deadline') return {
        shape: 'deadline', precision: 'datetime', timezone, deadlineAt: startAt, resolutionBasis: 'user_explicit',
      }
      const oldStart = original.startAt ? new Date(original.startAt).getTime() : NaN
      const oldEnd = original.endAt ? new Date(original.endAt).getTime() : NaN
      const endAt = Number.isFinite(oldStart) && Number.isFinite(oldEnd)
        ? new Date(start.getTime() + (oldEnd - oldStart)).toISOString() : undefined
      if (original.shape === 'availability_window' && !endAt) throw new Error('The original window has no valid end; review the source before rescheduling.')
      return { shape: original.shape === 'availability_window' ? 'availability_window' : 'fixed_range',
        precision: 'datetime', timezone, startAt, endAt, resolutionBasis: 'user_explicit' }
    }
    const command = kind === 'complete'
      ? { commandId, kind: 'complete_occurrence' as const, occurrenceId: entry.occurrenceId }
      : kind === 'cancel'
        ? { commandId, kind: 'cancel_occurrence' as const, occurrenceId: entry.occurrenceId }
        : { commandId, kind: 'reschedule_occurrence' as const, occurrenceId: entry.occurrenceId,
          temporal: rescheduledTemporal() }
    const result = pending
      ? await confirmConnectedCommand(account, commandId)
      : await executeConnectedBusinessCommand(account, { type: 'domain', value: command }, { commandId })
    if (result.outcome === 'CONFLICT') throw new Error(result.conflict?.message ?? 'Schedule change conflicts with newer authoritative state.')
    await reload()
    const actualKind = pending?.command?.type === 'domain' ? pending.command.value.kind : command.kind
    const message = result.outcome === 'NO_WRITE'
      ? (zh ? '没有写入变化，请核对最新安排。' : 'No change was written; review the latest occurrence.')
      : result.outcome === 'ALREADY_APPLIED'
        ? (zh ? '服务器确认原操作已处理，没有重复写入。' : 'The original operation was already applied; no duplicate was written.')
        : actualKind === 'complete_occurrence' ? (zh ? '已确认完成这次安排。' : 'This occurrence was marked complete.')
          : actualKind === 'cancel_occurrence' ? (zh ? '已取消这次安排。' : 'This occurrence was cancelled.')
            : (zh ? '已按确认日期改期。' : 'This occurrence was rescheduled to the confirmed date.')
    return { outcome: result.outcome, commandId, message }
  }

  async function undoScheduleOccurrenceCommand(targetCommandId: string) {
    const account = cloud.session?.user.id
    if (!account || !connectedWorkspaceAuthorityEnabled()) throw new Error('Authoritative workspace is unavailable.')
    const pending = listAccountPendingOperations(account).find((item) => item.action === 'undo' && item.targetCommandId === targetCommandId)
    const result = await undoConnectedBusinessCommand(account, targetCommandId,
      pending ? { commandId: pending.commandId } : {})
    if (result.outcome === 'CONFLICT') throw new Error(result.conflict?.message ?? 'Undo conflicts with a dependent update.')
    if (result.outcome === 'NO_WRITE') throw new Error('Undo did not write a change.')
    await reload()
  }

  function navigateFromDetail(destination: OpportunityDetailDestination) {
    if (destination === 'today') navigate('/today')
    if (destination === 'schedule') navigate('/schedule')
    if (destination === 'prepare') {
      setOpportunityTabExplicit(true)
      setOpportunityTab('prepare')
      navigate('/library')
    }
    if (destination === 'opportunities') {
      setOpportunityTabExplicit(true)
      setOpportunityTab('opportunities')
      navigate('/opportunities')
    }
  }

  return (
    <div className="app-shell surface-shell ultimate-shell cgr-shell cgr-app-shell">
      <header ref={topbarRef} className="tsui-topbar">
        <button className="tsui-brand" type="button" onClick={() => navigate('/today')} aria-label={zh ? 'TodayAction，今天' : 'TodayAction, Today'}><BrandMark className="tsui-brand-mark" /><strong>{BRAND_NAME}</strong></button>
        <nav className="tsui-primary-nav" aria-label={zh ? '主导航' : 'Primary navigation'}>
          {primarySurfaces.map((item) => {
            const label = surfaceLabels[item]
            return <button key={item} type="button" className={surface === item ? 'active' : ''} aria-current={surface === item ? 'page' : undefined} onClick={() => { if (item === 'opportunities') setOpportunityTab('opportunities'); navigate(item === 'today' ? '/today' : item === 'schedule' ? '/schedule' : '/library') }}>{zh ? label.zh : label.en}</button>
          })}
        </nav>
        <div className="tsui-top-actions">
          <button className="tsui-tell-button" type="button" onClick={openCapture} disabled={CGR02_TODAY_READ_ONLY}>{zh ? '＋ 告诉 TodayAction' : '＋ Tell TodayAction'}</button>
          <button className="tsui-settings-button" type="button" aria-label={zh ? '设置' : 'Settings'} onClick={() => navigate('/settings')}>⚙</button>
        </div>
      </header>

      <main className="main-panel surface-main ultimate-main cgr-main">
        {surface === 'settings' ? <OriginTransitionNotice onOpenSettings={() => navigate('/settings')} /> : null}
        {loading ? <div className="empty-card">{zh ? '正在读取工作区…' : 'Loading workspace…'}</div> : null}

        {!loading && surface === 'today' && todayWeb && scheduleStream ? (
          <TodayFeature
            selection={todayWeb}
            criticalWarnings={criticalTodayWarnings}
            stream={scheduleStream}
            opportunities={opportunities}
            readOnly={CGR02_TODAY_READ_ONLY}
            now={now}
            workspaceEmpty={workspaceEmpty}
            freshness={workspaceEmpty && (cloud.loading || (connectedWorkspaceAuthorityEnabled() && cloud.session?.user.id && todayFreshness.state === 'local')) ? { state: 'initial' } : todayFreshness}
            onStart={navigateFromStart}
            onRetry={() => window.dispatchEvent(new Event('focus'))}
            onOpenDecisions={() => navigate('/decisions')}
            onOpenDecision={(id) => navigate('/decisions/' + encodeURIComponent(id))}
            onOpenAgenda={() => navigate('/schedule')}
            onOpenUnresolved={() => navigate('/schedule?view=unresolved')}
            onExecute={executeTodayAction}
            onMark={markAction}
            onOpenOpportunity={openOpportunity}
          />
        ) : null}

        {!loading && surface === 'schedule' && scheduleStream ? <ScheduleFeature stream={scheduleStream} opportunities={opportunities} onOpenOpportunity={openOpportunity}
          canWrite={Boolean(cloud.session && connectedWorkspaceAuthorityEnabled() && !CGR02_TODAY_READ_ONLY)}
          onOccurrenceCommand={scheduleOccurrenceCommand} onUndoOccurrenceCommand={undoScheduleOccurrenceCommand} /> : null}

        {!loading && surface === 'opportunities' && opportunityDecisionList && !selectedOpportunityId ? (
          <OpportunitiesSurface read={opportunityDecisionList} opportunities={opportunities} prep={prep} tab={opportunityTab} onTabChange={chooseOpportunityTab}
            view={opportunityView} onViewChange={setOpportunityView} query={opportunityQuery} onQueryChange={setOpportunityQuery}
            visibleCount={jobVisibleCount} onVisibleCountChange={setJobVisibleCount} onOpenOpportunity={openOpportunity} />
        ) : null}
        {!loading && surface === 'opportunities' && selectedOpportunityId && !selectedOpportunity ? (
          <section className="surface-panel cgr-missing-opportunity" role="status">
            <h2>{zh ? '无法打开这项岗位' : 'This job is unavailable'}</h2>
            <p>{zh ? '当前账户没有这项岗位。可重新读取，或返回原来的页面。' : 'This job is unavailable in the current account. Reload or return to the prior page.'}</p>
            <div className="surface-tool-row"><button type="button" onClick={() => { void reload() }}>{zh ? '重新读取' : 'Retry loading'}</button><button type="button" onClick={closeOpportunity}>{zh ? '返回' : 'Back'}</button></div>
          </section>
        ) : null}
        {!loading && surface === 'opportunities' && selectedOpportunity ? (
          <OpportunityDetailDrawer asPage
            returnLabel={detailOrigin.current?.path.startsWith('/today') ? (zh ? '返回今天' : 'Back to Today') : detailOrigin.current?.path.startsWith('/schedule') ? (zh ? '返回日程' : 'Back to Schedule') : (zh ? '返回岗位库' : 'Back to jobs')}
            opportunity={selectedOpportunity} decision={selectedOpportunityDecision} process={selectedProcess}
            actions={selectedActions} decisionRequests={selectedDecisionRequests} relatedPrep={selectedRelatedPrep}
            applicationGroup={selectedGroup} timeline={selectedTimeline} onClose={closeOpportunity}
            onCapture={openCapture} onNavigate={navigateFromDetail}
            onOpenDecision={(id) => navigate('/decisions/' + encodeURIComponent(id) + '?from=' + encodeURIComponent(selectedOpportunity.id))}
            onMarkAction={markAction} readOnly={CGR02_TODAY_READ_ONLY}
          />
        ) : null}
        {!loading && surface === 'decisions' ? <DecisionRequestsView requests={decisionRequests} focusRequestId={route.decisionRequestId}
          onShowAll={() => navigate('/decisions')}
          onReturnOpportunity={route.returnOpportunityId ? () => navigate('/library/' + encodeURIComponent(route.returnOpportunityId!)) : undefined}
          onChanged={reload} /> : null}
        {!loading && surface === 'history' ? <ActivitySurface timeline={timeline} /> : null}
        {!loading && surface === 'settings' ? <SettingsSurface lastImport={lastImport} rules={rules} onChanged={reload} onOpenActivity={() => navigate('/history')} /> : null}
      </main>



      <TellPjsdasCapture
        open={!CGR02_TODAY_READ_ONLY && route.capture}
        onClose={closeCapture}
        onChanged={reload}
        onOpenDecisions={() => navigate('/decisions')}
        contextLabel={captureOpportunity ? `${captureOpportunity.company} · ${captureOpportunity.role}` : undefined}
        contextRefs={captureOpportunity ? [`opportunity:${captureOpportunity.id}`] : []}
      />

      {lastCompletedAction ? (
        <div className="action-undo-toast" role="status" aria-live="polite">
          <div>
            <strong>{lastCompletedAction.outcome === 'error' ? (zh ? '操作未确认' : 'Action not confirmed') : lastCompletedAction.outcome === 'no_write' ? (zh ? '没有写入变化' : 'No change written') : (zh ? '已完成' : 'Completed')}</strong>
            <span>{lastCompletedAction.error ?? lastCompletedAction.title}</span>
          </div>
          {lastCompletedAction.outcome === 'done' ? <button type="button" onClick={() => { void undoLastCompletion() }}>{zh ? '撤销' : 'Undo'}</button> : null}
        </div>
      ) : null}
    </div>
  )
}

function OpportunitiesSurface({
  read, opportunities, prep, tab, onTabChange, view, onViewChange, query, onQueryChange,
  visibleCount, onVisibleCountChange, onOpenOpportunity,
}: {
  read: OpportunityDecisionListRead
  opportunities: PJSDASSnapshot['data']['opportunities']
  prep: Prep[]
  tab: OpportunityTab
  onTabChange: (tab: OpportunityTab) => void
  view: JobFilter
  onViewChange: (view: JobFilter) => void
  query: string
  onQueryChange: (query: string) => void
  visibleCount: number
  onVisibleCountChange: (count: number) => void
  onOpenOpportunity: (id: string) => void
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  return <section className="opportunities-surface">
    {tab === 'opportunities' ? <>
      <JobLibrary read={read} opportunities={opportunities} filter={view} onFilterChange={onViewChange}
        query={query} onQueryChange={onQueryChange} visibleCount={visibleCount}
        onVisibleCountChange={onVisibleCountChange} onOpenOpportunity={onOpenOpportunity} />
      <div className="tsui-library-secondary">
        <button type="button" onClick={() => onTabChange('prepare')}>{zh ? '准备资产' : 'Preparation'} · {prep.length}</button>
        <button type="button" onClick={() => onTabChange('discovery')}>{zh ? '发现箱' : 'Discovery inbox'}</button>
      </div>
    </> : <>
      <button className="tsui-library-back" type="button" onClick={() => onTabChange('opportunities')}>← {zh ? '返回岗位库' : 'Back to jobs'}</button>
      {tab === 'prepare' ? <PreparePanel prep={prep} /> : <DiscoveryInboxView />}
    </>}
  </section>
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
      <SurfaceHeader eyebrow="SETTINGS" title={zh ? '设置' : 'Settings'} text={zh ? '连接、偏好与数据管理。' : 'Connections, preferences, and data.'} />
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
          <div className="settings-inline-tool"><div><strong>{zh ? '流程恢复工具' : 'Process recovery'}</strong><p>{zh ? '日常输入请使用全局“告诉 TodayAction”。这里只有自动化无法恢复时才使用的低频流程工具。' : 'Use global Tell TodayAction for normal input. This low-frequency tool is only for process recovery when automation cannot repair the state.'}</p></div><div className="surface-tool-row"><ProcessEventDock onChanged={() => { void onChanged() }} /></div></div>
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

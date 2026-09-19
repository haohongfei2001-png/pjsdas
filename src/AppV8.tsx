import { useEffect, useMemo, useState } from 'react'
import {
  applyActionStatusChangeSet,
  applyChangeSet,
  discardChangeSet,
  getAllActions,
  getAllApplicationGroups,
  getAllChangeSets,
  getAllOpportunities,
  getAllPrep,
  getAllProcesses,
  getAllTimelineRecords,
  getDecisionRules,
  getLastImport,
  replaceImportedData,
} from './db.js'
import {
  buildTimePlan,
  computePriority,
  rankActions,
} from './decisionV3.js'
import { parsePJSDASWorkbook } from './importExcelV2.js'
import { prepPriorityRank, presentPrepPriority, presentPrepSourceState } from './prepSemantics.js'
import { presentRankingReasons } from './rankingReasonPresentation.js'
import { presentStageLabel } from './stagePresentation.js'
import { timeRisk, upcomingNodes } from './timeRisk.js'
import { presentTimeRemaining, presentTimeRiskLevel } from './timeRiskPresentation.js'
import { currentUiLanguage, useUiLanguage } from './uiLanguage.js'
import { DEFAULT_DECISION_RULES, type DecisionRules } from './decisionRules.js'
import RulesView from './RulesView.js'
import TimelineView from './TimelineView.js'
import AttentionView from './AttentionView.js'
import { summarizeCoverage } from './ingestion.js'
import CloudSettingsCard from './cloud/CloudSettingsCard.js'
import DiscoveryProfileCard from './DiscoveryProfileCard.js'
import ApplicationPortfolioDock from './ApplicationPortfolioDock.js'
import PrepGraphDock from './PrepGraphDock.js'
import ProgressInbox from './ProgressInbox.js'
import ProcessEventDock from './ProcessEventDock.js'
import LocalBackupDock from './LocalBackupDock.js'
import ConnectedMigrationCard from './cloud/ConnectedMigrationCard.js'
import OriginTransitionNotice from './OriginTransitionNotice.js'
import OpportunityDetailDrawer, { type OpportunityDetailDestination } from './OpportunityDetailDrawer.js'
import type { ChangeSetRecord } from './changeSet.js'
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
import './timeplan.css'
import './surfaceConsolidation.css'
import './interactionDetail.css'
import './webConsole.css'

type Surface = 'today' | 'opportunities' | 'attention' | 'activity' | 'settings'
type OpportunityTab = 'opportunities' | 'pipeline' | 'prepare'
type CompletionFeedback = { id: string; title: string; previousStatus: Action['status']; error?: string }

const surfaceLabels: Record<Surface, { zh: string; en: string; hintZh: string; hintEn: string }> = {
  today: { zh: '今天', en: 'Today', hintZh: '下一步', hintEn: 'Next' },
  opportunities: { zh: '机会', en: 'Opportunities', hintZh: '岗位与流程', hintEn: 'Jobs' },
  attention: { zh: 'Attention', en: 'Attention', hintZh: '需要我', hintEn: 'Needs me' },
  activity: { zh: '活动', en: 'Activity', hintZh: '发生了什么', hintEn: 'Audit' },
  settings: { zh: '设置', en: 'Settings', hintZh: '控制与数据', hintEn: 'Control' },
}

const roleLabels: Record<Opportunity['roleType'], [string, string]> = {
  core: ['核心', 'Core'],
  backup: ['保底', 'Backup'],
  reach: ['冲刺', 'Reach'],
  lottery: ['彩票', 'Long shot'],
  practice: ['练手', 'Practice'],
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
  const zh = lang === 'zh'
  const [surface, setSurface] = useState<Surface>('today')
  const [opportunityTab, setOpportunityTab] = useState<OpportunityTab>('opportunities')
  const [opportunityTabExplicit, setOpportunityTabExplicit] = useState(false)
  const [selectedOpportunityId, setSelectedOpportunityId] = useState<string>()
  const [lastCompletedAction, setLastCompletedAction] = useState<CompletionFeedback | null>(null)
  const [opportunities, setOpportunities] = useState<Opportunity[]>([])
  const [actions, setActions] = useState<Action[]>([])
  const [processes, setProcesses] = useState<ProcessRecord[]>([])
  const [prep, setPrep] = useState<Prep[]>([])
  const [groups, setGroups] = useState<ApplicationGroup[]>([])
  const [timeline, setTimeline] = useState<TimelineRecord[]>([])
  const [changeSets, setChangeSets] = useState<ChangeSetRecord[]>([])
  const [rules, setRules] = useState<DecisionRules>(() => ({ ...DEFAULT_DECISION_RULES, weights: { ...DEFAULT_DECISION_RULES.weights } }))
  const [lastImport, setLastImport] = useState<ImportMeta | undefined>()
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => new Date())

  async function reload() {
    const [nextOpportunities, nextActions, nextProcesses, nextPrep, nextGroups, nextRules, nextTimeline, nextChangeSets, nextImport] = await Promise.all([
      getAllOpportunities(), getAllActions(), getAllProcesses(), getAllPrep(), getAllApplicationGroups(),
      getDecisionRules(), getAllTimelineRecords(), getAllChangeSets(), getLastImport(),
    ])
    setOpportunities(nextOpportunities)
    setActions(nextActions)
    setProcesses(nextProcesses)
    setPrep(nextPrep)
    setGroups(nextGroups)
    setRules(nextRules)
    setTimeline(nextTimeline)
    setChangeSets(nextChangeSets)
    setLastImport(nextImport)
  }

  useEffect(() => { void reload().finally(() => setLoading(false)) }, [])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    const refresh = () => { void reload() }
    window.addEventListener('pjsdas:workspace-replaced', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pjsdas:workspace-replaced', refresh)
    }
  }, [])
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

  const ranked = useMemo(() => rankActions(actions, opportunities, now, rules), [actions, opportunities, now, rules])
  const attentionCoverage = useMemo(() => summarizeCoverage(timeline), [timeline])
  const attentionCount = changeSets.filter((item) => item.status === 'pending' || item.status === 'failed').length + attentionCoverage.exceptions.length
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
    await applyActionStatusChangeSet(id, status)
    await reload()
    if (status === 'done' && before && before.status !== 'done') {
      setLastCompletedAction({ id: before.id, title: before.title, previousStatus: before.status })
    } else if (lastCompletedAction?.id === id) setLastCompletedAction(null)
  }

  async function undoLastCompletion() {
    const item = lastCompletedAction
    if (!item) return
    try {
      await applyActionStatusChangeSet(item.id, item.previousStatus)
      await reload()
      setLastCompletedAction(null)
    } catch (caught) {
      setLastCompletedAction({ ...item, error: caught instanceof Error ? caught.message : String(caught) })
    }
  }

  async function applyPendingChangeSet(id: string) {
    await applyChangeSet(id)
    await reload()
  }

  async function discardPendingChangeSet(id: string) {
    await discardChangeSet(id)
    await reload()
  }

  function chooseOpportunityTab(tab: OpportunityTab) {
    setOpportunityTabExplicit(true)
    setOpportunityTab(tab)
  }

  function navigateFromStart() {
    setSurface('settings')
  }

  function navigateFromDetail(destination: OpportunityDetailDestination) {
    if (destination === 'today') setSurface('today')
    if (destination === 'prepare') {
      setSurface('opportunities')
      setOpportunityTabExplicit(true)
      setOpportunityTab('prepare')
    }
    if (destination === 'opportunities') {
      setSurface('opportunities')
      setOpportunityTabExplicit(true)
      setOpportunityTab('opportunities')
    }
    if (destination === 'pipeline') {
      setSurface('opportunities')
      setOpportunityTabExplicit(true)
      setOpportunityTab('pipeline')
    }
    setSelectedOpportunityId(undefined)
  }

  return (
    <div className="app-shell surface-shell">
      <aside className="sidebar surface-sidebar">
        <div className="brand">
          <span className="brand-mark">P</span>
          <div><strong>PJSDAS</strong><small>{zh ? '个人求职决策工作台' : 'Personal job-search workspace'}</small></div>
        </div>

        <nav className="surface-nav" aria-label={zh ? '主导航' : 'Primary navigation'}>
          {(Object.keys(surfaceLabels) as Surface[]).map((item) => {
            const label = surfaceLabels[item]
            return (
              <button key={item} className={surface === item ? 'nav-item active surface-nav-item' : 'nav-item surface-nav-item'} onClick={() => setSurface(item)}>
                <span>{zh ? label.zh : label.en}</span>
                <small>{item === 'attention' ? `${attentionCount} ${zh ? '项' : 'items'}` : (zh ? label.hintZh : label.hintEn)}</small>
              </button>
            )
          })}
        </nav>

        <div className="surface-sidebar-principle"><strong>{zh ? '一个问题' : 'One question'}</strong><span>{zh ? '我现在应该做什么？' : 'What should I do next?'}</span></div>
        <div className="language-switch-wrap"><span className="language-switch-label">{zh ? '界面语言' : 'Language'}</span><LanguageSwitch /></div>
        <div className="sidebar-note"><span>Local-first</span>{lastImport ? <span>{zh ? '最近导入' : 'Last import'} {formatDateTime(lastImport.importedAt)}</span> : null}</div>
      </aside>

      <main className="main-panel surface-main">
        <OriginTransitionNotice onOpenSettings={() => setSurface('settings')} />
        {loading ? <div className="empty-card">{zh ? '正在读取本地工作区…' : 'Loading local workspace…'}</div> : null}
        {!loading && surface === 'today' ? (
          <TodaySurface ranked={ranked} now={now} opportunities={opportunities} groups={groups} rules={rules} timeline={timeline} attentionCount={attentionCount} workspaceEmpty={workspaceEmpty} onStart={navigateFromStart} onOpenAttention={() => setSurface('attention')} onMark={markAction} onChanged={reload} onOpenOpportunity={setSelectedOpportunityId} />
        ) : null}
        {!loading && surface === 'opportunities' ? (
          <OpportunitiesSurface opportunities={opportunities} groups={groups} processes={processes} prep={prep} tab={opportunityTab} onTabChange={chooseOpportunityTab} onOpenOpportunity={setSelectedOpportunityId} />
        ) : null}
        {!loading && surface === 'attention' ? (
          <AttentionSurface timeline={timeline} changeSets={changeSets} onApply={applyPendingChangeSet} onDiscard={discardPendingChangeSet} />
        ) : null}
        {!loading && surface === 'activity' ? <ActivitySurface timeline={timeline} /> : null}
        {!loading && surface === 'settings' ? <SettingsSurface lastImport={lastImport} rules={rules} onChanged={reload} /> : null}
      </main>

      {selectedOpportunity ? (
        <OpportunityDetailDrawer
          opportunity={selectedOpportunity}
          process={selectedProcess}
          actions={selectedActions}
          applicationGroup={selectedGroup}
          timeline={selectedTimeline}
          onClose={() => setSelectedOpportunityId(undefined)}
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

function TodaySurface({ ranked, now, opportunities, groups, rules, timeline, attentionCount, workspaceEmpty, onStart, onOpenAttention, onMark, onChanged, onOpenOpportunity }: {
  ranked: ReturnType<typeof rankActions>
  now: Date
  opportunities: Opportunity[]
  groups: ApplicationGroup[]
  rules: DecisionRules
  timeline: TimelineRecord[]
  attentionCount: number
  workspaceEmpty: boolean
  onStart: () => void
  onOpenAttention: () => void
  onMark: (id: string, status: Action['status']) => Promise<void>
  onChanged: () => Promise<void>
  onOpenOpportunity: (id: string) => void
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [budgetMinutes, setBudgetMinutes] = useState(180)
  const plan = buildTimePlan(ranked, budgetMinutes, now, rules)
  const opportunityMap = new Map(opportunities.map((item) => [item.id, item]))
  const groupMap = new Map(groups.map((item) => [item.id, item]))
  const top = plan.planned[0]
  const upcoming = upcomingNodes(ranked, now, rules.upcomingHorizonDays, rules.upcomingNodeLimit).slice(0, 5)
  const nextHardNode = upcoming.find((item) => Boolean(item.action.dueAt))
  const latestActivity = [...timeline].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0]?.recordedAt

  return (
    <section className="surface-page today-surface">
      <SurfaceHeader eyebrow={`TODAY · ${formatDateOnly(now.toISOString())}`} title={zh ? '今天只处理下一步' : 'Only the next moves for today'} text={zh ? '默认只呈现现在值得做的事；日常事实优先由 AI / 自动化记录，Web 保留完整手工 fallback。' : 'The default view shows only what deserves attention now. AI and automation handle routine capture; the Web remains a complete manual fallback.'} />
      <div className="today-status-strip" aria-label={zh ? '工作区状态' : 'Workspace status'}>
        <div><span>{zh ? '下一硬节点' : 'Next hard node'}</span><strong>{nextHardNode?.action.dueAt ? formatDateTime(nextHardNode.action.dueAt) : (zh ? '暂无' : 'None')}</strong></div>
        <button className={attentionCount ? 'attention-hot' : ''} type="button" onClick={onOpenAttention}><span>Attention</span><strong>{attentionCount}</strong></button>
        <div><span>{zh ? '最近活动' : 'Latest activity'}</span><strong>{latestActivity ? formatDateTime(latestActivity) : (zh ? '暂无' : 'None')}</strong></div>
      </div>

      {top ? (
        <article className="surface-focus-card">
          <div className="eyebrow">START HERE</div>
          <div className="surface-focus-main">
            <div>
              <h2>{top.action.title}</h2>
              <p>{presentRankingReasons(top.reasons, zh).join(' · ') || (zh ? '当前最高优先级行动' : 'Current highest-priority action')}</p>
              {top.action.dueAt ? <TimeRiskBadge action={top.action} now={now} rules={rules} /> : null}
            </div>
            <div className="surface-focus-actions">
              {top.action.opportunityId ? <button className="secondary-button" onClick={() => onOpenOpportunity(top.action.opportunityId!)}>{zh ? '岗位详情' : 'Details'}</button> : null}
              <button className="primary-button" onClick={() => { void onMark(top.action.id, 'done') }}>{zh ? '完成' : 'Done'}</button>
            </div>
          </div>
        </article>
      ) : workspaceEmpty ? (
        <GettingStartedCard onStart={onStart} />
      ) : <EmptyState title={zh ? '今天没有可执行行动' : 'No executable action today'} text={zh ? '如果 AI / 自动化没有记录刚发生的变化，可以展开页面底部的手工 fallback。' : 'If AI or automation did not capture a recent change, open the manual fallback at the bottom of the page.'} />}

      {!workspaceEmpty ? (
        <div className="surface-two-column">
          <section className="surface-panel">
            <div className="surface-panel-head"><div><div className="eyebrow">TIME-BOXED PLAN</div><h2>{zh ? '今日行动' : 'Today plan'}</h2></div><span>{formatMinutes(plan.totalMinutes)} / {formatMinutes(plan.budgetMinutes)}</span></div>
            <div className="budget-options compact-budget-options">{[60, 180, 360].map((value) => <button key={value} className={budgetMinutes === value ? 'budget-chip active' : 'budget-chip'} onClick={() => setBudgetMinutes(value)}>{formatMinutes(value)}</button>)}</div>
            {plan.planned.length ? (
              <div className="surface-action-list">
                {plan.planned.map((item, index) => {
                  const opportunity = item.action.opportunityId ? opportunityMap.get(item.action.opportunityId) : undefined
                  const group = item.action.applicationGroupId ? groupMap.get(item.action.applicationGroupId) : undefined
                  const presentedReasons = presentRankingReasons(item.reasons, zh).join(' · ')
                  return (
                    <article className="surface-action-row" key={item.action.id}>
                      <span className="surface-rank">{index + 1}</span>
                      <div><strong>{item.action.title}</strong><small>{opportunity ? `${roleLabels[opportunity.roleType][zh ? 0 : 1]} · ${presentedReasons}` : group ? group.rule ?? group.id : presentedReasons}</small></div>
                      <div className="surface-action-controls">
                        {opportunity ? <button className="text-button" onClick={() => onOpenOpportunity(opportunity.id)}>{zh ? '详情' : 'Details'}</button> : null}
                        <button className="text-button" onClick={() => { void onMark(item.action.id, 'done') }}>{zh ? '完成' : 'Done'}</button>
                      </div>
                    </article>
                  )
                })}
              </div>
            ) : <p className="surface-muted">{zh ? '当前预算内没有可执行任务。' : 'No executable task fits the current budget.'}</p>}
          </section>

          <section className="surface-panel">
            <div className="surface-panel-head"><div><div className="eyebrow">UPCOMING</div><h2>{zh ? '近期节点' : 'Upcoming nodes'}</h2></div><span>{upcoming.length}</span></div>
            {upcoming.length ? <div className="surface-upcoming-list">{upcoming.map((item) => (
              <article key={item.action.id}>
                <div><strong>{item.action.title}</strong><small>{item.action.dueAt ? formatDateTime(item.action.dueAt) : '—'}</small></div>
                <div className="surface-upcoming-actions">{item.action.opportunityId ? <button className="text-button" onClick={() => onOpenOpportunity(item.action.opportunityId!)}>{zh ? '岗位' : 'Job'}</button> : null}{item.action.dueAt ? <TimeRiskBadge action={item.action} now={now} rules={rules} compact /> : null}</div>
              </article>
            ))}</div> : <p className="surface-muted">{zh ? '近期没有已知固定节点或硬截止。' : 'No known fixed event or hard deadline is near.'}</p>}
          </section>
        </div>
      ) : null}

      {!workspaceEmpty && plan.overrunReason ? <div className="surface-warning">{zh ? '当前可用时间不足以完整覆盖已知硬约束；PJSDAS 保留这些任务，不会为了让计划看起来可完成而隐藏它们。' : 'Current available time cannot cover every known hard constraint. PJSDAS keeps those tasks visible rather than pretending the plan fits.'}</div> : null}

      <details className="today-manual-fallback">
        <summary><div><strong>{zh ? '手工记录 fallback' : 'Manual capture fallback'}</strong><span>{zh ? '只有 AI / 自动化无法直接记录时再打开' : 'Use only when AI or automation cannot capture the change directly'}</span></div></summary>
        <div className="surface-tool-row"><ProgressInbox onChanged={() => { void onChanged() }} /><ProcessEventDock onChanged={() => { void onChanged() }} /></div>
      </details>
    </section>
  )
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
      })}</div> : <EmptyState title={zh ? '暂无在途流程' : 'No pipeline yet'} text={zh ? '流程通知通常由 AI / Gmail 自动进入；必要时使用 Today 底部的手工 fallback。' : 'Process notices normally arrive through AI or Gmail. Use Today’s manual fallback only when needed.'} />}
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

function AttentionSurface({ timeline, changeSets, onApply, onDiscard }: { timeline: TimelineRecord[]; changeSets: ChangeSetRecord[]; onApply: (id: string) => Promise<void>; onDiscard: (id: string) => Promise<void> }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  return <section className="surface-page"><SurfaceHeader eyebrow="ATTENTION" title={zh ? '这里只放真正需要你决定的事' : 'Only the exceptions that genuinely need you'} text={zh ? '普通同步、自动摄入和确定性更新不会来打扰你。冲突、待确认变更和无法安全解析的来源才进入这里。' : 'Routine sync, ingestion, and deterministic updates stay silent. Only conflicts, governed changes, and unresolved source evidence enter Attention.'} /><AttentionView timeline={timeline} changeSets={changeSets} onApplyChangeSet={onApply} onDiscardChangeSet={onDiscard} /></section>
}

function ActivitySurface({ timeline }: { timeline: TimelineRecord[] }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  return <section className="surface-page"><SurfaceHeader eyebrow="ACTIVITY" title={zh ? '系统和你都做了什么' : 'What you and PJSDAS have done'} text={zh ? 'Activity 是审计面：保留事实、命令、自动化和来源痕迹；待你决定的事项已经移到 Attention。' : 'Activity is the audit surface for facts, commands, automation, and provenance. Anything requiring your decision lives in Attention instead.'} /><TimelineView records={timeline} /></section>
}

function SettingsSurface({ lastImport, rules, onChanged }: { lastImport?: ImportMeta; rules: DecisionRules; onChanged: () => Promise<void> }) {
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
          <div className="settings-inline-tool"><div><strong>{zh ? '本地快照' : 'Local snapshot'}</strong><p>{zh ? '大版本调整、换设备或清理浏览器前导出完整快照。' : 'Export a full snapshot before major upgrades, device changes, or browser cleanup.'}</p></div><LocalBackupDock onChanged={() => { void onChanged() }} /></div>
          <div className="surface-import-card"><div><strong>{zh ? 'Excel 初始化 / 恢复' : 'Excel initialization / recovery'}</strong><p>{zh ? 'Excel 已不是日常数据源，只在初始化、历史迁移或恢复时使用。' : 'Excel is no longer the daily source of truth; use it for initialization, migration, or recovery.'}</p></div><label className="file-button">{busy ? (zh ? '处理中…' : 'Processing…') : (zh ? '选择工作簿' : 'Choose workbook')}<input type="file" accept=".xlsx,.xls" disabled={busy} onChange={(event) => { void readWorkbook(event.target.files?.[0]) }} /></label></div>
          {error ? <div className="notice error">{error}</div> : null}
          {message ? <div className="notice success">{message}</div> : null}
          {preview ? <div className="surface-import-preview"><div><strong>{preview.summary.filename}</strong><span>{preview.summary.opportunities} {zh ? '岗位' : 'opportunities'} · {preview.summary.actions} Actions</span></div><button className="primary-button" disabled={busy} onClick={() => { void commitImport() }}>{zh ? '确认导入' : 'Confirm import'}</button></div> : null}
          {lastImport ? <p className="surface-footnote">{zh ? '最近导入' : 'Last import'}：{lastImport.filename} · {formatDateTime(lastImport.importedAt)}</p> : null}
        </div>
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

function TimeRiskBadge({ action, now, rules, compact = false }: { action: Action; now: Date; rules: DecisionRules; compact?: boolean }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  if (!action.dueAt) return null
  const risk = timeRisk(action.dueAt, now, rules)
  return <div className={`deadline-countdown risk-${risk.level}${compact ? ' compact' : ''}`}><strong>{presentTimeRemaining(action.dueAt, now, zh)}</strong><span>{presentTimeRiskLevel(risk.level, zh)}</span></div>
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

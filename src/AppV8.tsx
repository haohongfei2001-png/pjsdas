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
  processNeedsReview,
  processReviewLabel,
  rankActions,
} from './decisionV3.js'
import { parsePJSDASWorkbook } from './importExcelV2.js'
import { formatTimeRemaining, timeRisk, upcomingNodes } from './timeRisk.js'
import { currentUiLanguage, useUiLanguage } from './uiLanguage.js'
import { DEFAULT_DECISION_RULES, type DecisionRules } from './decisionRules.js'
import RulesView from './RulesView.js'
import TimelineView from './TimelineView.js'
import CloudSettingsCard from './cloud/CloudSettingsCard.js'
import DiscoveryProfileCard from './DiscoveryProfileCard.js'
import DiscoveryInboxView from './DiscoveryInboxView.js'
import ApplicationPortfolioDock from './ApplicationPortfolioDock.js'
import ContinuousDiscoveryDock from './ContinuousDiscoveryDock.js'
import PrepGraphDock from './PrepGraphDock.js'
import ProgressInbox from './ProgressInbox.js'
import ProcessEventDock from './ProcessEventDock.js'
import LocalBackupDock from './LocalBackupDock.js'
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

type Surface = 'today' | 'decide' | 'prepare' | 'history' | 'settings'
type DecideTab = 'review' | 'opportunities' | 'pipeline'

const surfaceLabels: Record<Surface, { zh: string; en: string; hintZh: string; hintEn: string }> = {
  today: { zh: '今天', en: 'Today', hintZh: '做什么', hintEn: 'Act' },
  decide: { zh: '决策', en: 'Decide', hintZh: '投什么', hintEn: 'Choose' },
  prepare: { zh: '准备', en: 'Prepare', hintZh: '练什么', hintEn: 'Prepare' },
  history: { zh: '历程', en: 'History', hintZh: '发生了什么', hintEn: 'Audit' },
  settings: { zh: '设置', en: 'Settings', hintZh: '规则与数据', hintEn: 'Rules & data' },
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
      getAllOpportunities(),
      getAllActions(),
      getAllProcesses(),
      getAllPrep(),
      getAllApplicationGroups(),
      getDecisionRules(),
      getAllTimelineRecords(),
      getAllChangeSets(),
      getLastImport(),
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

  const ranked = useMemo(() => rankActions(actions, opportunities, now, rules), [actions, opportunities, now, rules])

  async function markAction(id: string, status: Action['status']) {
    await applyActionStatusChangeSet(id, status)
    await reload()
  }

  async function applyPendingChangeSet(id: string) {
    await applyChangeSet(id)
    await reload()
  }

  async function discardPendingChangeSet(id: string) {
    await discardChangeSet(id)
    await reload()
  }

  return (
    <div className="app-shell surface-shell">
      <aside className="sidebar surface-sidebar">
        <div className="brand">
          <span className="brand-mark">P</span>
          <div>
            <strong>PJSDAS</strong>
            <small>{zh ? '个人求职决策工作台' : 'Personal job-search workspace'}</small>
          </div>
        </div>

        <nav className="surface-nav">
          {(Object.keys(surfaceLabels) as Surface[]).map((item) => {
            const label = surfaceLabels[item]
            return (
              <button key={item} className={surface === item ? 'nav-item active surface-nav-item' : 'nav-item surface-nav-item'} onClick={() => setSurface(item)}>
                <span>{zh ? label.zh : label.en}</span>
                <small>{zh ? label.hintZh : label.hintEn}</small>
              </button>
            )
          })}
        </nav>

        <div className="surface-sidebar-principle">
          <strong>{zh ? '一个问题' : 'One question'}</strong>
          <span>{zh ? '我现在应该做什么？' : 'What should I do next?'}</span>
        </div>

        <div className="language-switch-wrap">
          <span className="language-switch-label">{zh ? '界面语言' : 'Language'}</span>
          <LanguageSwitch />
        </div>
        <div className="sidebar-note">
          <span>Local-first · v1.8</span>
          {lastImport ? <span>{zh ? '最近导入' : 'Last import'} {formatDateTime(lastImport.importedAt)}</span> : null}
        </div>
      </aside>

      <main className="main-panel surface-main">
        {loading ? <div className="empty-card">{zh ? '正在读取本地工作区…' : 'Loading local workspace…'}</div> : null}
        {!loading && surface === 'today' ? (
          <TodaySurface ranked={ranked} now={now} opportunities={opportunities} groups={groups} rules={rules} onMark={markAction} onChanged={reload} />
        ) : null}
        {!loading && surface === 'decide' ? (
          <DecideSurface opportunities={opportunities} groups={groups} processes={processes} />
        ) : null}
        {!loading && surface === 'prepare' ? <PrepareSurface prep={prep} /> : null}
        {!loading && surface === 'history' ? (
          <HistorySurface timeline={timeline} changeSets={changeSets} onApply={applyPendingChangeSet} onDiscard={discardPendingChangeSet} />
        ) : null}
        {!loading && surface === 'settings' ? (
          <SettingsSurface lastImport={lastImport} rules={rules} onChanged={reload} />
        ) : null}
      </main>
    </div>
  )
}

function TodaySurface({ ranked, now, opportunities, groups, rules, onMark, onChanged }: {
  ranked: ReturnType<typeof rankActions>
  now: Date
  opportunities: Opportunity[]
  groups: ApplicationGroup[]
  rules: DecisionRules
  onMark: (id: string, status: Action['status']) => Promise<void>
  onChanged: () => Promise<void>
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [budgetMinutes, setBudgetMinutes] = useState(180)
  const plan = buildTimePlan(ranked, budgetMinutes, now, rules)
  const opportunityMap = new Map(opportunities.map((item) => [item.id, item]))
  const groupMap = new Map(groups.map((item) => [item.id, item]))
  const top = plan.planned[0]
  const upcoming = upcomingNodes(ranked, now, rules.upcomingHorizonDays, rules.upcomingNodeLimit).slice(0, 5)

  return (
    <section className="surface-page today-surface">
      <SurfaceHeader eyebrow={`TODAY · ${formatDateOnly(now.toISOString())}`} title={zh ? '今天只处理下一步' : 'Only the next moves for today'} text={zh ? '计划、真实流程通知和进展录入都集中在这里；不需要先判断应该打开哪个工具。' : 'Plan, real recruiting updates, and progress capture live here so you do not have to choose a tool first.'} />

      <div className="surface-tool-strip">
        <div>
          <strong>{zh ? '快速记录' : 'Quick capture'}</strong>
          <span>{zh ? '收到通知或完成投递后，从这里更新。' : 'Update PJSDAS here after a real notification or application change.'}</span>
        </div>
        <div className="surface-tool-row">
          <ProgressInbox onChanged={() => { void onChanged() }} />
          <ProcessEventDock onChanged={() => { void onChanged() }} />
        </div>
      </div>

      {top ? (
        <article className="surface-focus-card">
          <div className="eyebrow">START HERE</div>
          <div className="surface-focus-main">
            <div>
              <h2>{top.action.title}</h2>
              <p>{top.reasons.join(' · ') || (zh ? '当前最高优先级行动' : 'Current highest-priority action')}</p>
              {top.action.dueAt ? <TimeRiskBadge action={top.action} now={now} rules={rules} /> : null}
            </div>
            <button className="primary-button" onClick={() => { void onMark(top.action.id, 'done') }}>{zh ? '完成' : 'Done'}</button>
          </div>
        </article>
      ) : <EmptyState title={zh ? '今天没有可执行行动' : 'No executable action today'} text={zh ? '如果刚收到邮件或完成了投递，用上方“快速记录”更新工作区。' : 'If something just changed, use Quick capture above to update the workspace.'} />}

      <div className="surface-two-column">
        <section className="surface-panel">
          <div className="surface-panel-head">
            <div><div className="eyebrow">TIME-BOXED PLAN</div><h2>{zh ? '今日行动' : 'Today plan'}</h2></div>
            <span>{formatMinutes(plan.totalMinutes)} / {formatMinutes(plan.budgetMinutes)}</span>
          </div>
          <div className="budget-options compact-budget-options">
            {[60, 180, 360].map((value) => (
              <button key={value} className={budgetMinutes === value ? 'budget-chip active' : 'budget-chip'} onClick={() => setBudgetMinutes(value)}>{formatMinutes(value)}</button>
            ))}
          </div>
          {plan.planned.length ? (
            <div className="surface-action-list">
              {plan.planned.map((item, index) => {
                const opportunity = item.action.opportunityId ? opportunityMap.get(item.action.opportunityId) : undefined
                const group = item.action.applicationGroupId ? groupMap.get(item.action.applicationGroupId) : undefined
                return (
                  <article className="surface-action-row" key={item.action.id}>
                    <span className="surface-rank">{index + 1}</span>
                    <div>
                      <strong>{item.action.title}</strong>
                      <small>{opportunity ? `${roleLabels[opportunity.roleType][zh ? 0 : 1]} · ${item.reasons.join(' · ')}` : group ? group.rule ?? group.id : item.reasons.join(' · ')}</small>
                    </div>
                    <button className="text-button" onClick={() => { void onMark(item.action.id, 'done') }}>{zh ? '完成' : 'Done'}</button>
                  </article>
                )
              })}
            </div>
          ) : <p className="surface-muted">{zh ? '当前预算内没有可执行任务。' : 'No executable task fits the current budget.'}</p>}
        </section>

        <section className="surface-panel">
          <div className="surface-panel-head"><div><div className="eyebrow">UPCOMING</div><h2>{zh ? '近期节点' : 'Upcoming nodes'}</h2></div><span>{upcoming.length}</span></div>
          {upcoming.length ? (
            <div className="surface-upcoming-list">
              {upcoming.map((item) => (
                <article key={item.action.id}>
                  <div><strong>{item.action.title}</strong><small>{item.action.dueAt ? formatDateTime(item.action.dueAt) : '—'}</small></div>
                  {item.action.dueAt ? <TimeRiskBadge action={item.action} now={now} rules={rules} compact /> : null}
                </article>
              ))}
            </div>
          ) : <p className="surface-muted">{zh ? '近期没有已知固定节点或硬截止。' : 'No known fixed event or hard deadline is near.'}</p>}
        </section>
      </div>

      {plan.overrunReason ? <div className="surface-warning">{zh ? '当前可用时间不足以完整覆盖已知硬约束；PJSDAS 保留这些任务，不会为了让计划看起来可完成而隐藏它们。' : 'Current available time cannot cover every known hard constraint. PJSDAS keeps those tasks visible rather than pretending the plan fits.'}</div> : null}
    </section>
  )
}

function DecideSurface({ opportunities, groups, processes }: { opportunities: Opportunity[]; groups: ApplicationGroup[]; processes: ProcessRecord[] }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [tab, setTab] = useState<DecideTab>('review')
  const active = opportunities.filter((item) => item.processStage === 'not_applied' || item.processStage === 'waiting_release').length
  const inPipeline = opportunities.filter((item) => ['screening', 'assessment', 'written_test', 'interview', 'offer'].includes(item.processStage)).length

  return (
    <section className="surface-page decide-surface">
      <SurfaceHeader eyebrow="DECIDE" title={zh ? '决定哪些机会值得占用你的时间' : 'Decide which opportunities deserve your time'} text={zh ? '发现、岗位池和在途流程不再是三个彼此割裂的产品入口，而是同一条决策链。' : 'Discovery, the opportunity pool, and recruiting pipeline now live in one decision flow.'} />

      <div className="surface-context-tabs" role="tablist">
        <button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}><span>{zh ? '发现与审阅' : 'Discover & review'}</span><small>{zh ? '新候选' : 'New candidates'}</small></button>
        <button className={tab === 'opportunities' ? 'active' : ''} onClick={() => setTab('opportunities')}><span>{zh ? '机会池' : 'Opportunities'}</span><small>{active} {zh ? '活跃' : 'active'}</small></button>
        <button className={tab === 'pipeline' ? 'active' : ''} onClick={() => setTab('pipeline')}><span>{zh ? '在途流程' : 'Pipeline'}</span><small>{inPipeline} {zh ? '在途' : 'in progress'}</small></button>
      </div>

      {tab === 'review' ? (
        <>
          <div className="surface-tool-strip">
            <div><strong>{zh ? '发现节奏' : 'Discovery cadence'}</strong><span>{zh ? '查看增量基线、来源覆盖和待复核岗位；搜索仍由 ChatGPT 完成。' : 'Inspect incremental baseline, source coverage, and refresh targets; ChatGPT still performs public search.'}</span></div>
            <div className="surface-tool-row"><ContinuousDiscoveryDock /></div>
          </div>
          <DiscoveryInboxView />
        </>
      ) : null}

      {tab === 'opportunities' ? (
        <>
          <div className="surface-tool-strip">
            <div><strong>{zh ? '组合决策' : 'Portfolio decision'}</strong><span>{zh ? '有共享投递名额时，比较整个组合，不为了凑名额推荐弱岗位。' : 'When roles share an application quota, compare the portfolio rather than filling slots.'}</span></div>
            <div className="surface-tool-row"><ApplicationPortfolioDock /></div>
          </div>
          <OpportunityTable opportunities={opportunities} groups={groups} />
        </>
      ) : null}

      {tab === 'pipeline' ? <PipelinePanel processes={processes} /> : null}
    </section>
  )
}

function OpportunityTable({ opportunities, groups }: { opportunities: Opportunity[]; groups: ApplicationGroup[] }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'active' | 'all' | 'closed'>('active')
  const now = new Date()
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return [...opportunities]
      .filter((item) => scope === 'all' || (scope === 'closed' ? item.processStage === 'closed' : item.processStage !== 'closed'))
      .filter((item) => !needle || `${item.company} ${item.role}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999))
  }, [opportunities, query, scope])

  return (
    <section className="surface-panel surface-table-panel">
      <div className="surface-panel-head"><div><div className="eyebrow">OPPORTUNITY POOL</div><h2>{zh ? '正式机会池' : 'Opportunity pool'}</h2></div><span>{filtered.length} / {opportunities.length}</span></div>
      <div className="surface-filter-row">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? '搜索公司或岗位' : 'Search company or role'} />
        <select value={scope} onChange={(event) => setScope(event.target.value as 'active' | 'all' | 'closed')}><option value="active">{zh ? '活跃' : 'Active'}</option><option value="closed">{zh ? '已结束' : 'Closed'}</option><option value="all">{zh ? '全部' : 'All'}</option></select>
      </div>
      {filtered.length ? (
        <div className="surface-table-wrap"><table><thead><tr><th>{zh ? '公司' : 'Company'}</th><th>{zh ? '岗位' : 'Role'}</th><th>{zh ? '定位' : 'Role type'}</th><th>{zh ? '时机' : 'Timing'}</th><th>Fit</th><th>{zh ? '机会价值' : 'Value'}</th><th>{zh ? '截止' : 'Deadline'}</th><th>{zh ? '申请组' : 'Group'}</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id}><td><strong>{item.company}</strong></td><td>{item.role}</td><td>{roleLabels[item.roleType][zh ? 0 : 1]}</td><td><PriorityBadge value={computePriority(item, now)} /></td><td>{item.fitScore}</td><td>{item.opportunityValue}</td><td>{item.deadline ? formatDateOnly(item.deadline) : '—'}</td><td>{item.applicationGroupId ?? '—'}</td></tr>)}</tbody></table></div>
      ) : <EmptyState title={zh ? '没有符合筛选的岗位' : 'No matching opportunities'} text={zh ? '调整搜索或筛选条件。' : 'Adjust search or filters.'} />}
      {groups.length ? <p className="surface-footnote">{zh ? `当前有 ${groups.length} 个共享申请组。组合决策只对显式关联到同一 Application Group 的岗位生效。` : `${groups.length} shared Application Groups are present. Portfolio decisions only apply to roles explicitly linked to the same group.`}</p> : null}
    </section>
  )
}

function PipelinePanel({ processes }: { processes: ProcessRecord[] }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const now = new Date()
  const sorted = [...processes].sort((a, b) => Number(processNeedsReview(b, now)) - Number(processNeedsReview(a, now)) || (a.nextCheckAt ?? '9999').localeCompare(b.nextCheckAt ?? '9999'))
  return (
    <section className="surface-panel">
      <div className="surface-panel-head"><div><div className="eyebrow">PIPELINE</div><h2>{zh ? '在途招聘流程' : 'Recruiting pipeline'}</h2></div><span>{processes.length}</span></div>
      {sorted.length ? <div className="surface-pipeline-grid">{sorted.map((item) => {
        const needsReview = processNeedsReview(item, now)
        return <article className={needsReview ? 'surface-pipeline-card risk' : 'surface-pipeline-card'} key={item.id}><div><strong>{item.company}</strong><h3>{item.role}</h3></div><span className="surface-stage">{item.stageLabel}</span><dl><div><dt>{zh ? '最近进展' : 'Last progress'}</dt><dd>{item.lastProgressAt ? formatDateOnly(item.lastProgressAt) : '—'}</dd></div><div><dt>{zh ? '下次复核' : 'Next check'}</dt><dd>{item.nextCheckAt ? formatDateTime(item.nextCheckAt) : '—'}</dd></div></dl><small>{processReviewLabel(item, now)}</small></article>
      })}</div> : <EmptyState title={zh ? '暂无在途流程' : 'No pipeline yet'} text={zh ? '真实测评、笔试和面试通知会在这里形成流程状态。' : 'Real assessments, written tests, and interviews will appear here.'} />}
    </section>
  )
}

function PrepareSurface({ prep }: { prep: Prep[] }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const order = ['最高', '高', '中高', '中', '低']
  const sorted = [...prep].sort((a, b) => order.indexOf(a.priorityLabel ?? '低') - order.indexOf(b.priorityLabel ?? '低'))
  return (
    <section className="surface-page">
      <SurfaceHeader eyebrow="PREPARE" title={zh ? '把准备时间花在能覆盖更多机会的地方' : 'Spend preparation time where it helps more opportunities'} text={zh ? 'Prep Graph 是解释层，Prep 列表是实际准备资产；两者现在属于同一个工作面。' : 'Prep Graph explains leverage while the Prep list remains the actual preparation inventory.'} />
      <div className="surface-tool-strip"><div><strong>{zh ? '准备图谱' : 'Prep Graph'}</strong><span>{zh ? '查看一个准备任务覆盖哪些岗位、命中哪些真实缺口。' : 'See which opportunities a prep item supports and which real needs it covers.'}</span></div><div className="surface-tool-row"><PrepGraphDock /></div></div>
      <section className="surface-panel"><div className="surface-panel-head"><div><div className="eyebrow">PREP INVENTORY</div><h2>{zh ? '准备资产' : 'Preparation inventory'}</h2></div><span>{prep.length}</span></div>{sorted.length ? <div className="surface-prep-grid">{sorted.map((item) => <article key={item.id}><div><span>{item.priorityLabel ?? '—'}</span><span>{item.sourceStatus ?? '—'}</span></div><h3>{item.title}</h3><p>{item.minimumOutput ?? (zh ? '暂无最小产出定义' : 'No minimum output defined')}</p><small>{formatMinutes(item.estimatedMinutes)} · {item.triggeredBy ?? (zh ? '无显式触发条件' : 'No explicit trigger')}</small></article>)}</div> : <EmptyState title={zh ? '暂无准备任务' : 'No preparation items'} text={zh ? '导入或后续维护后，准备资产会在这里出现。' : 'Preparation assets will appear here after import or maintenance.'} />}</section>
    </section>
  )
}

function HistorySurface({ timeline, changeSets, onApply, onDiscard }: { timeline: TimelineRecord[]; changeSets: ChangeSetRecord[]; onApply: (id: string) => Promise<void>; onDiscard: (id: string) => Promise<void> }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  return <section className="surface-page"><SurfaceHeader eyebrow="HISTORY" title={zh ? '事实与变更的审计记录' : 'Audit history of facts and changes'} text={zh ? 'Timeline 和 ChangeSet 留在一个低频但完整的审计面，不再与日常决策争夺一级导航。' : 'Timeline and ChangeSets live in one lower-frequency audit surface instead of competing with daily work.'} /><TimelineView records={timeline} changeSets={changeSets} onApplyChangeSet={onApply} onDiscardChangeSet={onDiscard} /></section>
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
      <SurfaceHeader eyebrow="SETTINGS" title={zh ? '偏好、规则、同步与数据安全' : 'Preferences, rules, sync, and data safety'} text={zh ? '低频配置集中在这里；它们影响决策，但不应该长期占据产品主导航。' : 'Lower-frequency configuration lives here. It governs decisions without occupying primary navigation.'} />

      <div className="surface-tool-strip"><div><strong>{zh ? '数据安全' : 'Data safety'}</strong><span>{zh ? '大版本调整、换设备或清理浏览器前，可以导出完整本地快照。' : 'Export a complete local snapshot before major upgrades, device changes, or browser cleanup.'}</span></div><div className="surface-tool-row"><LocalBackupDock onChanged={() => { void onChanged() }} /></div></div>

      <section className="surface-settings-section"><div className="surface-section-label">ACCOUNT & DISCOVERY</div><CloudSettingsCard /><DiscoveryProfileCard /></section>
      <section className="surface-settings-section"><div className="surface-section-label">DECISION POLICY</div><RulesView rules={rules} onChanged={onChanged} /></section>
      <section className="surface-settings-section">
        <div className="surface-section-label">IMPORT & RECOVERY</div>
        <div className="surface-import-card"><div><strong>{zh ? 'Excel 初始化 / 恢复' : 'Excel initialization / recovery'}</strong><p>{zh ? 'Excel 已不是日常数据源，只在初始化、历史迁移或恢复时使用。' : 'Excel is no longer the daily source of truth; use it for initialization, migration, or recovery.'}</p></div><label className="file-button">{busy ? (zh ? '处理中…' : 'Processing…') : (zh ? '选择工作簿' : 'Choose workbook')}<input type="file" accept=".xlsx,.xls" disabled={busy} onChange={(event) => { void readWorkbook(event.target.files?.[0]) }} /></label></div>
        {error ? <div className="notice error">{error}</div> : null}
        {message ? <div className="notice success">{message}</div> : null}
        {preview ? <div className="surface-import-preview"><div><strong>{preview.summary.filename}</strong><span>{preview.summary.opportunities} {zh ? '岗位' : 'opportunities'} · {preview.summary.actions} Actions</span></div><button className="primary-button" disabled={busy} onClick={() => { void commitImport() }}>{zh ? '确认导入' : 'Confirm import'}</button></div> : null}
        {lastImport ? <p className="surface-footnote">{zh ? '最近导入' : 'Last import'}：{lastImport.filename} · {formatDateTime(lastImport.importedAt)}</p> : null}
      </section>
      <section className="surface-settings-section"><div className="surface-section-label">INTERFACE</div><div className="surface-language-card"><div><strong>{zh ? '界面语言' : 'Interface language'}</strong><p>{zh ? '语言只影响界面显示，不改变工作区数据。' : 'Language affects presentation only, not workspace data.'}</p></div><LanguageSwitch /></div></section>
    </section>
  )
}

function SurfaceHeader({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <header className="surface-header"><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{text}</p></header>
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-card"><strong>{title}</strong><p>{text}</p></div>
}

function TimeRiskBadge({ action, now, rules, compact = false }: { action: Action; now: Date; rules: DecisionRules; compact?: boolean }) {
  if (!action.dueAt) return null
  const risk = timeRisk(action.dueAt, now, rules)
  return <div className={`deadline-countdown risk-${risk.level}${compact ? ' compact' : ''}`}><strong>{formatTimeRemaining(action.dueAt, now)}</strong><span>{risk.label}</span></div>
}

function PriorityBadge({ value }: { value: ReturnType<typeof computePriority> }) {
  return <span className={`priority-badge priority-${value}`}>{value === 'expired' ? 'Expired' : value === 'none' ? 'Pipeline' : value}</span>
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

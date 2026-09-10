import { useEffect, useMemo, useState } from 'react'
import {
  getAllActions,
  getAllApplicationGroups,
  getAllOpportunities,
  getAllPrep,
  getAllProcesses,
  getDecisionRules,
  getAllTimelineRecords,
  getLastImport,
  replaceImportedData,
  updateActionStatus,
} from './db'
import {
  buildTimePlan,
  computePriority,
  processNeedsReview,
  processReviewLabel,
  rankActions,
} from './decisionV3'
import { parsePJSDASWorkbook } from './importExcelV2'
import { actionNodePrefix, formatTimeRemaining, timeRisk, upcomingNodes } from './timeRisk'
import { currentUiLanguage, useUiLanguage } from './uiLanguage'
import { DEFAULT_DECISION_RULES, type DecisionRules } from './decisionRules'
import RulesView from './RulesView'
import TimelineView from './TimelineView'
import type {
  Action,
  ApplicationGroup,
  ImportBundle,
  ImportMeta,
  Opportunity,
  Prep,
  ProcessRecord,
  TimelineRecord,
} from './model'
import './timeplan.css'

type Page = 'today' | 'opportunities' | 'pipeline' | 'prep' | 'timeline' | 'rules' | 'settings'

const navigation: Page[] = ['today', 'opportunities', 'pipeline', 'prep', 'timeline', 'rules', 'settings']

const roleLabels: Record<Opportunity['roleType'], string> = {
  core: '核心',
  backup: '保底',
  reach: '冲刺',
  lottery: '彩票',
  practice: '练手',
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

function AppV5() {
  const { t } = useUiLanguage()
  const [page, setPage] = useState<Page>('today')
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

  async function reload() {
    const [nextOpportunities, nextActions, nextProcesses, nextPrep, nextGroups, nextRules, nextTimeline, nextImport] =
      await Promise.all([
        getAllOpportunities(),
        getAllActions(),
        getAllProcesses(),
        getAllPrep(),
        getAllApplicationGroups(),
        getDecisionRules(),
        getAllTimelineRecords(),
        getLastImport(),
      ])
    setOpportunities(nextOpportunities)
    setActions(nextActions)
    setProcesses(nextProcesses)
    setPrep(nextPrep)
    setGroups(nextGroups)
    setRules(nextRules)
    setTimeline(nextTimeline)
    setLastImport(nextImport)
  }

  useEffect(() => {
    reload().finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const ranked = useMemo(() => rankActions(actions, opportunities, now, rules), [actions, opportunities, now, rules])

  async function markAction(id: string, status: Action['status']) {
    await updateActionStatus(id, status)
    await reload()
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">P</span>
          <div>
            <strong>PJSDAS</strong>
            <small>{t('brand.subtitle')}</small>
          </div>
        </div>
        <nav>
          {navigation.map((item) => (
            <button
              key={item}
              className={page === item ? 'nav-item active' : 'nav-item'}
              onClick={() => setPage(item)}
            >
              {t(`nav.${item}` as 'nav.today' | 'nav.opportunities' | 'nav.pipeline' | 'nav.prep' | 'nav.timeline' | 'nav.rules' | 'nav.settings')}
            </button>
          ))}
        </nav>
        <div className="language-switch-wrap">
          <span className="language-switch-label">{t('language.label')}</span>
          <LanguageSwitch />
        </div>
        <div className="sidebar-note">
          <span>Local-first · v0.8</span>
          {lastImport ? <span>{t('sidebar.lastImport')} {formatDateTime(lastImport.importedAt)}</span> : null}
        </div>
      </aside>

      <main className="main-panel">
        {loading ? <div className="empty-card">{t('common.loading')}</div> : null}
        {!loading && page === 'today' ? (
          <TodayView
            ranked={ranked}
            now={now}
            opportunities={opportunities}
            groups={groups}
            rules={rules}
            onMark={markAction}
          />
        ) : null}
        {!loading && page === 'opportunities' ? (
          <OpportunitiesView opportunities={opportunities} groups={groups} />
        ) : null}
        {!loading && page === 'pipeline' ? <PipelineView processes={processes} /> : null}
        {!loading && page === 'prep' ? <PrepView prep={prep} /> : null}
        {!loading && page === 'timeline' ? <TimelineView records={timeline} /> : null}
        {!loading && page === 'rules' ? <RulesView rules={rules} onChanged={reload} /> : null}
        {!loading && page === 'settings' ? (
          <SettingsView lastImport={lastImport} onImported={reload} />
        ) : null}
      </main>
    </div>
  )
}

function TodayView({
  ranked,
  now,
  opportunities,
  groups,
  rules,
  onMark,
}: {
  ranked: ReturnType<typeof rankActions>
  now: Date
  opportunities: Opportunity[]
  groups: ApplicationGroup[]
  rules: DecisionRules
  onMark: (id: string, status: Action['status']) => Promise<void>
}) {
  const { lang, t } = useUiLanguage()
  const [budgetMinutes, setBudgetMinutes] = useState(180)
  const plan = buildTimePlan(ranked, budgetMinutes, now, rules)
  const opportunityMap = new Map(opportunities.map((item) => [item.id, item]))
  const groupMap = new Map(groups.map((item) => [item.id, item]))
  const top = plan.planned[0]
  const nextUnplanned = plan.nearDeadlineUnplanned[0]
  const nextFixed = plan.upcomingFixedEvents[0]
  const upcoming = upcomingNodes(ranked, now, rules.upcomingHorizonDays, rules.upcomingNodeLimit)
  const plannedIds = new Set(plan.planned.map((item) => item.action.id))

  return (
    <section className="today-page">
      <header className="page-header compact-header">
        <div>
          <div className="eyebrow">TODAY · {formatDateOnly(now.toISOString())}</div>
          <h1>{t('today.title')}</h1>
          <p>{t('today.subtitle')}</p>
        </div>
      </header>

      {top ? (
        <div className="focus-card">
          <div className="eyebrow">START HERE · {t('today.first')}</div>
          <div className="focus-row">
            <div>
              <h2>{top.action.title}</h2>
              <p>{top.reasons.join(' · ') || t('today.currentFirst')}</p>
              {top.action.dueAt ? <TimeRiskBadge action={top.action} now={now} rules={rules} /> : null}
            </div>
            <div className="focus-order">{t('today.first')}</div>
          </div>
        </div>
      ) : null}

      <div className="today-secondary-grid">
        {upcoming.length > 0 ? (
          <div className="upcoming-panel">
            <div className="upcoming-heading">
              <div>
                <div className="eyebrow">{lang === 'zh' ? `UPCOMING · 未来 ${rules.upcomingHorizonDays} 天` : `UPCOMING · NEXT ${rules.upcomingHorizonDays} DAYS`}</div>
                <h2>{t('today.upcoming')}</h2>
                <p>{t('today.upcomingText')}</p>
              </div>
              <span>{upcoming.length} {t('today.nodeCount')}</span>
            </div>
            <div className="upcoming-list">
              {upcoming.map((item) => (
                <article className="upcoming-item" key={`upcoming-${item.action.id}`}>
                  <div className="upcoming-copy">
                    <strong>{item.action.title}</strong>
                    <small>{item.action.timingMode === 'fixed' ? t('today.fixed') : t('today.deadline')} · {formatDateTime(item.action.dueAt!)}</small>
                  </div>
                  <div className="upcoming-risk">
                    <TimeRiskBadge action={item.action} now={now} rules={rules} compact />
                    {plannedIds.has(item.action.id) ? <small>{t('today.inPlan')}</small> : <small>{t('today.ahead')}</small>}
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <div className="upcoming-panel upcoming-empty">
            <div className="eyebrow">{lang === 'zh' ? `UPCOMING · 未来 ${rules.upcomingHorizonDays} 天` : `UPCOMING · NEXT ${rules.upcomingHorizonDays} DAYS`}</div>
            <h2>{t('today.upcoming')}</h2>
            <p>{t('today.upcomingText')}</p>
          </div>
        )}

        {ranked.length > 0 ? (
          <div className="budget-panel">
            <div>
              <div className="eyebrow">AVAILABLE TIME</div>
              <strong>{t('today.available')}</strong>
            </div>
            <div className="budget-options">
              {[
                { value: 60, label: t('today.hour1') },
                { value: 180, label: t('today.hour3') },
                { value: 360, label: t('today.hour6') },
              ].map((option) => (
                <button
                  key={option.value}
                  className={budgetMinutes === option.value ? 'budget-chip active' : 'budget-chip'}
                  onClick={() => setBudgetMinutes(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="budget-usage">
              <span>{t('today.plan')}</span>
              <strong>{formatMinutes(plan.totalMinutes)}</strong>
              <span>/ {formatMinutes(plan.budgetMinutes)}</span>
            </div>
          </div>
        ) : null}
      </div>

      {nextFixed ? (
        <div className="fixed-event-notice plan-notice">
          <div>
            <div className="eyebrow">UPCOMING FIXED EVENT</div>
            <strong>{nextFixed.action.title}</strong>
          </div>
          <div className="fixed-event-time">
            <span>{formatDateTime(nextFixed.action.dueAt!)}</span>
            <small>{plan.upcomingFixedEvents.length > 1 ? `未来 ${rules.fixedEventHorizonHours} 小时还有 ${plan.upcomingFixedEvents.length - 1} 个固定安排` : '固定时刻 · 不占今天可提前完成的任务预算'}</small>
          </div>
        </div>
      ) : null}

      {plan.overrunReason === 'today_deadlines' ? (
        <div className="notice error plan-notice">今天必须发生或完成的行动需要 {formatMinutes(plan.requiredTodayMinutes)}，当前预算不足 {formatMinutes(plan.overBudgetMinutes)}。系统仍把它们完整保留，避免制造“做得完”的假象。</div>
      ) : null}
      {plan.overrunReason === 'near_deadline_stretch' ? (
        <div className="notice warning plan-notice">为覆盖 ${rules.hardDeadlineHorizonHours} 小时内的下一硬截止，建议把今天的时间预算再增加 {formatMinutes(plan.overBudgetMinutes)}。相比用剩余时间塞入低优先级小任务，这个超时更值得。</div>
      ) : null}
      {!plan.overrunReason && nextUnplanned ? (
        <div className="notice warning plan-notice">{rules.hardDeadlineHorizonHours} 小时内还有 {plan.nearDeadlineUnplanned.length} 个可提前完成的硬截止无法完整装入当前预算。最近的是“{nextUnplanned.action.title}”，预计需要 {formatMinutes(nextUnplanned.action.estimatedMinutes)}；剩余时间应优先留给它。</div>
      ) : null}

      {plan.planned.length === 0 ? (
        <EmptyState
          title={t('today.empty')}
          text={nextFixed ? '近期固定安排已单独保留；它不会被误算成今天可以提前完成的任务。' : '可增加可用时间，或到 Opportunities 查看所有活跃机会。'}
        />
      ) : (
        <div className="section-block">
          <div className="section-heading">
            <div><div className="eyebrow">TIME-BOXED PLAN</div><h2>{t('today.actionPlan')}</h2></div>
            <span className="muted">{plan.planned.length} {t('common.items')} · {formatMinutes(plan.totalMinutes)}</span>
          </div>
          <div className="action-list">
            {plan.planned.map((item, index) => {
              const opportunity = item.action.opportunityId ? opportunityMap.get(item.action.opportunityId) : undefined
              const group = item.action.applicationGroupId ? groupMap.get(item.action.applicationGroupId) : undefined
              return (
                <article className="action-card" key={item.action.id}>
                  <div className="rank">{lang === 'zh' ? `第${index + 1}项` : `#${index + 1}`}</div>
                  <div className="action-copy">
                    <div className="action-line"><h3>{item.action.title}</h3><KindBadge action={item.action} /></div>
                    <p>{opportunity ? `${roleLabels[opportunity.roleType]} · ${opportunity.offerProbability ?? '成功率未知'}` : group ? `${group.id} · ${group.rule ?? '共享申请规则'}` : item.action.kind === 'prep' ? '跨岗位复用准备' : '流程管理'}</p>
                    <div className="reason-row">{item.reasons.map((reason) => <span key={reason}>{reason}</span>)}</div>
                    <small>预计 {formatMinutes(item.action.estimatedMinutes)}{item.action.dueAt ? ` · ${item.action.timingMode === 'fixed' ? t('today.fixed') : t('today.deadline')} ${formatDateTime(item.action.dueAt)}` : ''}</small>
                    {item.action.dueAt ? <TimeRiskBadge action={item.action} now={now} rules={rules} /> : null}
                  </div>
                  <div className="action-side"><button className="text-button" onClick={() => onMark(item.action.id, 'done')}>{t('common.done')}</button></div>
                </article>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

type OpportunityScope = 'active' | 'pipeline' | 'expired' | 'closed' | 'all'

function opportunityScopeMatches(item: Opportunity, scope: OpportunityScope, now: Date) {
  const priority = computePriority(item, now)
  if (scope === 'all') return true
  if (scope === 'expired') return item.processStage === 'not_applied' && priority === 'expired'
  if (scope === 'closed') return item.processStage === 'closed'
  if (scope === 'pipeline') {
    return ['screening', 'assessment', 'written_test', 'interview', 'offer'].includes(item.processStage)
  }
  return item.processStage === 'waiting_release' ||
    (item.processStage === 'not_applied' && priority !== 'expired')
}

function OpportunitiesView({ opportunities, groups }: { opportunities: Opportunity[]; groups: ApplicationGroup[] }) {
  const { t } = useUiLanguage()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<OpportunityScope>('active')
  const [role, setRole] = useState('all')
  const [priority, setPriority] = useState('all')
  const now = new Date()

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return [...opportunities]
      .filter((item) => opportunityScopeMatches(item, scope, now))
      .filter((item) => !needle || `${item.company} ${item.role}`.toLowerCase().includes(needle))
      .filter((item) => role === 'all' || item.roleType === role)
      .filter((item) => priority === 'all' || computePriority(item, now) === priority)
      .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999))
  }, [opportunities, query, scope, role, priority])

  return (
    <section>
      <PageTitle
        eyebrow="OPPORTUNITIES"
        title={t('opportunities.title')}
        text={t('opportunities.subtitle')}
      />
      {opportunities.length === 0 ? (
        <EmptyState title="机会池为空" text="先导入秋招投递表。" />
      ) : (
        <>
          <div className="toolbar">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('opportunities.search')} />
            <select value={scope} onChange={(event) => setScope(event.target.value as OpportunityScope)}>
              <option value="active">{t('opportunities.active')}</option>
              <option value="pipeline">{t('opportunities.pipeline')}</option>
              <option value="expired">{t('opportunities.expired')}</option>
              <option value="closed">{t('opportunities.closed')}</option>
              <option value="all">{t('opportunities.allRecords')}</option>
            </select>
            <select value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="all">{t('opportunities.allRoles')}</option>
              <option value="core">核心</option>
              <option value="backup">保底</option>
              <option value="reach">冲刺</option>
              <option value="lottery">彩票</option>
              <option value="practice">练手</option>
            </select>
            <select value={priority} onChange={(event) => setPriority(event.target.value)}>
              <option value="all">{t('opportunities.allTiming')}</option>
              <option value="P0">P0</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="expired">已过节点</option>
              <option value="none">在途/非待投</option>
            </select>
            <span className="toolbar-count">{filtered.length} / {opportunities.length}</span>
          </div>
          <div className="table-card">
            <table>
              <thead>
                <tr><th>{t('opportunities.company')}</th><th>{t('opportunities.role')}</th><th>{t('opportunities.roleType')}</th><th>{t('opportunities.priority')}</th><th>{t('opportunities.success')}</th><th>{t('opportunities.deadline')}</th><th>{t('opportunities.prep')}</th><th>{t('opportunities.group')}</th></tr>
              </thead>
              <tbody>
                {filtered.map((item) => {
                  const p = computePriority(item, now)
                  return (
                    <tr key={item.id}>
                      <td className="company-cell">{item.company}</td>
                      <td>{item.role}</td>
                      <td><RoleBadge role={item.roleType} /></td>
                      <td><PriorityBadge priority={p} /></td>
                      <td>{item.offerProbability ?? '—'}</td>
                      <td>{item.deadline ? formatDateTime(item.deadline) : '—'}</td>
                      <td>{item.prepEstimateMinutes ? formatMinutes(item.prepEstimateMinutes) : '—'}</td>
                      <td>{item.applicationGroupId ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {groups.length > 0 ? (
            <p className="footnote">已读取 {groups.length} 个申请组；存在共享志愿冲突时，Today 会生成一个组级行动而不是多个互相冲突的投递行动。</p>
          ) : null}
        </>
      )}
    </section>
  )
}

function PipelineView({ processes }: { processes: ProcessRecord[] }) {
  const { t } = useUiLanguage()
  const now = new Date()
  const sorted = [...processes].sort((a, b) => {
    const risk = Number(processNeedsReview(b, now)) - Number(processNeedsReview(a, now))
    if (risk) return risk
    return (a.nextCheckAt ?? '9999').localeCompare(b.nextCheckAt ?? '9999')
  })

  return (
    <section>
      <PageTitle
        eyebrow="PIPELINE"
        title={t('pipeline.title')}
        text={t('pipeline.subtitle')}
      />
      {processes.length === 0 ? (
        <EmptyState title="暂无流程数据" text="导入后将读取并重算“在途流程”。" />
      ) : (
        <div className="pipeline-grid">
          {sorted.map((item) => {
            const reviewLabel = processReviewLabel(item, now)
            const isRisk = reviewLabel === '需复核'
            return (
              <article className={isRisk ? 'pipeline-card risk' : 'pipeline-card'} key={item.id}>
                <div className="pipeline-top">
                  <div>
                    <strong>{item.company}</strong>
                    <p>{item.role}</p>
                  </div>
                  <div className="pipeline-badges">
                    {item.effectiveProcessEventId ? <span className="event-source-badge">{t('common.localEvent')}</span> : null}
                    <span className={isRisk ? 'risk-badge' : 'quiet-badge'}>{isRisk ? t('pipeline.review') : t('pipeline.waiting')}</span>
                  </div>
                </div>
                <dl>
                  <div><dt>{t('pipeline.stage')}</dt><dd>{item.stageLabel}</dd></div>
                  <div><dt>{t('pipeline.lastProgress')}</dt><dd>{item.lastProgressAt ? formatDateOnly(item.lastProgressAt) : '—'}</dd></div>
                  <div><dt>{t('pipeline.threshold')}</dt><dd>{item.reviewThresholdDays ? `${item.reviewThresholdDays} ${currentUiLanguage() === 'en' ? 'days' : '天'}` : '—'}</dd></div>
                  <div><dt>{t('pipeline.nextReview')}</dt><dd>{item.nextCheckAt ? formatDateOnly(item.nextCheckAt) : '—'}</dd></div>
                </dl>
                {item.currentAction ? <p className="pipeline-action">{item.currentAction}</p> : null}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function PrepView({ prep }: { prep: Prep[] }) {
  const { t } = useUiLanguage()
  const order = ['最高', '高', '中高', '中', '低']
  const sorted = [...prep].sort(
    (a, b) => order.indexOf(a.priorityLabel ?? '低') - order.indexOf(b.priorityLabel ?? '低'),
  )

  return (
    <section>
      <PageTitle
        eyebrow="PREP"
        title={t('prep.title')}
        text={t('prep.subtitle')}
      />
      {prep.length === 0 ? (
        <EmptyState title="暂无准备任务" text="导入后将读取“准备中心”。" />
      ) : (
        <div className="prep-grid">
          {sorted.map((item) => (
            <article className="prep-card" key={item.id}>
              <div className="prep-meta"><span>{item.priorityLabel ?? '—'}</span><span>{item.sourceStatus ?? '—'}</span></div>
              <h3>{item.title}</h3>
              <p>{item.minimumOutput ?? '暂无最小产出定义'}</p>
              <small>预计 {formatMinutes(item.estimatedMinutes)} · {item.triggeredBy ?? '无触发说明'}</small>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function SettingsView({ lastImport, onImported }: { lastImport?: ImportMeta; onImported: () => Promise<void> }) {
  const { t } = useUiLanguage()
  const [preview, setPreview] = useState<ImportBundle | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function handleFile(file?: File) {
    if (!file) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const bundle = await parsePJSDASWorkbook(file)
      setPreview(bundle)
    } catch (caught) {
      setPreview(null)
      setError(caught instanceof Error ? caught.message : '无法解析该工作簿')
    } finally {
      setBusy(false)
    }
  }

  async function commitImport() {
    if (!preview) return
    setBusy(true)
    setError('')
    try {
      await replaceImportedData(preview)
      await onImported()
      setMessage(`已导入 ${preview.summary.opportunities} 个岗位，并在本地生成 ${preview.summary.actions} 个行动。`)
      setPreview(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <PageTitle
        eyebrow="IMPORT & SETTINGS"
        title={t('settings.title')}
        text={t('settings.subtitle')}
      />

      <div className="ui-language-card">
        <div>
          <strong>{t('settings.languageTitle')}</strong>
          <p>{t('settings.languageText')}</p>
        </div>
        <LanguageSwitch />
      </div>

      <div className="import-card">
        <div>
          <strong>选择秋招投递总表 .xlsx</strong>
          <p>读取：投递总表、岗位详情、在途流程、准备中心、申请组。</p>
        </div>
        <label className="file-button">
          {busy ? t('settings.processing') : t('settings.chooseFile')}
          <input type="file" accept=".xlsx,.xls" disabled={busy} onChange={(event) => handleFile(event.target.files?.[0])} />
        </label>
      </div>

      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice success">{message}</div> : null}

      {preview ? (
        <div className="preview-card">
          <div className="section-heading">
            <div><div className="eyebrow">IMPORT PREVIEW</div><h2>{preview.summary.filename}</h2></div>
            <button className="primary-button" disabled={busy} onClick={commitImport}>{t('settings.confirmImport')}</button>
          </div>
          <div className="metric-grid compact-metrics">
            <Metric label="岗位" value={preview.summary.opportunities} />
            <Metric label="待投" value={preview.summary.pending} />
            <Metric label="在途" value={preview.summary.processes} />
            <Metric label="准备包" value={preview.summary.prep} />
            <Metric label="申请组" value={preview.summary.applicationGroups} />
            <Metric label="生成行动" value={preview.summary.actions} />
          </div>
          <p className="footnote">再次导入新版 Excel 时，相同 Action 的“完成/跳过”状态和本地 Process Event 都会保留。Excel 原文件不会被修改。</p>
        </div>
      ) : null}

      <div className="mapping-card">
        <div className="eyebrow">MAPPING PRINCIPLE</div>
        <h2>不是把 14 张工作表原样搬进网页</h2>
        <p>
          “近期行动”“仪表盘”“P级”“静默风险”都属于派生结果。PJSDAS 使用原始岗位、日期、流程阈值和申请组规则重新计算；之后收到的真实流程通知作为本地事件覆盖旧状态，避免 Excel 缓存变成错误行动。
        </p>
      </div>

      {lastImport ? (
        <div className="last-import">最近导入：{lastImport.filename} · {formatDateTime(lastImport.importedAt)} · {lastImport.opportunities} 个岗位</div>
      ) : null}
    </section>
  )
}

function TimeRiskBadge({ action, now, rules, compact = false }: { action: Action; now: Date; rules: DecisionRules; compact?: boolean }) {
  if (!action.dueAt) return null
  const risk = timeRisk(action.dueAt, now, rules)
  return (
    <div className={`deadline-countdown risk-${risk.level}${compact ? ' compact' : ''}`}>
      <strong>{actionNodePrefix(action)} {formatTimeRemaining(action.dueAt, now)}</strong>
      <span>{risk.label}</span>
    </div>
  )
}

function Metric({ label, value, emphasis = false }: { label: string; value: number; emphasis?: boolean }) {
  return <div className={emphasis ? 'metric emphasis' : 'metric'}><span>{label}</span><strong>{value}</strong></div>
}

function KindBadge({ action }: { action: Action }) {
  const { lang } = useUiLanguage()
  const labels: Record<Action['kind'], [string, string]> = {
    apply: ['投递', 'Apply'],
    follow_up: ['复核', 'Review'],
    prep: ['准备', 'Prep'],
    group_decision: ['申请组', 'Group'],
    manual: ['手动', 'Manual'],
  }
  const label = action.processEventId ? (lang === 'zh' ? '流程' : 'Process') : labels[action.kind][lang === 'zh' ? 0 : 1]
  const className = action.processEventId ? 'kind-badge kind-process' : `kind-badge kind-${action.kind}`
  return <span className={className}>{label}</span>
}

function RoleBadge({ role }: { role: Opportunity['roleType'] }) {
  const { lang } = useUiLanguage()
  const en: Record<Opportunity['roleType'], string> = {
    core: 'Core', backup: 'Backup', reach: 'Reach', lottery: 'Long shot', practice: 'Practice',
  }
  return <span className={`role-badge role-${role}`}>{lang === 'zh' ? roleLabels[role] : en[role]}</span>
}

function PriorityBadge({ priority }: { priority: ReturnType<typeof computePriority> }) {
  const { lang } = useUiLanguage()
  const zh = { P0: 'P0', P1: 'P1', P2: 'P2', expired: '过期', none: '在途' }
  const en = { P0: 'P0', P1: 'P1', P2: 'P2', expired: 'Expired', none: 'Pipeline' }
  const labels = lang === 'zh' ? zh : en
  return <span className={`priority-badge priority-${priority}`}>{labels[priority]}</span>
}

function PageTitle({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <header className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{text}</p></div></header>
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-card"><strong>{title}</strong><p>{text}</p></div>
}

function formatDateTime(iso: string) {
  const date = new Date(iso)
  const lang = currentUiLanguage()
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function formatDateOnly(iso: string) {
  const date = new Date(iso)
  const lang = currentUiLanguage()
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    year: 'numeric', month: 'numeric', day: 'numeric',
  }).format(date)
}

function formatMinutes(minutes: number) {
  const lang = currentUiLanguage()
  if (minutes < 60) return lang === 'zh' ? `${minutes} 分钟` : `${minutes} min`
  const hours = minutes / 60
  const value = Number.isInteger(hours) ? `${hours}` : hours.toFixed(1)
  return lang === 'zh' ? `${value} 小时` : `${value} hr`
}

export default AppV5

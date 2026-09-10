from pathlib import Path

p = Path('src/AppV5.tsx')
s = p.read_text()

# Language utilities.
needle = "import { actionNodePrefix, formatTimeRemaining, timeRisk, upcomingNodes } from './timeRisk'\n"
replacement = needle + "import { currentUiLanguage, useUiLanguage } from './uiLanguage'\n"
if needle not in s:
    raise SystemExit('language import anchor not found')
s = s.replace(needle, replacement, 1)

old_nav = """const navigation: Array<{ id: Page; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'opportunities', label: 'Opportunities' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'prep', label: 'Prep' },
  { id: 'settings', label: 'Import & Settings' },
]
"""
new_nav = """const navigation: Page[] = ['today', 'opportunities', 'pipeline', 'prep', 'settings']
"""
if old_nav not in s:
    raise SystemExit('navigation anchor not found')
s = s.replace(old_nav, new_nav, 1)

language_component = """function LanguageSwitch() {
  const { lang, setLang } = useUiLanguage()
  return (
    <div className="language-switch" role="group" aria-label="Interface language">
      <button className={lang === 'zh' ? 'active' : ''} onClick={() => setLang('zh')}>中文</button>
      <button className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
    </div>
  )
}

"""
app_anchor = 'function AppV5() {'
if app_anchor not in s:
    raise SystemExit('AppV5 anchor not found')
s = s.replace(app_anchor, language_component + app_anchor, 1)
s = s.replace("function AppV5() {\n", "function AppV5() {\n  const { t } = useUiLanguage()\n", 1)
s = s.replace('<small>Decision & Action</small>', "<small>{t('brand.subtitle')}</small>", 1)

old_nav_render = """          {navigation.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? 'nav-item active' : 'nav-item'}
              onClick={() => setPage(item.id)}
            >
              {item.label}
            </button>
          ))}
"""
new_nav_render = """          {navigation.map((item) => (
            <button
              key={item}
              className={page === item ? 'nav-item active' : 'nav-item'}
              onClick={() => setPage(item)}
            >
              {t(`nav.${item}` as 'nav.today' | 'nav.opportunities' | 'nav.pipeline' | 'nav.prep' | 'nav.settings')}
            </button>
          ))}
"""
if old_nav_render not in s:
    raise SystemExit('navigation render anchor not found')
s = s.replace(old_nav_render, new_nav_render, 1)

sidebar_note = """        <div className="sidebar-note">
          <span>Local-first · v0.8</span>
          {lastImport ? <span>最近导入 {formatDateTime(lastImport.importedAt)}</span> : null}
        </div>
"""
sidebar_new = """        <div className="language-switch-wrap">
          <span className="language-switch-label">{t('language.label')}</span>
          <LanguageSwitch />
        </div>
        <div className="sidebar-note">
          <span>Local-first · v0.8</span>
          {lastImport ? <span>{t('sidebar.lastImport')} {formatDateTime(lastImport.importedAt)}</span> : null}
        </div>
"""
if sidebar_note not in s:
    raise SystemExit('sidebar note anchor not found')
s = s.replace(sidebar_note, sidebar_new, 1)
s = s.replace('<div className="empty-card">正在读取本地数据…</div>', "<div className=\"empty-card\">{t('common.loading')}</div>", 1)

# Replace Today as a single unit so hierarchy is explicit: hero -> upcoming/time -> plan.
start = s.index('function TodayView(')
end = s.index('type OpportunityScope =', start)
today = r'''function TodayView({
  ranked,
  now,
  opportunities,
  groups,
  onMark,
}: {
  ranked: ReturnType<typeof rankActions>
  now: Date
  opportunities: Opportunity[]
  groups: ApplicationGroup[]
  onMark: (id: string, status: Action['status']) => Promise<void>
}) {
  const { lang, t } = useUiLanguage()
  const [budgetMinutes, setBudgetMinutes] = useState(180)
  const plan = buildTimePlan(ranked, budgetMinutes, now)
  const opportunityMap = new Map(opportunities.map((item) => [item.id, item]))
  const groupMap = new Map(groups.map((item) => [item.id, item]))
  const top = plan.planned[0]
  const nextUnplanned = plan.nearDeadlineUnplanned[0]
  const nextFixed = plan.upcomingFixedEvents[0]
  const upcoming = upcomingNodes(ranked, now, 7, 12)
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
              {top.action.dueAt ? <TimeRiskBadge action={top.action} now={now} /> : null}
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
                <div className="eyebrow">UPCOMING · NEXT 7 DAYS</div>
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
                    <TimeRiskBadge action={item.action} now={now} compact />
                    {plannedIds.has(item.action.id) ? <small>{t('today.inPlan')}</small> : <small>{t('today.ahead')}</small>}
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <div className="upcoming-panel upcoming-empty">
            <div className="eyebrow">UPCOMING · NEXT 7 DAYS</div>
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
            <small>{plan.upcomingFixedEvents.length > 1 ? `未来 48 小时还有 ${plan.upcomingFixedEvents.length - 1} 个固定安排` : '固定时刻 · 不占今天可提前完成的任务预算'}</small>
          </div>
        </div>
      ) : null}

      {plan.overrunReason === 'today_deadlines' ? (
        <div className="notice error plan-notice">今天必须发生或完成的行动需要 {formatMinutes(plan.requiredTodayMinutes)}，当前预算不足 {formatMinutes(plan.overBudgetMinutes)}。系统仍把它们完整保留，避免制造“做得完”的假象。</div>
      ) : null}
      {plan.overrunReason === 'near_deadline_stretch' ? (
        <div className="notice warning plan-notice">为覆盖 48 小时内的下一硬截止，建议把今天的时间预算再增加 {formatMinutes(plan.overBudgetMinutes)}。相比用剩余时间塞入低优先级小任务，这个超时更值得。</div>
      ) : null}
      {!plan.overrunReason && nextUnplanned ? (
        <div className="notice warning plan-notice">48 小时内还有 {plan.nearDeadlineUnplanned.length} 个可提前完成的硬截止无法完整装入当前预算。最近的是“{nextUnplanned.action.title}”，预计需要 {formatMinutes(nextUnplanned.action.estimatedMinutes)}；剩余时间应优先留给它。</div>
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
                    {item.action.dueAt ? <TimeRiskBadge action={item.action} now={now} /> : null}
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

'''
s = s[:start] + today + s[end:]

# Opportunities top-level language.
op_anchor = "function OpportunitiesView({ opportunities, groups }: { opportunities: Opportunity[]; groups: ApplicationGroup[] }) {\n"
if op_anchor not in s:
    raise SystemExit('OpportunitiesView anchor not found')
s = s.replace(op_anchor, op_anchor + "  const { t } = useUiLanguage()\n", 1)

replacements = {
    'title="机会池"': "title={t('opportunities.title')}",
    'text="默认只看仍需决策的当前机会；已投岗位自动进入 Pipeline，已过期岗位自动移出主列表，但仍可在筛选中查看历史。"': "text={t('opportunities.subtitle')}",
    'placeholder="搜索公司或岗位"': "placeholder={t('opportunities.search')}",
    '<option value="active">当前机会</option>': '<option value="active">{t(\'opportunities.active\')}</option>',
    '<option value="pipeline">已投 / 在途</option>': '<option value="pipeline">{t(\'opportunities.pipeline\')}</option>',
    '<option value="expired">已过期</option>': '<option value="expired">{t(\'opportunities.expired\')}</option>',
    '<option value="closed">已结束</option>': '<option value="closed">{t(\'opportunities.closed\')}</option>',
    '<option value="all">全部记录</option>': '<option value="all">{t(\'opportunities.allRecords\')}</option>',
    '<option value="all">全部角色</option>': '<option value="all">{t(\'opportunities.allRoles\')}</option>',
    '<option value="all">全部时点</option>': '<option value="all">{t(\'opportunities.allTiming\')}</option>',
    '<tr><th>公司</th><th>岗位</th><th>角色</th><th>动态P级</th><th>成功率</th><th>截止/节点</th><th>准备</th><th>申请组</th></tr>': "<tr><th>{t('opportunities.company')}</th><th>{t('opportunities.role')}</th><th>{t('opportunities.roleType')}</th><th>{t('opportunities.priority')}</th><th>{t('opportunities.success')}</th><th>{t('opportunities.deadline')}</th><th>{t('opportunities.prep')}</th><th>{t('opportunities.group')}</th></tr>",
}
for old, new in replacements.items():
    if old not in s:
        raise SystemExit(f'opportunities anchor not found: {old[:36]}')
    s = s.replace(old, new, 1)

# Pipeline top-level language.
pipe_anchor = "function PipelineView({ processes }: { processes: ProcessRecord[] }) {\n"
if pipe_anchor not in s:
    raise SystemExit('PipelineView anchor not found')
s = s.replace(pipe_anchor, pipe_anchor + "  const { t } = useUiLanguage()\n", 1)
s = s.replace('title="在途流程"', "title={t('pipeline.title')}", 1)
s = s.replace('text="静默风险按当前时间动态重算；真实流程事件会覆盖更旧的 Excel 状态，但不会修改导入基线。"', "text={t('pipeline.subtitle')}", 1)
s = s.replace('<span className="event-source-badge">本地事件</span>', "<span className=\"event-source-badge\">{t('common.localEvent')}</span>", 1)
s = s.replace("<span className={isRisk ? 'risk-badge' : 'quiet-badge'}>{reviewLabel}</span>", "<span className={isRisk ? 'risk-badge' : 'quiet-badge'}>{isRisk ? t('pipeline.review') : t('pipeline.waiting')}</span>", 1)
s = s.replace('<div><dt>阶段</dt><dd>{item.stageLabel}</dd></div>', "<div><dt>{t('pipeline.stage')}</dt><dd>{item.stageLabel}</dd></div>", 1)
s = s.replace("<div><dt>最后进展</dt><dd>{item.lastProgressAt ? formatDateOnly(item.lastProgressAt) : '—'}</dd></div>", "<div><dt>{t('pipeline.lastProgress')}</dt><dd>{item.lastProgressAt ? formatDateOnly(item.lastProgressAt) : '—'}</dd></div>", 1)
s = s.replace("<div><dt>复核阈值</dt><dd>{item.reviewThresholdDays ? `${item.reviewThresholdDays} 天` : '—'}</dd></div>", "<div><dt>{t('pipeline.threshold')}</dt><dd>{item.reviewThresholdDays ? `${item.reviewThresholdDays} ${currentUiLanguage() === 'en' ? 'days' : '天'}` : '—'}</dd></div>", 1)
s = s.replace("<div><dt>下次复核</dt><dd>{item.nextCheckAt ? formatDateOnly(item.nextCheckAt) : '—'}</dd></div>", "<div><dt>{t('pipeline.nextReview')}</dt><dd>{item.nextCheckAt ? formatDateOnly(item.nextCheckAt) : '—'}</dd></div>", 1)

# Prep top-level language.
prep_anchor = "function PrepView({ prep }: { prep: Prep[] }) {\n"
if prep_anchor not in s:
    raise SystemExit('PrepView anchor not found')
s = s.replace(prep_anchor, prep_anchor + "  const { t } = useUiLanguage()\n", 1)
s = s.replace('title="复用准备"', "title={t('prep.title')}", 1)
s = s.replace('text="准备项仍由真实岗位和在途流程触发；Today 最多吸收少量 Prep，避免准备本身替代投递和流程动作。"', "text={t('prep.subtitle')}", 1)

# Settings + language settings card.
settings_anchor = "function SettingsView({ lastImport, onImported }: { lastImport?: ImportMeta; onImported: () => Promise<void> }) {\n"
if settings_anchor not in s:
    raise SystemExit('SettingsView anchor not found')
s = s.replace(settings_anchor, settings_anchor + "  const { t } = useUiLanguage()\n", 1)
s = s.replace('title="从 Excel 进入 PJSDAS"', "title={t('settings.title')}", 1)
s = s.replace('text="工作簿只在当前浏览器本地解析；不会上传到 GitHub。日期、流程复核和共享志愿会在导入时重新建模。"', "text={t('settings.subtitle')}", 1)
settings_title = """      <PageTitle
        eyebrow="IMPORT & SETTINGS"
        title={t('settings.title')}
        text={t('settings.subtitle')}
      />
"""
if settings_title not in s:
    raise SystemExit('Settings page-title anchor not found')
s = s.replace(settings_title, settings_title + """
      <div className="ui-language-card">
        <div>
          <strong>{t('settings.languageTitle')}</strong>
          <p>{t('settings.languageText')}</p>
        </div>
        <LanguageSwitch />
      </div>
""", 1)
s = s.replace("{busy ? '处理中…' : '选择文件'}", "{busy ? t('settings.processing') : t('settings.chooseFile')}", 1)
s = s.replace('>确认导入</button>', ">{t('settings.confirmImport')}</button>", 1)

# Badges follow primary interface language.
kind_start = s.index('function KindBadge(')
helper_end = s.index('function PageTitle(', kind_start)
badges = r'''function KindBadge({ action }: { action: Action }) {
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

'''
s = s[:kind_start] + badges + s[helper_end:]

# Dates and durations use current UI locale.
format_start = s.index('function formatDateTime(')
export_at = s.index('export default AppV5', format_start)
formats = r'''function formatDateTime(iso: string) {
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

'''
s = s[:format_start] + formats + s[export_at:]

p.write_text(s)

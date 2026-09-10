import { useEffect, useMemo, useState } from 'react'
import {
  getAllActions,
  getAllApplicationGroups,
  getAllOpportunities,
  getAllPrep,
  getAllProcesses,
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
} from './decisionV2'
import { parsePJSDASWorkbook } from './importExcelV2'
import type {
  Action,
  ApplicationGroup,
  ImportBundle,
  ImportMeta,
  Opportunity,
  Prep,
  ProcessRecord,
} from './model'
import './timeplan.css'

type Page = 'today' | 'opportunities' | 'pipeline' | 'prep' | 'settings'

const navigation: Array<{ id: Page; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'opportunities', label: 'Opportunities' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'prep', label: 'Prep' },
  { id: 'settings', label: 'Import & Settings' },
]

const roleLabels: Record<Opportunity['roleType'], string> = {
  core: '核心',
  backup: '保底',
  reach: '冲刺',
  lottery: '彩票',
  practice: '练手',
}

function AppV4() {
  const [page, setPage] = useState<Page>('today')
  const [opportunities, setOpportunities] = useState<Opportunity[]>([])
  const [actions, setActions] = useState<Action[]>([])
  const [processes, setProcesses] = useState<ProcessRecord[]>([])
  const [prep, setPrep] = useState<Prep[]>([])
  const [groups, setGroups] = useState<ApplicationGroup[]>([])
  const [lastImport, setLastImport] = useState<ImportMeta | undefined>()
  const [loading, setLoading] = useState(true)

  async function reload() {
    const [nextOpportunities, nextActions, nextProcesses, nextPrep, nextGroups, nextImport] =
      await Promise.all([
        getAllOpportunities(),
        getAllActions(),
        getAllProcesses(),
        getAllPrep(),
        getAllApplicationGroups(),
        getLastImport(),
      ])
    setOpportunities(nextOpportunities)
    setActions(nextActions)
    setProcesses(nextProcesses)
    setPrep(nextPrep)
    setGroups(nextGroups)
    setLastImport(nextImport)
  }

  useEffect(() => {
    reload().finally(() => setLoading(false))
  }, [])

  const ranked = useMemo(() => rankActions(actions, opportunities), [actions, opportunities])

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
            <small>Decision & Action</small>
          </div>
        </div>
        <nav>
          {navigation.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? 'nav-item active' : 'nav-item'}
              onClick={() => setPage(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span>Local-first · v0.4</span>
          {lastImport ? <span>最近导入 {formatDateTime(lastImport.importedAt)}</span> : null}
        </div>
      </aside>

      <main className="main-panel">
        {loading ? <div className="empty-card">正在读取本地数据…</div> : null}
        {!loading && page === 'today' ? (
          <TodayView
            ranked={ranked}
            opportunities={opportunities}
            processes={processes}
            groups={groups}
            onMark={markAction}
          />
        ) : null}
        {!loading && page === 'opportunities' ? (
          <OpportunitiesView opportunities={opportunities} groups={groups} />
        ) : null}
        {!loading && page === 'pipeline' ? <PipelineView processes={processes} /> : null}
        {!loading && page === 'prep' ? <PrepView prep={prep} /> : null}
        {!loading && page === 'settings' ? (
          <SettingsView lastImport={lastImport} onImported={reload} />
        ) : null}
      </main>
    </div>
  )
}

function TodayView({
  ranked,
  opportunities,
  processes,
  groups,
  onMark,
}: {
  ranked: ReturnType<typeof rankActions>
  opportunities: Opportunity[]
  processes: ProcessRecord[]
  groups: ApplicationGroup[]
  onMark: (id: string, status: Action['status']) => Promise<void>
}) {
  const [budgetMinutes, setBudgetMinutes] = useState(180)
  const now = new Date()
  const plan = buildTimePlan(ranked, budgetMinutes, now)
  const opportunityMap = new Map(opportunities.map((item) => [item.id, item]))
  const groupMap = new Map(groups.map((item) => [item.id, item]))
  const pending = opportunities.filter((item) => item.currentStageLabel === '待投')
  const expired = pending.filter((item) => computePriority(item, now) === 'expired').length
  const p0 = pending.filter((item) => computePriority(item, now) === 'P0').length
  const p1 = pending.filter((item) => computePriority(item, now) === 'P1').length
  const review = processes.filter((item) => processNeedsReview(item, now)).length
  const top = plan.planned[0]
  const nextUnplanned = plan.nearDeadlineUnplanned[0]

  return (
    <section>
      <header className="page-header compact-header">
        <div>
          <div className="eyebrow">TODAY · {formatDateOnly(now.toISOString())}</div>
          <h1>今天先做什么</h1>
          <p>
            先保护真正会失效的节点，再按你今天能投入的时间生成可执行计划；预算不足时直接报缺口，不隐藏截止任务。
          </p>
        </div>
      </header>

      {opportunities.length > 0 ? (
        <div className="metric-grid">
          <Metric label="待投" value={pending.length} />
          <Metric label="P0 · 3天内" value={p0} emphasis />
          <Metric label="P1 · 14天内/抢先" value={p1} />
          <Metric label="已过节点" value={expired} />
          <Metric label="在途" value={processes.length} />
          <Metric label="需复核" value={review} emphasis={review > 0} />
        </div>
      ) : null}

      {ranked.length > 0 ? (
        <div className="budget-panel">
          <div>
            <div className="eyebrow">AVAILABLE TIME</div>
            <strong>今天还能投入多少时间？</strong>
          </div>
          <div className="budget-options">
            {[
              { value: 60, label: '1 小时' },
              { value: 180, label: '3 小时' },
              { value: 360, label: '6 小时' },
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
            <span>计划</span>
            <strong>{formatMinutes(plan.totalMinutes)}</strong>
            <span>/ {formatMinutes(plan.budgetMinutes)}</span>
          </div>
        </div>
      ) : null}

      {plan.overBudgetMinutes > 0 ? (
        <div className="notice error plan-notice">
          今天硬截止任务至少需要 {formatMinutes(plan.requiredTodayMinutes)}，当前时间预算少了 {formatMinutes(plan.overBudgetMinutes)}。这里不会把超出的硬截止静默删除。
        </div>
      ) : null}

      {plan.overBudgetMinutes === 0 && nextUnplanned ? (
        <div className="notice warning plan-notice">
          48 小时内还有 {plan.nearDeadlineUnplanned.length} 个硬截止没有装入当前时间预算。最近的是“{nextUnplanned.action.title}”，预计需要 {formatMinutes(nextUnplanned.action.estimatedMinutes)}。
        </div>
      ) : null}

      {top ? (
        <div className="focus-card">
          <div className="eyebrow">START HERE</div>
          <div className="focus-row">
            <div>
              <h2>{top.action.title}</h2>
              <p>{top.reasons.join(' · ') || '当前计划的第一项'}</p>
            </div>
            <div className="focus-score">{top.score}</div>
          </div>
        </div>
      ) : null}

      {plan.planned.length === 0 ? (
        <EmptyState
          title="当前时间预算下没有可完成行动"
          text="可增加可用时间，或到 Opportunities 查看所有活跃机会。"
        />
      ) : (
        <div className="section-block">
          <div className="section-heading">
            <div>
              <div className="eyebrow">TIME-BOXED PLAN</div>
              <h2>行动计划</h2>
            </div>
            <span className="muted">{plan.planned.length} 项 · {formatMinutes(plan.totalMinutes)}</span>
          </div>
          <div className="action-list">
            {plan.planned.map((item, index) => {
              const opportunity = item.action.opportunityId
                ? opportunityMap.get(item.action.opportunityId)
                : undefined
              const group = item.action.applicationGroupId
                ? groupMap.get(item.action.applicationGroupId)
                : undefined

              return (
                <article className="action-card" key={item.action.id}>
                  <div className="rank">{String(index + 1).padStart(2, '0')}</div>
                  <div className="action-copy">
                    <div className="action-line">
                      <h3>{item.action.title}</h3>
                      <KindBadge kind={item.action.kind} />
                    </div>
                    <p>
                      {opportunity
                        ? `${roleLabels[opportunity.roleType]} · ${opportunity.offerProbability ?? '成功率未知'}`
                        : group
                          ? `${group.id} · ${group.rule ?? '共享申请规则'}`
                          : item.action.kind === 'prep'
                            ? '跨岗位复用准备'
                            : '流程管理'}
                    </p>
                    <div className="reason-row">
                      {item.reasons.map((reason) => <span key={reason}>{reason}</span>)}
                    </div>
                    <small>
                      预计 {formatMinutes(item.action.estimatedMinutes)}
                      {item.action.dueAt ? ` · 节点 ${formatDateTime(item.action.dueAt)}` : ''}
                    </small>
                  </div>
                  <div className="action-side">
                    <div className="score">{item.score}</div>
                    <button className="text-button" onClick={() => onMark(item.action.id, 'done')}>完成</button>
                  </div>
                </article>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

function OpportunitiesView({ opportunities, groups }: { opportunities: Opportunity[]; groups: ApplicationGroup[] }) {
  const [query, setQuery] = useState('')
  const [role, setRole] = useState('all')
  const [priority, setPriority] = useState('all')
  const now = new Date()

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return [...opportunities]
      .filter((item) => !needle || `${item.company} ${item.role}`.toLowerCase().includes(needle))
      .filter((item) => role === 'all' || item.roleType === role)
      .filter((item) => priority === 'all' || computePriority(item, now) === priority)
      .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999))
  }, [opportunities, query, role, priority])

  return (
    <section>
      <PageTitle
        eyebrow="OPPORTUNITIES"
        title="机会池"
        text="岗位仍按 Opportunity 保存；共享志愿与有限名额由申请组统一约束，不再把相互竞争的岗位当成完全独立机会。"
      />
      {opportunities.length === 0 ? (
        <EmptyState title="机会池为空" text="先导入秋招投递表。" />
      ) : (
        <>
          <div className="toolbar">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索公司或岗位" />
            <select value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="all">全部角色</option>
              <option value="core">核心</option>
              <option value="backup">保底</option>
              <option value="reach">冲刺</option>
              <option value="lottery">彩票</option>
              <option value="practice">练手</option>
            </select>
            <select value={priority} onChange={(event) => setPriority(event.target.value)}>
              <option value="all">全部时点</option>
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
                <tr><th>公司</th><th>岗位</th><th>角色</th><th>动态P级</th><th>成功率</th><th>截止/节点</th><th>准备</th><th>申请组</th></tr>
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
        title="在途流程"
        text="静默风险按当前时间动态重算；Excel 中旧的等待天数和风险缓存不再决定网页结果。"
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
                  <span className={isRisk ? 'risk-badge' : 'quiet-badge'}>{reviewLabel}</span>
                </div>
                <dl>
                  <div><dt>阶段</dt><dd>{item.stageLabel}</dd></div>
                  <div><dt>最后进展</dt><dd>{item.lastProgressAt ? formatDateOnly(item.lastProgressAt) : '—'}</dd></div>
                  <div><dt>复核阈值</dt><dd>{item.reviewThresholdDays ? `${item.reviewThresholdDays} 天` : '—'}</dd></div>
                  <div><dt>下次复核</dt><dd>{item.nextCheckAt ? formatDateOnly(item.nextCheckAt) : '—'}</dd></div>
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
  const order = ['最高', '高', '中高', '中', '低']
  const sorted = [...prep].sort(
    (a, b) => order.indexOf(a.priorityLabel ?? '低') - order.indexOf(b.priorityLabel ?? '低'),
  )

  return (
    <section>
      <PageTitle
        eyebrow="PREP"
        title="复用准备"
        text="准备项仍由真实岗位和在途流程触发；Today 最多吸收少量 Prep，避免准备本身替代投递和流程动作。"
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
        title="从 Excel 进入 PJSDAS"
        text="工作簿只在当前浏览器本地解析；不会上传到 GitHub。日期、流程复核和共享志愿会在导入时重新建模。"
      />

      <div className="import-card">
        <div>
          <strong>选择秋招投递总表 .xlsx</strong>
          <p>读取：投递总表、岗位详情、在途流程、准备中心、申请组。</p>
        </div>
        <label className="file-button">
          {busy ? '处理中…' : '选择文件'}
          <input type="file" accept=".xlsx,.xls" disabled={busy} onChange={(event) => handleFile(event.target.files?.[0])} />
        </label>
      </div>

      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice success">{message}</div> : null}

      {preview ? (
        <div className="preview-card">
          <div className="section-heading">
            <div><div className="eyebrow">IMPORT PREVIEW</div><h2>{preview.summary.filename}</h2></div>
            <button className="primary-button" disabled={busy} onClick={commitImport}>确认导入</button>
          </div>
          <div className="metric-grid compact-metrics">
            <Metric label="岗位" value={preview.summary.opportunities} />
            <Metric label="待投" value={preview.summary.pending} />
            <Metric label="在途" value={preview.summary.processes} />
            <Metric label="准备包" value={preview.summary.prep} />
            <Metric label="申请组" value={preview.summary.applicationGroups} />
            <Metric label="生成行动" value={preview.summary.actions} />
          </div>
          <p className="footnote">再次导入新版 Excel 时，相同 Action 的“完成/跳过”状态会保留。Excel 原文件不会被修改。</p>
        </div>
      ) : null}

      <div className="mapping-card">
        <div className="eyebrow">MAPPING PRINCIPLE</div>
        <h2>不是把 14 张工作表原样搬进网页</h2>
        <p>
          “近期行动”“仪表盘”“P级”“静默风险”都属于派生结果。PJSDAS 使用原始岗位、日期、流程阈值和申请组规则重新计算，避免 Excel 缓存变成错误行动。
        </p>
      </div>

      {lastImport ? (
        <div className="last-import">最近导入：{lastImport.filename} · {formatDateTime(lastImport.importedAt)} · {lastImport.opportunities} 个岗位</div>
      ) : null}
    </section>
  )
}

function Metric({ label, value, emphasis = false }: { label: string; value: number; emphasis?: boolean }) {
  return <div className={emphasis ? 'metric emphasis' : 'metric'}><span>{label}</span><strong>{value}</strong></div>
}

function KindBadge({ kind }: { kind: Action['kind'] }) {
  const labels: Record<Action['kind'], string> = {
    apply: '投递',
    follow_up: '复核',
    prep: '准备',
    group_decision: '申请组',
    manual: '手动',
  }
  return <span className={`kind-badge kind-${kind}`}>{labels[kind]}</span>
}

function RoleBadge({ role }: { role: Opportunity['roleType'] }) {
  return <span className={`role-badge role-${role}`}>{roleLabels[role]}</span>
}

function PriorityBadge({ priority }: { priority: ReturnType<typeof computePriority> }) {
  const labels = { P0: 'P0', P1: 'P1', P2: 'P2', expired: '过期', none: '在途' }
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
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function formatDateOnly(iso: string) {
  const date = new Date(iso)
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(date)
}

function formatMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`
  const hours = minutes / 60
  return Number.isInteger(hours) ? `${hours} 小时` : `${hours.toFixed(1)} 小时`
}

export default AppV4

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
import { computePriority, rankActions } from './decision'
import { parsePJSDASWorkbook } from './importExcel'
import type {
  Action,
  ApplicationGroup,
  ImportBundle,
  ImportMeta,
  Opportunity,
  Prep,
  ProcessRecord,
} from './model'

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

function App() {
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
          <span>Local-first · v0.2</span>
          {lastImport ? <span>最近导入 {formatDateTime(lastImport.importedAt)}</span> : null}
        </div>
      </aside>

      <main className="main-panel">
        {loading ? <div className="empty-card">正在读取本地数据…</div> : null}
        {!loading && page === 'today' ? (
          <TodayView ranked={ranked} opportunities={opportunities} processes={processes} onMark={markAction} />
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
  onMark,
}: {
  ranked: ReturnType<typeof rankActions>
  opportunities: Opportunity[]
  processes: ProcessRecord[]
  onMark: (id: string, status: Action['status']) => Promise<void>
}) {
  const now = new Date()
  const opportunityMap = new Map(opportunities.map((item) => [item.id, item]))
  const pending = opportunities.filter((item) => item.currentStageLabel === '待投')
  const expired = pending.filter((item) => computePriority(item, now) === 'expired').length
  const p0 = pending.filter((item) => computePriority(item, now) === 'P0').length
  const p1 = pending.filter((item) => computePriority(item, now) === 'P1').length
  const review = processes.filter((item) => item.silenceRisk === '需复核').length
  const top = ranked[0]

  return (
    <section>
      <header className="page-header compact-header">
        <div>
          <div className="eyebrow">TODAY · {formatDateOnly(now.toISOString())}</div>
          <h1>今天先做什么</h1>
          <p>系统根据真实截止时间重新计算优先级，不直接依赖 Excel 中可能过期的 TODAY() 缓存结果。</p>
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

      {top ? (
        <div className="focus-card">
          <div className="eyebrow">IF YOU ONLY DO ONE THING</div>
          <div className="focus-row">
            <div>
              <h2>{top.action.title}</h2>
              <p>{top.reasons.join(' · ') || '当前综合优先级最高'}</p>
            </div>
            <div className="focus-score">{top.score}</div>
          </div>
        </div>
      ) : null}

      {ranked.length === 0 ? (
        <EmptyState
          title="还没有可排序的行动"
          text="到 Import & Settings 导入《秋招投递总表2.77》后，PJSDAS 会在浏览器本地生成投递、流程复核和准备行动。"
        />
      ) : (
        <div className="section-block">
          <div className="section-heading">
            <div>
              <div className="eyebrow">RANKED ACTIONS</div>
              <h2>行动序列</h2>
            </div>
            <span className="muted">显示前 10 项</span>
          </div>
          <div className="action-list">
            {ranked.slice(0, 10).map((item, index) => {
              const opportunity = item.action.opportunityId
                ? opportunityMap.get(item.action.opportunityId)
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
        text="岗位是 Opportunity；Today 的行动排序由它派生，而不是把所有判断继续塞在一行 Excel 里。"
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
          {groups.length > 0 ? <p className="footnote">已同时读取 {groups.length} 个申请组，用于后续处理共享志愿与名额约束。</p> : null}
        </>
      )}
    </section>
  )
}

function PipelineView({ processes }: { processes: ProcessRecord[] }) {
  const sorted = [...processes].sort((a, b) => {
    const risk = Number(b.silenceRisk === '需复核') - Number(a.silenceRisk === '需复核')
    if (risk) return risk
    return (a.nextCheckAt ?? '9999').localeCompare(b.nextCheckAt ?? '9999')
  })

  return (
    <section>
      <PageTitle eyebrow="PIPELINE" title="在途流程" text="只有仍在推进或等待反馈的流程进入这里；静默阈值是管理提醒，不是假装招聘方承诺。" />
      {processes.length === 0 ? (
        <EmptyState title="暂无流程数据" text="导入后将直接读取 Excel 的“在途流程”。" />
      ) : (
        <div className="pipeline-grid">
          {sorted.map((item) => (
            <article className={item.silenceRisk === '需复核' ? 'pipeline-card risk' : 'pipeline-card'} key={item.id}>
              <div className="pipeline-top">
                <div>
                  <strong>{item.company}</strong>
                  <p>{item.role}</p>
                </div>
                <span className={item.silenceRisk === '需复核' ? 'risk-badge' : 'quiet-badge'}>{item.silenceRisk ?? '等待'}</span>
              </div>
              <dl>
                <div><dt>阶段</dt><dd>{item.stageLabel}</dd></div>
                <div><dt>最后进展</dt><dd>{item.lastProgressAt ? formatDateOnly(item.lastProgressAt) : '—'}</dd></div>
                <div><dt>下次复核</dt><dd>{item.nextCheckAt ? formatDateOnly(item.nextCheckAt) : '—'}</dd></div>
              </dl>
              {item.currentAction ? <p className="pipeline-action">{item.currentAction}</p> : null}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function PrepView({ prep }: { prep: Prep[] }) {
  const order = ['最高', '高', '中高', '中', '低']
  const sorted = [...prep].sort((a, b) => order.indexOf(a.priorityLabel ?? '低') - order.indexOf(b.priorityLabel ?? '低'))
  return (
    <section>
      <PageTitle eyebrow="PREP" title="复用准备" text="这里只保留能被当前岗位或在途流程触发的能力包，避免准备工作无限膨胀。" />
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
        text="工作簿只在当前浏览器本地解析；不会上传到 GitHub。第一版直接识别你 2.77 的结构化工作表。"
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
          <p className="footnote">确认后会替换 PJSDAS 当前浏览器中的本地导入数据。Excel 原文件不会被修改。</p>
        </div>
      ) : null}

      <div className="mapping-card">
        <div className="eyebrow">MAPPING PRINCIPLE</div>
        <h2>不是把 14 张工作表原样搬进网页</h2>
        <p>“近期行动”和“仪表盘”属于派生视图，PJSDAS 会重新计算；“P级/剩余天数”也不使用 Excel 的缓存值。岗位雷达、来源审计、历史归档等先保留在 Excel，等核心 Today 工作流验证后再迁移。</p>
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
  const labels: Record<Action['kind'], string> = { apply: '投递', follow_up: '复核', prep: '准备', manual: '手动' }
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
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function formatDateOnly(iso: string) {
  const date = new Date(iso)
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(date)
}

function formatMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`
  const hours = minutes / 60
  return Number.isInteger(hours) ? `${hours} 小时` : `${hours.toFixed(1)} 小时`
}

export default App

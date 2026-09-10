import { useEffect, useMemo, useState } from 'react'
import { getAllActions, getAllOpportunities, getAllPrep, getAllProcesses } from './db'
import { rankActions } from './decision'
import type { Action, Opportunity, Prep, ProcessRecord } from './model'

type Page = 'today' | 'opportunities' | 'pipeline' | 'prep' | 'settings'

const navigation: Array<{ id: Page; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'opportunities', label: 'Opportunities' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'prep', label: 'Prep' },
  { id: 'settings', label: 'Import & Settings' },
]

function App() {
  const [page, setPage] = useState<Page>('today')
  const [opportunities, setOpportunities] = useState<Opportunity[]>([])
  const [actions, setActions] = useState<Action[]>([])
  const [processes, setProcesses] = useState<ProcessRecord[]>([])
  const [prep, setPrep] = useState<Prep[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([getAllOpportunities(), getAllActions(), getAllProcesses(), getAllPrep()])
      .then(([nextOpportunities, nextActions, nextProcesses, nextPrep]) => {
        setOpportunities(nextOpportunities)
        setActions(nextActions)
        setProcesses(nextProcesses)
        setPrep(nextPrep)
      })
      .finally(() => setLoading(false))
  }, [])

  const ranked = useMemo(() => rankActions(actions, opportunities), [actions, opportunities])

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
        <div className="sidebar-note">Local-first · v0.1</div>
      </aside>

      <main className="main-panel">
        {loading ? <div className="empty-card">正在读取本地数据…</div> : null}
        {!loading && page === 'today' ? <TodayView ranked={ranked} opportunities={opportunities} /> : null}
        {!loading && page === 'opportunities' ? <OpportunitiesView opportunities={opportunities} /> : null}
        {!loading && page === 'pipeline' ? <PipelineView processes={processes} /> : null}
        {!loading && page === 'prep' ? <PrepView prep={prep} /> : null}
        {!loading && page === 'settings' ? <SettingsView /> : null}
      </main>
    </div>
  )
}

function TodayView({ ranked, opportunities }: { ranked: ReturnType<typeof rankActions>; opportunities: Opportunity[] }) {
  const opportunityMap = new Map(opportunities.map((item) => [item.id, item]))

  return (
    <section>
      <header className="page-header">
        <div>
          <div className="eyebrow">TODAY</div>
          <h1>今天最值得做什么？</h1>
          <p>Today 不是待办清单，而是由机会价值、紧迫度、行动杠杆和时间成本共同产生的决策结果。</p>
        </div>
      </header>

      {ranked.length === 0 ? (
        <EmptyState
          title="还没有可排序的行动"
          text="下一步导入你的秋招投递表。系统会把岗位与流程映射为 Opportunity、Process 和 Action，再生成 Today。"
        />
      ) : (
        <div className="action-list">
          {ranked.slice(0, 8).map((item, index) => {
            const opportunity = item.action.opportunityId ? opportunityMap.get(item.action.opportunityId) : undefined
            return (
              <article className="action-card" key={item.action.id}>
                <div className="rank">{index + 1}</div>
                <div className="action-copy">
                  <h2>{item.action.title}</h2>
                  <p>{opportunity ? `${opportunity.company} · ${opportunity.role}` : '通用准备任务'}</p>
                  <small>预计 {item.action.estimatedMinutes} 分钟</small>
                </div>
                <div className="score">{item.score}</div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function OpportunitiesView({ opportunities }: { opportunities: Opportunity[] }) {
  return (
    <section>
      <PageTitle eyebrow="OPPORTUNITIES" title="机会池" text="这里保存岗位本身，不把岗位和下一步行动混在同一行。" />
      {opportunities.length === 0 ? (
        <EmptyState title="机会池为空" text="等待导入现有秋招投递表后建立第一批 Opportunity。" />
      ) : (
        <div className="table-card">
          <table>
            <thead><tr><th>公司</th><th>岗位</th><th>城市</th><th>匹配</th><th>截止</th></tr></thead>
            <tbody>{opportunities.map((item) => <tr key={item.id}><td>{item.company}</td><td>{item.role}</td><td>{item.location ?? '—'}</td><td>{item.fitScore ?? '—'}</td><td>{item.deadline ?? '—'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function PipelineView({ processes }: { processes: ProcessRecord[] }) {
  return (
    <section>
      <PageTitle eyebrow="PIPELINE" title="招聘流程" text="关注仍然活跃的流程，而不是只统计累计投递数。" />
      {processes.length === 0 ? <EmptyState title="暂无流程数据" text="导入后，这里会按投递、测评、笔试、面试、Offer 和结束状态组织。" /> : <div className="empty-card">已载入 {processes.length} 条流程记录。</div>}
    </section>
  )
}

function PrepView({ prep }: { prep: Prep[] }) {
  return (
    <section>
      <PageTitle eyebrow="PREP" title="复用准备" text="把能同时提升多个岗位成功率的工作，从单个公司的待办里独立出来。" />
      {prep.length === 0 ? <EmptyState title="暂无准备任务" text="例如 AI 产品案例、英语面试、商业分析案例，都可以成为跨岗位复用的 Prep。" /> : <div className="empty-card">已载入 {prep.length} 条准备任务。</div>}
    </section>
  )
}

function SettingsView() {
  return (
    <section>
      <PageTitle eyebrow="IMPORT & SETTINGS" title="数据入口" text="v0.1 的第一件实用功能将是把你现有 Excel 映射进 PJSDAS，而不是要求你重新录入。" />
      <div className="empty-card">
        <strong>下一步：定义 Excel → PJSDAS 映射</strong>
        <p>上传最新版秋招投递表后，再实现字段识别、预览、确认和导入。这里暂时不接受虚构样例数据。</p>
      </div>
    </section>
  )
}

function PageTitle({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <header className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{text}</p></div></header>
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-card"><strong>{title}</strong><p>{text}</p></div>
}

export default App

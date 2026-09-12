import { useEffect, useState } from 'react'
import { getAllOpportunities, getAllPrep, getAllProcesses } from './db.js'
import { buildPrepGraph, type PrepGraph, type PrepGraphNode, type PrepOpportunityNeed } from './prepGraph.js'
import { useUiLanguage } from './uiLanguage.js'
import './prepGraph.css'

function dateLabel(value: string | undefined, zh: boolean) {
  if (!value) return zh ? '暂无明确节点' : 'No dated node'
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

function sourceLabel(source: PrepGraphNode['links'][number]['source'], zh: boolean) {
  const labels = {
    explicit_trigger: [zh ? '显式触发' : 'Explicit trigger'],
    process_pack: [zh ? '流程准备包' : 'Process prep pack'],
    structured_requirement: [zh ? '结构化要求' : 'Structured requirement'],
    structured_gap: [zh ? '结构化缺口' : 'Structured gap'],
    legacy_gap: [zh ? '显式旧缺口' : 'Explicit legacy gap'],
    process_stage: [zh ? '流程阶段' : 'Process stage'],
  }
  return labels[source][0]
}

function NeedRow({ need, zh }: { need: PrepOpportunityNeed; zh: boolean }) {
  return (
    <div className="prep-graph-need-row">
      <div>
        <strong>{need.label}</strong>
        <span>{need.company} · {need.role}</span>
      </div>
      <div>
        <b>{need.severity}</b>
        <small>{need.kind === 'process' ? (zh ? '流程准备' : 'Process prep') : (zh ? '能力缺口' : 'Capability gap')}</small>
      </div>
    </div>
  )
}

function NodeCard({ node, graph, zh }: { node: PrepGraphNode; graph: PrepGraph; zh: boolean }) {
  const opportunityById = new Map(graph.needs.map((need) => [need.opportunityId, `${need.company}｜${need.role}`]))
  return (
    <article className={`prep-graph-node ${node.triggerSuggested ? 'trigger-suggested' : ''}`}>
      <div className="prep-graph-node-head">
        <div>
          <strong>{node.title}</strong>
          <span>{node.sourceStatus ?? (zh ? '状态未知' : 'Unknown status')}</span>
        </div>
        <div className="prep-graph-leverage"><b>{node.leverageScore}</b><small>{zh ? '图谱杠杆' : 'graph leverage'}</small></div>
      </div>
      <div className="prep-graph-metrics">
        <span>{zh ? '覆盖岗位' : 'Coverage'} <b>{node.coverageCount}</b></span>
        <span>{zh ? '命中需求' : 'Matched needs'} <b>{node.matchedNeedCount}</b></span>
        <span>{zh ? '机会价值' : 'Value'} <b>{node.valueScore}</b></span>
        <span>{zh ? '节点紧迫' : 'Urgency'} <b>{node.urgencyScore}</b></span>
        <span>{zh ? '预计投入' : 'Effort'} <b>{node.estimatedMinutes}m</b></span>
      </div>
      {node.triggerSuggested ? (
        <div className="prep-graph-trigger-note">
          <strong>{zh ? '建议检查是否应触发' : 'Consider activating this prep'}</strong>
          <span>{zh ? '该 Prep 仍标记为“等待触发”，但当前已存在确定性覆盖关系。PJSDAS 不会自动创建 Action。' : 'This Prep is still waiting, but deterministic coverage now exists. PJSDAS does not create an Action automatically.'}</span>
        </div>
      ) : null}
      <div className="prep-graph-next">{zh ? '最近相关节点' : 'Nearest relevant node'}：{dateLabel(node.nextRelevantAt, zh)}</div>
      {node.links.length ? (
        <details className="prep-graph-links">
          <summary>{zh ? `查看 ${node.links.length} 条确定性关联` : `See ${node.links.length} deterministic links`}</summary>
          <div>
            {node.links.map((link) => (
              <div className="prep-graph-link" key={`${node.prepId}:${link.opportunityId}`}>
                <span>{opportunityById.get(link.opportunityId) ?? link.opportunityId}</span>
                <b>{sourceLabel(link.source, zh)} · {link.confidence === 'high' ? (zh ? '高置信' : 'high') : (zh ? '中置信' : 'medium')}</b>
                <small>{link.explanation}</small>
              </div>
            ))}
          </div>
        </details>
      ) : (
        <div className="prep-graph-no-link">{zh ? '当前没有可验证的岗位关联；不会因为名称相似而强行连边。' : 'No verifiable opportunity link. Name similarity alone does not create an edge.'}</div>
      )}
    </article>
  )
}

export default function PrepGraphDock() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [graph, setGraph] = useState<PrepGraph | null>(null)
  const [error, setError] = useState('')

  async function reload() {
    setLoading(true)
    setError('')
    try {
      const [prep, opportunities, processes] = await Promise.all([
        getAllPrep(), getAllOpportunities(), getAllProcesses(),
      ])
      setGraph(buildPrepGraph(prep, opportunities, processes, new Date()))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (open) void reload() }, [open])
  useEffect(() => {
    const handler = () => { if (open) void reload() }
    window.addEventListener('pjsdas:workspace-replaced', handler)
    return () => window.removeEventListener('pjsdas:workspace-replaced', handler)
  }, [open])

  const linked = graph?.nodes.filter((node) => node.coverageCount > 0) ?? []
  const unlinked = graph?.nodes.filter((node) => node.coverageCount === 0) ?? []
  const uncovered = graph?.uncoveredNeeds.slice(0, 20) ?? []

  return (
    <>
      <button className="prep-graph-dock-trigger" type="button" onClick={() => setOpen(true)}>{zh ? '准备图谱' : 'Prep Graph'}</button>
      {open ? (
        <div className="prep-graph-backdrop" onMouseDown={() => setOpen(false)}>
          <section className="prep-graph-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header className="prep-graph-header">
              <div>
                <div className="eyebrow">PREP GRAPH · V1.6</div>
                <h2>{zh ? '准备任务杠杆图谱' : 'Preparation leverage graph'}</h2>
                <p>{zh
                  ? '把岗位的结构化要求、显式能力缺口和当前流程节点连接到 Prep。只有显式关系或确定性精确匹配会进入图；模糊语义不会静默提高 Today 优先级。'
                  : 'Connect structured requirements, explicit capability gaps, and current process stages to Prep. Only explicit links or deterministic exact matches enter the graph; fuzzy semantics never silently boost Today priority.'}</p>
              </div>
              <button className="prep-graph-close" type="button" onClick={() => setOpen(false)} aria-label={zh ? '关闭' : 'Close'}>×</button>
            </header>

            <div className="prep-graph-safety">
              <strong>{zh ? '运行时投影，不改历史数据' : 'Runtime projection, no history rewrite'}</strong>
              <span>{zh ? '图谱只提高已有 Prep Action 的运行时 leverage/urgency；不会自动创建准备任务、修改岗位或提交申请。' : 'The graph only raises runtime leverage/urgency for existing Prep Actions. It does not create tasks, edit opportunities, or submit applications.'}</span>
              <button type="button" disabled={loading} onClick={() => { void reload() }}>{loading ? '…' : (zh ? '重新计算' : 'Recalculate')}</button>
            </div>

            {error ? <div className="prep-graph-notice error">{error}</div> : null}
            {!loading && graph ? (
              <div className="prep-graph-summary">
                <span>{zh ? 'Prep 节点' : 'Prep nodes'} <b>{graph.nodes.length}</b></span>
                <span>{zh ? '有效关联' : 'Links'} <b>{graph.links.length}</b></span>
                <span>{zh ? '有覆盖 Prep' : 'Linked prep'} <b>{linked.length}</b></span>
                <span>{zh ? '未覆盖缺口' : 'Uncovered needs'} <b>{graph.uncoveredNeeds.length}</b></span>
              </div>
            ) : null}

            {linked.length ? (
              <section className="prep-graph-section">
                <div className="prep-graph-section-head"><div><div className="eyebrow">LEVERAGE</div><h3>{zh ? '当前最有杠杆的准备' : 'Highest-leverage preparation'}</h3></div></div>
                <div className="prep-graph-node-list">{linked.map((node) => <NodeCard key={node.prepId} node={node} graph={graph!} zh={zh} />)}</div>
              </section>
            ) : null}

            {uncovered.length ? (
              <section className="prep-graph-section">
                <div className="prep-graph-section-head"><div><div className="eyebrow">UNCOVERED</div><h3>{zh ? '当前没有 Prep 覆盖的缺口/流程准备' : 'Uncovered gaps and process prep'}</h3></div><span>{zh ? '仅显示前 20 项' : 'top 20'}</span></div>
                <div className="prep-graph-need-list">{uncovered.map((need) => <NeedRow key={need.id} need={need} zh={zh} />)}</div>
              </section>
            ) : null}

            {unlinked.length ? (
              <details className="prep-graph-unlinked">
                <summary>{zh ? `${unlinked.length} 个 Prep 暂无确定性岗位关联` : `${unlinked.length} Prep nodes have no deterministic opportunity link`}</summary>
                <div className="prep-graph-node-list">{unlinked.map((node) => <NodeCard key={node.prepId} node={node} graph={graph!} zh={zh} />)}</div>
              </details>
            ) : null}

            {!loading && graph && graph.nodes.length === 0 ? <div className="prep-graph-empty">{zh ? '当前没有 Prep 数据。' : 'No Prep data is available.'}</div> : null}
          </section>
        </div>
      ) : null}
    </>
  )
}

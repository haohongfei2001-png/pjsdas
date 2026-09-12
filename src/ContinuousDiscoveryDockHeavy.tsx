import { useEffect, useMemo, useState } from 'react'
import { buildContinuousDiscoverySummary } from './continuousDiscovery.js'
import { discoveryRunsFromChangeSets } from './discoveryRun.js'
import { getAllChangeSets, getAllOpportunities } from './db.js'
import { getAllDiscoveryInboxItems } from './discoveryInboxStore.js'
import { useUiLanguage } from './uiLanguage.js'
import './continuousDiscovery.css'

function formatDate(value: string | undefined, zh: boolean) {
  if (!value) return '—'
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

function modeLabel(value: string, zh: boolean) {
  const labels: Record<string, [string, string]> = {
    ad_hoc: ['临时发现', 'Ad hoc'],
    full: ['全量基线', 'Full baseline'],
    incremental: ['增量发现', 'Incremental'],
    refresh: ['状态刷新', 'Refresh'],
  }
  return labels[value]?.[zh ? 0 : 1] ?? value
}

function outcomeLabel(value: string, zh: boolean) {
  const labels: Record<string, [string, string]> = {
    applied: ['已加入机会池', 'Applied'],
    saved_to_inbox: ['保存到发现箱', 'Saved to Inbox'],
    discarded: ['整批放弃', 'Discarded'],
    pending: ['待审阅', 'Pending'],
    failed: ['应用失败', 'Failed'],
  }
  return labels[value]?.[zh ? 0 : 1] ?? value
}

export default function ContinuousDiscoveryDock() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<Awaited<ReturnType<typeof loadData>> | null>(null)

  async function loadData() {
    const [changeSets, opportunities, inbox] = await Promise.all([
      getAllChangeSets(),
      getAllOpportunities(),
      getAllDiscoveryInboxItems(),
    ])
    const summary = buildContinuousDiscoverySummary({ changeSets, opportunities, inbox, now: new Date() })
    const inboxSourceIds = new Set(inbox.map((item) => item.sourceChangeSetId).filter((value): value is string => Boolean(value)))
    const runs = discoveryRunsFromChangeSets(changeSets, inboxSourceIds)
    return { summary, runs }
  }

  async function reload() {
    setLoading(true)
    setError('')
    try {
      setData(await loadData())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void reload()
  }, [open, revision])

  useEffect(() => {
    const handler = () => setRevision((value) => value + 1)
    window.addEventListener('pjsdas:workspace-replaced', handler)
    return () => window.removeEventListener('pjsdas:workspace-replaced', handler)
  }, [])

  const recentRuns = useMemo(() => data?.runs.slice(0, 8) ?? [], [data])
  const summary = data?.summary

  return (
    <>
      <button className="discovery-radar-trigger" type="button" onClick={() => setOpen(true)}>
        {zh ? '发现雷达' : 'Discovery Radar'}
      </button>
      {open ? (
        <div className="discovery-radar-backdrop" onMouseDown={() => setOpen(false)}>
          <section className="discovery-radar-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header className="discovery-radar-header">
              <div>
                <div className="eyebrow">CONTINUOUS DISCOVERY · V1.7</div>
                <h2>{zh ? '持续岗位发现' : 'Continuous job discovery'}</h2>
                <p>{zh
                  ? '这里记录经过签名审阅的发现批次，并把历史转成下一次搜索的增量起点、来源覆盖和岗位状态刷新队列。PJSDAS 仍不在后台爬取网页。'
                  : 'This workspace records signed, reviewed discovery batches and turns history into an incremental baseline, source coverage, and posting-refresh queue. PJSDAS still does not crawl the web in the background.'}</p>
              </div>
              <button className="discovery-radar-close" type="button" onClick={() => setOpen(false)} aria-label={zh ? '关闭' : 'Close'}>×</button>
            </header>

            <div className="discovery-radar-safety">
              <div>
                <strong>{zh ? '持续 ≠ 后台自动申请' : 'Continuous ≠ autonomous applying'}</strong>
                <span>{zh ? 'Run 历史来自用户审阅过的 ChangeSet；刷新队列只是告诉 AI 下次应该检查什么。' : 'Run history comes from reviewed ChangeSets; the refresh queue only tells the AI what should be checked next.'}</span>
              </div>
              <button type="button" disabled={loading} onClick={() => void reload()}>{loading ? '…' : (zh ? '重新计算' : 'Recalculate')}</button>
            </div>

            {error ? <div className="discovery-radar-notice error">{error}</div> : null}
            {!summary && !loading ? <div className="discovery-radar-empty">{zh ? '暂无可读取的发现历史。' : 'No readable discovery history yet.'}</div> : null}

            {summary ? (
              <>
                <div className="discovery-radar-summary">
                  <span><small>{zh ? '已记录 Run' : 'Recorded runs'}</small><b>{summary.runCount}</b></span>
                  <span><small>{zh ? '累计候选' : 'Candidates seen'}</small><b>{summary.totals.received}</b></span>
                  <span><small>{zh ? '进入审阅' : 'Entered review'}</small><b>{summary.totals.reviewCandidates}</b></span>
                  <span><small>{zh ? '需刷新来源' : 'Refresh queue'}</small><b>{summary.refreshQueue.length}</b></span>
                </div>

                <article className="discovery-radar-next">
                  <div>
                    <span className="eyebrow">NEXT RUN</span>
                    <h3>{zh ? `建议：${modeLabel(summary.suggestedMode, true)}` : `Suggested: ${modeLabel(summary.suggestedMode, false)}`}</h3>
                    <p>{summary.incrementalSince
                      ? (zh ? `普通新岗位发现优先从 ${formatDate(summary.incrementalSince, true)} 之后找新增或实质更新，不再重复全量扫历史空间。` : `For normal discovery, prefer new or materially updated postings since ${formatDate(summary.incrementalSince, false)} instead of repeating the full historical search space.`)
                      : (zh ? '目前还没有持久化的发现基线；下一次应先完成一次有界的基线发现。' : 'No durable discovery baseline exists yet; the next pass should establish one.')}</p>
                  </div>
                  {summary.lastRun ? <div className="discovery-radar-last"><small>{zh ? '最近 Run' : 'Last run'}</small><b>{modeLabel(summary.lastRun.mode, zh)}</b><span>{formatDate(summary.lastRun.completedAt, zh)}</span></div> : null}
                </article>

                <section className="discovery-radar-section">
                  <div className="discovery-radar-section-head"><div><span className="eyebrow">SOURCE COVERAGE</span><h3>{zh ? '来源覆盖' : 'Source coverage'}</h3></div><small>{zh ? '按已记录 Run 统计' : 'From recorded runs'}</small></div>
                  {summary.sourceCoverage.length ? (
                    <div className="discovery-source-list">
                      {summary.sourceCoverage.slice(0, 12).map((source) => (
                        <div className="discovery-source-row" key={source.host}>
                          <div><strong>{source.host}</strong><small>{zh ? `最近 ${formatDate(source.lastRunAt, true)}` : `last ${formatDate(source.lastRunAt, false)}`}</small></div>
                          <div><span>{zh ? '覆盖 Run' : 'runs'} <b>{source.runCount}</b></span><span>{zh ? '产出 Run' : 'productive'} <b>{source.candidateRunCount}</b></span></div>
                        </div>
                      ))}
                    </div>
                  ) : <p className="discovery-radar-muted">{zh ? '还没有可统计的来源。旧客户端会从进入审阅区的岗位来源开始积累。' : 'No source history yet. Legacy clients begin accumulating coverage from sources that produce reviewable jobs.'}</p>}
                </section>

                <section className="discovery-radar-section">
                  <div className="discovery-radar-section-head"><div><span className="eyebrow">REFRESH QUEUE</span><h3>{zh ? '状态刷新队列' : 'Posting refresh queue'}</h3></div><small>{summary.refreshQueue.length}</small></div>
                  {summary.refreshQueue.length ? (
                    <div className="discovery-refresh-list">
                      {summary.refreshQueue.slice(0, 16).map((item) => (
                        <div className={`discovery-refresh-row ${item.freshness}`} key={`${item.ownerKind}:${item.ownerId}:${item.sourceUrl}`}>
                          <div><strong>{item.company}｜{item.role}</strong><small>{item.sourceHost} · {zh ? '上次验证' : 'verified'} {formatDate(item.lastVerifiedAt, zh)}</small></div>
                          <span>{item.freshness}</span>
                        </div>
                      ))}
                    </div>
                  ) : <p className="discovery-radar-muted">{zh ? '当前没有 aging / stale / unknown 的活跃岗位来源需要优先复核。' : 'No active aging, stale, or unknown posting source currently needs priority verification.'}</p>}
                </section>

                <section className="discovery-radar-section">
                  <div className="discovery-radar-section-head"><div><span className="eyebrow">RUN HISTORY</span><h3>{zh ? '最近发现批次' : 'Recent discovery runs'}</h3></div><small>{recentRuns.length}</small></div>
                  {recentRuns.length ? (
                    <div className="discovery-run-list">
                      {recentRuns.map((run) => (
                        <article className="discovery-run-row" key={`${run.changeSetId}:${run.id}`}>
                          <div><strong>{modeLabel(run.mode, zh)}</strong><small>{formatDate(run.completedAt, zh)} · {outcomeLabel(run.outcome, zh)}</small></div>
                          <div><span>{zh ? '候选' : 'seen'} <b>{run.receivedCount}</b></span><span>{zh ? '审阅' : 'review'} <b>{run.reviewCandidateCount}</b></span><span>{zh ? '选中' : 'selected'} <b>{run.selectedCount}</b></span></div>
                        </article>
                      ))}
                    </div>
                  ) : <p className="discovery-radar-muted">{zh ? '从 v1.7 开始，完成审阅的岗位发现批次会在这里积累。' : 'Reviewed discovery batches begin accumulating here from v1.7.'}</p>}
                </section>
              </>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  )
}

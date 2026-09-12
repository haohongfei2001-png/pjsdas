import { useEffect, useMemo, useState } from 'react'
import { getAllTimelineRecords } from './db.js'
import {
  PJSDAS_EXPECTED_INGESTION_SOURCES,
  summarizeCoverage,
  type CoverageSummary,
} from './ingestion.js'
import type { TimelineRecord } from './model.js'
import './coverageIndicator.css'

function sourceLabel(kind: string, sourceId: string, label?: string) {
  if (label) return label
  if (kind === 'gmail') return `Gmail · ${sourceId}`
  if (kind === 'gpt_monitor') return `Monitor · ${sourceId}`
  return `${kind} · ${sourceId}`
}

function formatTime(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function outcomeText(outcomes: CoverageSummary['sources'][number]['outcomes']) {
  const labels: Record<string, string> = {
    created: '新增', merged: '归并', updated: '更新', duplicate: '重复', filtered: '过滤', ignored: '忽略', unresolved: '待解析',
  }
  return Object.entries(outcomes)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${labels[key] ?? key} ${value}`)
    .join(' · ')
}

export default function CoverageIndicator() {
  const [open, setOpen] = useState(false)
  const [timeline, setTimeline] = useState<TimelineRecord[]>([])
  const [now, setNow] = useState(() => new Date())
  const [error, setError] = useState('')

  async function reload() {
    try {
      setTimeline(await getAllTimelineRecords())
      setNow(new Date())
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  useEffect(() => {
    void reload()
    const interval = window.setInterval(() => { void reload() }, 120_000)
    const refresh = () => { void reload() }
    window.addEventListener('focus', refresh)
    window.addEventListener('pjsdas:workspace-replaced', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pjsdas:workspace-replaced', refresh)
    }
  }, [])

  const coverage = useMemo(() => summarizeCoverage(timeline, {
    now,
    expectedSources: PJSDAS_EXPECTED_INGESTION_SOURCES,
  }), [timeline, now])
  const hasRuns = coverage.sourceCount > 0
  const status = error ? 'error' : coverage.allCaughtUp ? 'ok' : 'attention'
  const label = error
    ? 'Coverage 不可用'
    : coverage.allCaughtUp
      ? 'All caught up'
      : coverage.unresolvedCount > 0
        ? `${coverage.unresolvedCount} 条待解析`
        : coverage.missingSourceCount > 0
          ? `${coverage.missingSourceCount} 个来源未覆盖`
          : coverage.staleSourceCount > 0
            ? `${coverage.staleSourceCount} 个来源已过期`
            : !hasRuns
              ? '自动摄入尚未运行'
              : 'Coverage 需检查'

  return (
    <div className={`coverage-indicator ${status}`}>
      <button
        className="coverage-pill"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="查看自动摄入覆盖状态"
      >
        <span className="coverage-dot" aria-hidden="true" />
        <span>{label}</span>
        {hasRuns ? <small>{coverage.totalAccounted}/{coverage.totalReceived}</small> : null}
      </button>

      {open ? (
        <section className="coverage-popover" role="dialog" aria-label="Coverage 对账状态">
          <header>
            <div>
              <div className="eyebrow">COVERAGE</div>
              <h2>{coverage.allCaughtUp ? '预期来源都按时运行，且每条输入都有去处' : '自动摄入对账'}</h2>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭">×</button>
          </header>

          {error ? <div className="coverage-warning">{error}</div> : (
            <>
              <div className="coverage-summary">
                <div><small>最近完成</small><strong>{formatTime(coverage.latestCompletedAt)}</strong></div>
                <div><small>来源覆盖</small><strong>{coverage.sourceCount}/{coverage.expectedSourceCount || coverage.sourceCount}</strong></div>
                <div><small>已接收 / 对账</small><strong>{coverage.totalReceived}/{coverage.totalAccounted}</strong></div>
                <div><small>异常</small><strong>{coverage.unresolvedCount + coverage.missingSourceCount + coverage.staleSourceCount}</strong></div>
              </div>

              {coverage.missingSources.length ? (
                <div className="coverage-exceptions">
                  <h3>尚未完成过摄入的预期来源</h3>
                  {coverage.missingSources.map((source) => (
                    <article key={`missing:${source.sourceKind}:${source.sourceId}`}>
                      <strong>{sourceLabel(source.sourceKind, source.sourceId, source.label)}</strong>
                      <p>这个来源尚没有可验证的完成 run，因此 Coverage 不会显示绿色。</p>
                      <small>要求至少每 {source.maxAgeHours} 小时完成一次</small>
                    </article>
                  ))}
                </div>
              ) : null}

              <div className="coverage-source-list">
                {coverage.sources.map((source) => (
                  <article key={`${source.sourceKind}:${source.sourceId}`}>
                    <div>
                      <strong>{sourceLabel(source.sourceKind, source.sourceId, source.label)}</strong>
                      <small>{formatTime(source.lastCompletedAt)}{source.stale ? ' · 已过期' : ''}</small>
                    </div>
                    <span className={source.balanced && source.unresolvedCount === 0 && !source.stale ? 'good' : 'warn'}>
                      {source.accountedCount}/{source.receivedCount}
                    </span>
                    <p>{outcomeText(source.outcomes) || '本轮 0 条输入'}{source.maxAgeHours ? ` · SLA ${source.maxAgeHours}h` : ''}</p>
                  </article>
                ))}
              </div>

              {coverage.exceptions.length ? (
                <div className="coverage-exceptions">
                  <h3>需要处理的解析异常</h3>
                  {coverage.exceptions.slice(0, 8).map((record) => (
                    <article key={record.id}>
                      <strong>{record.company && record.role ? `${record.company}｜${record.role}` : record.sourceRef ?? record.title}</strong>
                      <p>{record.detail ?? '来源记录尚未能安全归入工作区。'}</p>
                      <small>{record.ingestion?.sourceKind} · {record.ingestion?.sourceRecordId}</small>
                    </article>
                  ))}
                </div>
              ) : coverage.allCaughtUp ? (
                <p className="coverage-success">✓ 4 个岗位 Monitor 与 Gmail 都在 SLA 内完成，最新 run 守恒，且没有待解析输入。</p>
              ) : null}

              <p className="coverage-footnote">Coverage 证明的是“已配置来源按期运行，且进入 PJSDAS 的记录没有静默丢失”，不是“互联网上不存在尚未被任何监控发现的岗位”。</p>
            </>
          )}
        </section>
      ) : null}
    </div>
  )
}

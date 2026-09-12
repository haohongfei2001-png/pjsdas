import { useEffect, useMemo, useState } from 'react'
import { getAllTimelineRecords } from './db.js'
import { auditLocalWorkspaceIntegrity } from './localWorkspaceIntegrity.js'
import {
  expectedSourcesFromRegistry,
  summarizeCoverage,
  type CoverageSummary,
} from './ingestion.js'
import { summarizeSourceHealth } from './sourceHealth.js'
import type { WorkspaceIntegritySummary } from './workspaceIntegrity.js'
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
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function formatCadence(minutes?: number) {
  if (!minutes) return ''
  if (minutes % 1440 === 0) return `${minutes / 1440}天`
  if (minutes % 60 === 0) return `${minutes / 60}小时`
  return `${minutes}分钟`
}

function outcomeText(outcomes: CoverageSummary['sources'][number]['outcomes']) {
  const labels: Record<string, string> = { created: '新增', merged: '归并', updated: '更新', duplicate: '重复', filtered: '过滤', ignored: '忽略', unresolved: '待解析' }
  return Object.entries(outcomes).filter(([, value]) => Boolean(value)).map(([key, value]) => `${labels[key] ?? key} ${value}`).join(' · ')
}

export default function CoverageIndicator() {
  const [open, setOpen] = useState(false)
  const [timeline, setTimeline] = useState<TimelineRecord[]>([])
  const [integrity, setIntegrity] = useState<WorkspaceIntegritySummary | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [error, setError] = useState('')

  async function reload() {
    try {
      const current = new Date()
      const [nextTimeline, nextIntegrity] = await Promise.all([
        getAllTimelineRecords(),
        auditLocalWorkspaceIntegrity(current),
      ])
      setTimeline(nextTimeline)
      setIntegrity(nextIntegrity)
      setNow(current)
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

  const coverage = useMemo(() => {
    const expectedSources = expectedSourcesFromRegistry(timeline)
    return summarizeCoverage(timeline, { now, expectedSources })
  }, [timeline, now])
  const sourceHealth = useMemo(() => summarizeSourceHealth(timeline, now), [timeline, now])
  const healthBySource = useMemo(() => new Map(sourceHealth.map((item) => [`${item.sourceKind}:${item.sourceId}`, item])), [sourceHealth])
  const hasRuns = coverage.sourceCount > 0
  const integrityCritical = (integrity?.criticalCount ?? 0) > 0
  const status = error ? 'error' : integrityCritical || !coverage.allCaughtUp ? 'attention' : 'ok'
  const label = error
    ? 'Coverage 不可用'
    : integrityCritical
      ? `工作区 ${integrity!.criticalCount} 个严重问题`
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
      <button className="coverage-pill" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label="查看自动摄入覆盖与工作区健康状态">
        <span className="coverage-dot" aria-hidden="true" />
        <span>{label}</span>
        {hasRuns ? <small>{coverage.totalAccounted}/{coverage.totalReceived}</small> : null}
      </button>

      {open ? (
        <section className="coverage-popover" role="dialog" aria-label="Coverage 与工作区健康状态">
          <header>
            <div><div className="eyebrow">COVERAGE & INTEGRITY</div><h2>{coverage.allCaughtUp && !integrityCritical ? '已启用来源按时运行，工作区没有严重结构错误' : '自动化与数据健康检查'}</h2></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭">×</button>
          </header>

          {error ? <div className="coverage-warning">{error}</div> : (
            <>
              <div className="coverage-summary">
                <div><small>最近完成</small><strong>{formatTime(coverage.latestCompletedAt)}</strong></div>
                <div><small>来源覆盖</small><strong>{coverage.sourceCount}/{coverage.expectedSourceCount}</strong></div>
                <div><small>已接收 / 对账</small><strong>{coverage.totalReceived}/{coverage.totalAccounted}</strong></div>
                <div><small>工作区健康</small><strong>{integrity ? `${integrity.score}/100` : '—'}</strong></div>
              </div>

              {integrity && integrity.issueCount > 0 ? (
                <div className="coverage-exceptions">
                  <h3>本地工作区完整性</h3>
                  <p>{integrity.criticalCount} 严重 · {integrity.warningCount} 警告 · {integrity.infoCount} 提示。这里只报告，不自动修改 IndexedDB。</p>
                  {integrity.issues.slice(0, 6).map((issue, index) => (
                    <article key={`${issue.code}:${index}`}>
                      <strong>{issue.title}</strong>
                      <p>{issue.detail}</p>
                      <small>{issue.severity} · {issue.code}</small>
                    </article>
                  ))}
                </div>
              ) : integrity ? (
                <p className="coverage-success">✓ 本地 raw IndexedDB 结构扫描未发现已知完整性问题。</p>
              ) : null}

              {coverage.missingSources.length ? (
                <div className="coverage-exceptions">
                  <h3>尚未完成过摄入的已启用来源</h3>
                  {coverage.missingSources.map((source) => (
                    <article key={`missing:${source.sourceKind}:${source.sourceId}`}>
                      <strong>{sourceLabel(source.sourceKind, source.sourceId, source.label)}</strong>
                      <p>这个来源尚没有可验证的完成 run，因此 Coverage 不会显示绿色。</p>
                      <small>{source.cadenceMinutes ? `计划每 ${formatCadence(source.cadenceMinutes)}` : ''}{source.maxAgeHours ? ` · SLA ${source.maxAgeHours}h` : ''}</small>
                    </article>
                  ))}
                </div>
              ) : null}

              <div className="coverage-source-list">
                {coverage.sources.map((source) => {
                  const health = healthBySource.get(`${source.sourceKind}:${source.sourceId}`)
                  return (
                    <article key={`${source.sourceKind}:${source.sourceId}`}>
                      <div>
                        <strong>{sourceLabel(source.sourceKind, source.sourceId, source.label)}</strong>
                        <small>{formatTime(source.lastCompletedAt)}{source.stale ? ' · 已过期' : ''}</small>
                      </div>
                      <span className={source.balanced && source.unresolvedCount === 0 && !source.stale ? 'good' : 'warn'}>{source.accountedCount}/{source.receivedCount}</span>
                      <p>{outcomeText(source.outcomes) || '本轮 0 条输入'}{source.cadenceMinutes ? ` · 每 ${formatCadence(source.cadenceMinutes)}` : ''}{source.maxAgeHours ? ` · SLA ${source.maxAgeHours}h` : ''}</p>
                      {health ? <small>24h {health.runCount24h} 次 · 7天健康 {health.healthyRunCount7d}/{health.runCount7d} · 连续健康 {health.consecutiveHealthyRuns} · 下次预计 {formatTime(health.nextExpectedBy)}</small> : null}
                    </article>
                  )
                })}
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
                <p className="coverage-success">✓ 当前 {coverage.expectedSourceCount} 个已启用来源都在各自 SLA 内完成，最新 run 守恒，且没有待解析输入。</p>
              ) : null}

              <p className="coverage-footnote">Coverage 证明的是“当前已启用来源按期运行，且进入 PJSDAS 的记录没有静默丢失”；Integrity 检查本地持久化结构。两者都不声称“互联网上不存在尚未被任何监控发现的岗位”。</p>
            </>
          )}
        </section>
      ) : null}
    </div>
  )
}

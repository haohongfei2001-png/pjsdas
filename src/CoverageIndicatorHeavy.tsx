import { useEffect, useMemo, useState } from 'react'
import { getAllTimelineRecords } from './db.js'
import { auditLocalWorkspaceIntegrity } from './localWorkspaceIntegrity.js'
import {
  expectedSourcesFromRegistry,
  summarizeCoverage,
  type CoverageSummary,
} from './ingestion.js'
import { summarizeSourceHealth } from './sourceHealth.js'
import { useUiLanguage } from './uiLanguage.js'
import type { WorkspaceIntegritySummary } from './workspaceIntegrity.js'
import type { TimelineRecord } from './model.js'
import './coverageIndicator.css'

function sourceLabel(kind: string, sourceId: string, label?: string) {
  if (label) return label
  if (kind === 'gmail') return `Gmail · ${sourceId}`
  if (kind === 'gpt_monitor') return `Monitor · ${sourceId}`
  return `${kind} · ${sourceId}`
}

function formatTime(value: string | undefined, zh: boolean) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function formatCadence(minutes: number | undefined, zh: boolean) {
  if (!minutes) return ''
  if (minutes % 1440 === 0) return zh ? `${minutes / 1440}天` : `${minutes / 1440}d`
  if (minutes % 60 === 0) return zh ? `${minutes / 60}小时` : `${minutes / 60}h`
  return zh ? `${minutes}分钟` : `${minutes} min`
}

function outcomeText(outcomes: CoverageSummary['sources'][number]['outcomes'], zh: boolean) {
  const labels: Record<string, [string, string]> = {
    created: ['新增', 'created'], merged: ['归并', 'merged'], updated: ['更新', 'updated'], duplicate: ['重复', 'duplicate'],
    filtered: ['过滤', 'filtered'], ignored: ['忽略', 'ignored'], unresolved: ['待解析', 'unresolved'],
  }
  return Object.entries(outcomes)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${labels[key]?.[zh ? 0 : 1] ?? key} ${value}`)
    .join(' · ')
}

function integritySeverity(value: string, zh: boolean) {
  if (!zh) return value
  if (value === 'critical') return '严重'
  if (value === 'warning') return '警告'
  if (value === 'info') return '提示'
  return value
}

function issueText(kinds: string[] | undefined, zh: boolean) {
  if (!kinds?.length) return zh ? '历史未分类异常' : 'Legacy unclassified issue'
  return kinds.map((kind) => kind === 'transport_gap'
    ? (zh ? '来源覆盖缺口' : 'Transport coverage gap')
    : kind === 'interpretation_failure'
      ? (zh ? '解释失败' : 'Interpretation failure')
      : (zh ? '业务歧义' : 'Business ambiguity')).join(' · ')
}

export default function CoverageIndicatorHeavy() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
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
    ? (zh ? '系统健康状态不可用' : 'System health unavailable')
    : integrityCritical
      ? (zh ? `工作区 ${integrity!.criticalCount} 个严重问题` : `${integrity!.criticalCount} critical workspace issue${integrity!.criticalCount === 1 ? '' : 's'}`)
      : coverage.allCaughtUp
        ? (zh ? '状态正常' : 'All caught up')
        : coverage.transportGapCount > 0
          ? (zh ? `${coverage.transportGapCount} 条来源覆盖缺口` : `${coverage.transportGapCount} transport coverage gap(s)`)
          : coverage.interpretationFailureCount > 0
            ? (zh ? `${coverage.interpretationFailureCount} 条解释失败` : `${coverage.interpretationFailureCount} interpretation failure(s)`)
            : coverage.businessAmbiguityCount > 0
              ? (zh ? `${coverage.businessAmbiguityCount} 条业务歧义` : `${coverage.businessAmbiguityCount} business ambiguity item(s)`)
              : coverage.unclassifiedUnresolvedCount > 0
                ? (zh ? `${coverage.unclassifiedUnresolvedCount} 条来源异常` : `${coverage.unclassifiedUnresolvedCount} source issue(s)`)
          : coverage.missingSourceCount > 0
            ? (zh ? `${coverage.missingSourceCount} 个来源未覆盖` : `${coverage.missingSourceCount} source${coverage.missingSourceCount === 1 ? '' : 's'} missing`)
            : coverage.staleSourceCount > 0
              ? (zh ? `${coverage.staleSourceCount} 个来源已过期` : `${coverage.staleSourceCount} source${coverage.staleSourceCount === 1 ? '' : 's'} stale`)
              : !hasRuns
                ? (zh ? '自动摄入尚未运行' : 'Autonomous ingestion has not run')
                : (zh ? '系统健康需检查' : 'System health needs attention')

  return (
    <div className={`coverage-indicator ${status}`}>
      <button className="coverage-pill" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={zh ? '查看自动摄入覆盖与工作区健康状态' : 'View ingestion coverage and workspace health'}>
        <span className="coverage-dot" aria-hidden="true" />
        <span>{label}</span>
        {hasRuns ? <small>{coverage.totalAccounted}/{coverage.totalReceived}</small> : null}
      </button>

      {open ? (
        <section className="coverage-popover" role="dialog" aria-label={zh ? '自动摄入覆盖与工作区健康状态' : 'Ingestion coverage and workspace health'}>
          <header>
            <div>
              <div className="eyebrow">COVERAGE & INTEGRITY</div>
              <h2>{coverage.allCaughtUp && !integrityCritical
                ? (zh ? '已启用来源按时运行，工作区没有严重结构错误' : 'Enabled sources are current and the workspace has no critical structural errors')
                : (zh ? '自动化与数据健康检查' : 'Automation and data health')}</h2>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label={zh ? '关闭' : 'Close'}>×</button>
          </header>

          {error ? <div className="coverage-warning">{error}</div> : (
            <>
              <div className="coverage-summary">
                <div><small>{zh ? '最近完成' : 'Latest completion'}</small><strong>{formatTime(coverage.latestCompletedAt, zh)}</strong></div>
                <div><small>{zh ? '来源覆盖' : 'Source coverage'}</small><strong>{coverage.sourceCount}/{coverage.expectedSourceCount}</strong></div>
                <div><small>{zh ? '已接收 / 对账' : 'Received / accounted'}</small><strong>{coverage.totalReceived}/{coverage.totalAccounted}</strong></div>
                <div><small>{zh ? '当前未解决' : 'Active unresolved'}</small><strong>{coverage.activeUnresolvedCount}</strong></div>
                <div><small>{zh ? '历史未解决审计' : 'Lifetime unresolved audit'}</small><strong>{coverage.lifetimeUnresolvedCount}</strong></div>
                <div><small>{zh ? '工作区健康' : 'Workspace health'}</small><strong>{integrity ? `${integrity.score}/100` : '—'}</strong></div>
              </div>

              {integrity && integrity.issueCount > 0 ? (
                <div className="coverage-exceptions">
                  <h3>{zh ? '本地工作区完整性' : 'Local workspace integrity'}</h3>
                  <p>{zh
                    ? `${integrity.criticalCount} 严重 · ${integrity.warningCount} 警告 · ${integrity.infoCount} 提示。这里只报告，不自动修改 IndexedDB。`
                    : `${integrity.criticalCount} critical · ${integrity.warningCount} warning · ${integrity.infoCount} info. This view reports issues and never mutates IndexedDB automatically.`}</p>
                  {integrity.issues.slice(0, 6).map((issue, index) => (
                    <article key={`${issue.code}:${index}`}>
                      <strong>{issue.title}</strong>
                      <p>{issue.detail}</p>
                      <small>{integritySeverity(issue.severity, zh)} · {issue.code}</small>
                    </article>
                  ))}
                </div>
              ) : integrity ? (
                <p className="coverage-success">{zh ? '✓ 本地 raw IndexedDB 结构扫描未发现已知完整性问题。' : '✓ The raw local IndexedDB scan found no known integrity issues.'}</p>
              ) : null}

              {coverage.missingSources.length ? (
                <div className="coverage-exceptions">
                  <h3>{zh ? '尚未完成过摄入的已启用来源' : 'Enabled sources with no completed ingestion run'}</h3>
                  {coverage.missingSources.map((source) => (
                    <article key={`missing:${source.sourceKind}:${source.sourceId}`}>
                      <strong>{sourceLabel(source.sourceKind, source.sourceId, source.label)}</strong>
                      <p>{zh ? '这个来源尚没有可验证的完成 run，因此系统健康状态不会显示绿色。' : 'This source has no verifiable completed run yet, so system health cannot be green.'}</p>
                      <small>{source.cadenceMinutes ? (zh ? `计划每 ${formatCadence(source.cadenceMinutes, zh)}` : `Every ${formatCadence(source.cadenceMinutes, zh)}`) : ''}{source.maxAgeHours ? ` · SLA ${source.maxAgeHours}h` : ''}</small>
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
                        <small>{formatTime(source.lastCompletedAt, zh)}{source.stale ? (zh ? ' · 已过期' : ' · stale') : ''}</small>
                      </div>
                      <span className={source.balanced && source.transportGapCount === 0 && !source.stale ? 'good' : 'warn'}>{source.accountedCount}/{source.receivedCount}</span>
                      <p>{outcomeText(source.outcomes, zh) || (zh ? '本轮 0 条输入' : '0 inputs in this run')}{source.activeUnresolvedCount ? (zh ? ` · 当前未解决 ${source.activeUnresolvedCount}` : ` · active unresolved ${source.activeUnresolvedCount}`) : ''}{source.lifetimeUnresolvedCount ? (zh ? ` · 历史审计 ${source.lifetimeUnresolvedCount}` : ` · lifetime audit ${source.lifetimeUnresolvedCount}`) : ''}{source.transportGapCount ? (zh ? ` · ${source.transportGapCount} 条覆盖缺口` : ` · ${source.transportGapCount} transport gap(s)`) : ''}{source.interpretationFailureCount ? (zh ? ` · ${source.interpretationFailureCount} 条解释失败` : ` · ${source.interpretationFailureCount} interpretation failure(s)`) : ''}{source.businessAmbiguityCount ? (zh ? ` · ${source.businessAmbiguityCount} 条业务歧义` : ` · ${source.businessAmbiguityCount} business ambiguity item(s)`) : ''}{source.capabilityBoundaryCount ? (zh ? ` · ${source.capabilityBoundaryCount} 条能力边界` : ` · ${source.capabilityBoundaryCount} capability limit(s)`) : ''}{source.cadenceMinutes ? (zh ? ` · 每 ${formatCadence(source.cadenceMinutes, zh)}` : ` · every ${formatCadence(source.cadenceMinutes, zh)}`) : ''}{source.maxAgeHours ? ` · SLA ${source.maxAgeHours}h` : ''}</p>
                      {health ? <small>{zh
                        ? `24h ${health.runCount24h} 次 · 7天健康 ${health.healthyRunCount7d}/${health.runCount7d} · 连续健康 ${health.consecutiveHealthyRuns} · 下次预计 ${formatTime(health.nextExpectedBy, zh)}`
                        : `24h ${health.runCount24h} runs · 7d healthy ${health.healthyRunCount7d}/${health.runCount7d} · ${health.consecutiveHealthyRuns} healthy in a row · next expected ${formatTime(health.nextExpectedBy, zh)}`}</small> : null}
                    </article>
                  )
                })}
              </div>

              {coverage.exceptions.length ? (
                <div className="coverage-exceptions">
                  <h3>{zh ? '当前需要处理的来源异常' : 'Active source issues that need attention'}</h3>
                  <p>{zh
                    ? `这里只显示当前仍会阻塞 Coverage 的未解决项。历史上曾 unresolved 的 ${coverage.lifetimeUnresolvedCount} 条来源记录仍保留在审计历史中，其中 ${coverage.settledHistoricalUnresolvedCount} 条已不再阻塞当前状态。`
                    : `Only currently active unresolved items appear here. Lifetime audit still retains ${coverage.lifetimeUnresolvedCount} source record(s) that were unresolved when ingested; ${coverage.settledHistoricalUnresolvedCount} no longer block current health.`}</p>
                  {coverage.exceptions.slice(0, 8).map((record) => (
                    <article key={record.id}>
                      <strong>{record.company && record.role ? `${record.company}｜${record.role}` : record.sourceRef ?? record.title}</strong>
                      <p>{record.detail ?? (zh ? '来源记录尚未能安全归入工作区。' : 'The source record could not yet be safely reconciled into the workspace.')}</p>
                      <small>{issueText(record.ingestion?.issueKinds, zh)} · {record.ingestion?.sourceKind} · {record.ingestion?.sourceRecordId}</small>
                    </article>
                  ))}
                </div>
              ) : coverage.allCaughtUp ? (
                <p className="coverage-success">{zh
                  ? `✓ 当前 ${coverage.expectedSourceCount} 个已启用来源都在各自 SLA 内完成，最新 run 守恒，且没有当前未解决输入。历史审计仍保留 ${coverage.lifetimeUnresolvedCount} 条曾经 unresolved 的来源记录。`
                  : `✓ All ${coverage.expectedSourceCount} enabled sources are within SLA, the latest runs reconcile, and there are no active unresolved inputs. Lifetime audit still retains ${coverage.lifetimeUnresolvedCount} historically unresolved source record(s).`}</p>
              ) : null}

              {coverage.capabilityBoundaries.length ? (
                <div className="coverage-exceptions">
                  <h3>{zh ? '当前能力边界' : 'Current capability limits'}</h3>
                  <p>{zh ? '这些来源记录已单独对账；此处提示尚不读取的内容，不计为待处理解析异常。' : 'These source records are accounted for separately. Unsupported content is shown here and is not counted as a parsing exception.'}</p>
                  {coverage.capabilityBoundaries.slice(0, 8).map((record) => (
                    <article key={`boundary:${record.id}`}>
                      <strong>{record.company && record.role ? `${record.company}｜${record.role}` : record.sourceRef ?? record.title}</strong>
                      <p>{record.ingestion?.capabilityBoundaries?.join(' ')}</p>
                      <small>{record.ingestion?.sourceKind} · {record.ingestion?.sourceRecordId}</small>
                    </article>
                  ))}
                </div>
              ) : null}

              <p className="coverage-footnote">{zh
                ? 'Coverage 的绿色状态只由当前 active unresolved、来源缺失/过期、transport gap 与 run 守恒决定；历史 unresolved 审计不会单独制造红灯。Integrity 检查本地持久化结构。两者都不声称“互联网上不存在尚未被任何监控发现的岗位”。'
                : 'Green Coverage is blocked by active unresolved state, missing/stale sources, transport gaps, or unbalanced runs—not by settled historical audit debt alone. Integrity checks local durable structure. Neither claims every job on the internet has been discovered.'}</p>
            </>
          )}
        </section>
      ) : null}
    </div>
  )
}

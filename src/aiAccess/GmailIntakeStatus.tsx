import { googleConnectionHealth, googleConnectionHealthLabel } from '../googleConnectionHealth.js'
import { useEffect, useMemo, useState } from 'react'
import { getAllTimelineRecords } from '../db.js'
import { expectedSourcesFromRegistry, summarizeCoverage } from '../ingestion.js'
import type { TimelineRecord } from '../model.js'

function boundaryText(text: string, zh: boolean) {
  if (!zh) return text
  if (text.startsWith('Attachment content')) return '附件内容尚未读取；如有重要信息，请查看原邮件。'
  if (text.startsWith('Linked pages')) return '链接页面尚未读取；链接本身不会作为已验证事实。'
  if (text.startsWith('Gmail initial backfill')) return '首次回补限最近 90 天；更早邮件及垃圾箱不在当前范围，后续按期检查。'
  return '此来源有已记录的能力边界；请查看原邮件确认未读取的细节。'
}

export default function GmailIntakeStatus({ zh, enabled, lastSuccessAt, lastCheckedAt, lastError }: {
  zh: boolean
  enabled: boolean | undefined
  lastSuccessAt?: string
  lastCheckedAt?: string
  lastError?: string
}) {
  const [timeline, setTimeline] = useState<TimelineRecord[]>([])
  const [now, setNow] = useState(() => new Date())
  const [loaded, setLoaded] = useState(false)
  const [readError, setReadError] = useState(false)

  useEffect(() => {
    let active = true
    const reload = async () => {
      try {
        const records = await getAllTimelineRecords()
        if (active) { setTimeline(records); setNow(new Date()); setLoaded(true); setReadError(false) }
      } catch {
        if (active) { setLoaded(true); setReadError(true) }
      }
    }
    void reload()
    const refresh = () => { void reload() }
    const interval = window.setInterval(refresh, 120_000)
    window.addEventListener('focus', refresh)
    window.addEventListener('pjsdas:workspace-replaced', refresh)
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pjsdas:workspace-replaced', refresh)
    }
  }, [])

  const coverage = useMemo(() => summarizeCoverage(timeline, {
    now, expectedSources: expectedSourcesFromRegistry(timeline).filter((source) => source.sourceKind === 'gmail' && source.sourceId === 'gmail:primary'),
  }), [timeline, now])
  const source = coverage.sources.find((item) => item.sourceKind === 'gmail' && item.sourceId === 'gmail:primary')
  if (enabled === false && !source && !lastSuccessAt && !lastError) return null

  const health = googleConnectionHealth({ verified: enabled !== undefined, enabled, lastSuccessAt, lastError, now: now.getTime(), freshnessSlaMinutes: source?.freshnessSlaMinutes })
  const transport = health === 'reconnect_required' || health === 'configuration_error' || health === 'stale'
    ? googleConnectionHealthLabel(health, zh)
    : enabled === undefined
    ? (zh ? '状态待核对' : 'Status unverified')
    : !loaded
    ? (zh ? '正在核对' : 'Checking')
    : readError
      ? (zh ? '本机结果不可读取' : 'Local results unavailable')
      : !enabled
        ? (zh ? '已关闭' : 'Disabled')
        : lastError
          ? (zh ? '最近检查失败' : 'Latest check failed')
          : coverage.transportGapCount
            ? (zh ? '历史覆盖有缺口' : 'Historical coverage gap')
            : !lastSuccessAt || !source
              ? (zh ? '尚无可核对的完成记录' : 'No verifiable completed run yet')
              : !source.balanced
                ? (zh ? '接收与对账不一致' : 'Received/accounted mismatch')
                : source.stale
                  ? (zh ? '检查已过期' : 'Check is stale')
                  : (zh ? '最近检查已对账' : 'Latest check reconciled')

  const boundaries = coverage.capabilityBoundaries.filter((record) => record.ingestion?.sourceKind === 'gmail')
  const reviewCount = coverage.interpretationFailureCount + coverage.businessAmbiguityCount
  return (
    <div className="settings-intake-status" aria-label={zh ? 'Gmail 来源结果' : 'Gmail source outcomes'}>
      <details className="settings-intake-details"><summary aria-label={zh ? `查看邮件核对结果：${reviewCount} 项待核对${lastError && enabled ? '；新邮件进展可能未同步' : ''}` : `Review email reconciliation: ${reviewCount} need review${lastError && enabled ? '; new email progress may be missing' : ''}`} className={lastError || readError ? 'settings-short-warning' : ''}>
        {lastError && enabled ? <span role="status">{zh ? '新邮件进展可能未同步' : 'New email progress may be missing'}</span> : readError ? (zh ? '本机结果不可读取' : 'Local results unavailable') : reviewCount ? (zh ? `${reviewCount} 项待核对` : `${reviewCount} need review`) : (zh ? '查看检查结果' : 'View check results')}
        <span aria-hidden="true">›</span>
      </summary>
      <div className="settings-intake-content">
      <span>{zh ? `传输与对账：${transport}` : `Transport and accounting: ${transport}`}</span>
      <span>{lastSuccessAt ? `${zh ? '最近完整同步：' : 'Last complete sync: '}${new Date(lastSuccessAt).toLocaleString()}` : (zh ? '尚无可核对的成功检查记录' : 'No verified successful check yet')}</span>
      <span>{lastCheckedAt ? `${zh ? '最近尝试：' : 'Last attempt: '}${new Date(lastCheckedAt).toLocaleString()}` : (zh ? '尚无检查尝试记录' : 'No recorded attempt')}</span>
      {readError ? <span>{zh ? '本机来源结果暂不可读取。' : 'Local source outcomes are temporarily unavailable.'}</span> : (
        <>
          <span>{zh
            ? `解释失败 ${coverage.interpretationFailureCount} · 业务歧义 ${coverage.businessAmbiguityCount} · 历史覆盖缺口 ${coverage.transportGapCount} · 正常能力边界 ${coverage.capabilityBoundaryCount}${coverage.unclassifiedUnresolvedCount ? ` · 历史未分类 ${coverage.unclassifiedUnresolvedCount}` : ''}`
            : `Interpretation failures ${coverage.interpretationFailureCount} · Business ambiguities ${coverage.businessAmbiguityCount} · Historical transport gaps ${coverage.transportGapCount} · Normal capability limits ${coverage.capabilityBoundaryCount}${coverage.unclassifiedUnresolvedCount ? ` · Legacy unclassified ${coverage.unclassifiedUnresolvedCount}` : ''}`}</span>
          {coverage.interpretationFailureCount || coverage.businessAmbiguityCount ? (
            <small>{zh ? '失败或歧义未自动写入；请核对原邮件和待确认的业务事实。' : 'Failed or ambiguous facts were not guessed into the workspace; review the original mail and any pending decision.'}</small>
          ) : null}
          {boundaries.length ? <details><summary>{zh ? '查看未读取的内容边界' : 'View unsupported content boundaries'}</summary>
            {boundaries.slice(0, 4).flatMap((record) => record.ingestion?.capabilityBoundaries ?? []).slice(0, 6).map((text, index) => <p key={`${index}:${text}`}>{boundaryText(text, zh)}</p>)}
          </details> : null}
        </>
      )}
      </div></details>
    </div>
  )
}

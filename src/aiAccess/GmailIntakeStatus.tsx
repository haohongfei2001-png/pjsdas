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

export default function GmailIntakeStatus({ zh, enabled, lastSuccessAt, lastError }: {
  zh: boolean
  enabled: boolean
  lastSuccessAt?: string
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
  if (!enabled && !source && !lastSuccessAt && !lastError) return null

  const transport = !loaded
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
  return (
    <div className={`cloud-connection-impact${readError || coverage.transportGapCount || coverage.interpretationFailureCount || coverage.businessAmbiguityCount ? ' warning' : ''}`} aria-label={zh ? 'Gmail 来源结果' : 'Gmail source outcomes'}>
      <strong>{zh ? 'Gmail 来源结果' : 'Gmail source outcomes'}</strong>
      <span>{zh ? `传输与对账：${transport}` : `Transport and accounting: ${transport}`}</span>
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
    </div>
  )
}

import { useMemo, useState } from 'react'
import type { ChangeSetRecord } from './changeSet.js'
import { assertMcpChangeSetBaseline } from './ai/mcpProposalApply.js'
import type { TimelineRecord } from './model.js'
import { summarizeCoverage } from './ingestion.js'
import { useUiLanguage } from './uiLanguage.js'
import './attention.css'

function formatDateTime(iso: string, zh: boolean) {
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

export default function AttentionView({
  timeline,
  changeSets,
  onApplyChangeSet,
  onDiscardChangeSet,
}: {
  timeline: TimelineRecord[]
  changeSets: ChangeSetRecord[]
  onApplyChangeSet: (id: string) => Promise<void>
  onDiscardChangeSet: (id: string) => Promise<void>
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const coverage = useMemo(() => summarizeCoverage(timeline), [timeline])
  const unresolved = coverage.exceptions
  const governed = useMemo(
    () => changeSets
      .filter((item) => item.status === 'pending' || item.status === 'failed')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [changeSets],
  )

  async function resolve(changeSet: ChangeSetRecord, action: 'apply' | 'discard') {
    setBusyId(changeSet.id)
    setError('')
    try {
      if (action === 'apply') {
        if (changeSet.source === 'mcp') await assertMcpChangeSetBaseline(changeSet)
        await onApplyChangeSet(changeSet.id)
      } else {
        await onDiscardChangeSet(changeSet.id)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyId(null)
    }
  }

  const total = governed.length + unresolved.length

  return (
    <section className="attention-page">
      <div className="attention-summary">
        <div><span>{zh ? '需要你决定' : 'Needs your decision'}</span><strong>{governed.length}</strong></div>
        <div><span>{zh ? '来源待解析' : 'Source exceptions'}</span><strong>{unresolved.length}</strong></div>
        <div className={total ? 'needs-attention' : ''}><span>{zh ? '当前 Attention' : 'Current attention'}</span><strong>{total}</strong></div>
      </div>

      {error ? <div className="attention-error">{error}</div> : null}

      {total === 0 ? (
        <div className="attention-clear">
          <strong>{zh ? '没有需要你处理的异常' : 'Nothing needs your intervention'}</strong>
          <p>{zh
            ? '能由规则、AI 或自动化安全处理的事项不会出现在这里。'
            : 'Anything PJSDAS can safely resolve through rules, AI, or automation stays out of Attention.'}</p>
        </div>
      ) : null}

      {governed.length ? (
        <section className="attention-section">
          <div className="attention-section-head">
            <div><span className="eyebrow">GOVERNED CHANGES</span><h2>{zh ? '需要明确确认的变更' : 'Changes that require explicit approval'}</h2></div>
            <span>{governed.length}</span>
          </div>
          <div className="attention-list">
            {governed.map((item) => (
              <article className={`attention-item changeset-${item.status}`} key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.operations.slice(0, 4).map((operation) => operation.summary).join(' · ')}</p>
                  <small>{item.source.toUpperCase()} · {item.operations.length} {zh ? '项变更' : 'operations'} · {formatDateTime(item.createdAt, zh)}</small>
                </div>
                <div className="attention-actions">
                  <span>{item.status === 'failed' ? (zh ? '上次执行失败' : 'Last attempt failed') : (zh ? '等待确认' : 'Waiting for approval')}</span>
                  {item.status === 'pending' ? (
                    <div>
                      <button disabled={busyId === item.id} onClick={() => { void resolve(item, 'discard') }}>{zh ? '放弃' : 'Discard'}</button>
                      <button className="apply" disabled={busyId === item.id} onClick={() => { void resolve(item, 'apply') }}>{busyId === item.id ? '…' : (zh ? '应用' : 'Apply')}</button>
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {unresolved.length ? (
        <section className="attention-section">
          <div className="attention-section-head">
            <div><span className="eyebrow">SOURCE EXCEPTIONS</span><h2>{zh ? '自动化无法安全判定的来源记录' : 'Source records automation could not safely resolve'}</h2></div>
            <span>{unresolved.length}</span>
          </div>
          <div className="attention-list">
            {unresolved.map((item) => (
              <article className="attention-item source-exception" key={item.id}>
                <div>
                  <strong>{item.company && item.role ? [item.company, item.role].join('｜') : item.title}</strong>
                  <p>{item.detail ?? (zh ? '该来源没有足够证据自动落入正式业务状态。' : 'This source did not have enough evidence for an automatic business-state update.')}</p>
                  <small>{item.ingestion?.sourceKind ?? item.source} · {formatDateTime(item.recordedAt, zh)}</small>
                </div>
                {item.sourceRef ? <a href={item.sourceRef.startsWith('http') ? item.sourceRef : undefined} target="_blank" rel="noreferrer">{zh ? '查看来源' : 'View source'}</a> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  )
}
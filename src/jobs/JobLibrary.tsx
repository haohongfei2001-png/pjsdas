import { useMemo } from 'react'
import type { Opportunity } from '../model.js'
import type { OpportunityDecisionListRead, OpportunityDecisionRead } from '../opportunityDecisionRead.js'
import { presentStageLabel } from '../stagePresentation.js'
import { useUiLanguage } from '../uiLanguage.js'
import './jobs.css'

export type JobFilter = 'all' | 'unapplied' | 'in_progress' | 'ended'

function group(item: OpportunityDecisionRead, opportunity?: Opportunity): JobFilter {
  if (item.bucket === 'ended' || opportunity?.processStage === 'closed' || opportunity?.participationStatus === 'abandoned') return 'ended'
  if (opportunity?.processStage === 'not_applied' || opportunity?.processStage === 'waiting_release') return 'unapplied'
  return 'in_progress'
}

function applicationUrl(opportunity?: Opportunity) {
  if (!opportunity || opportunity.processStage !== 'not_applied' || opportunity.participationStatus === 'abandoned') return undefined
  const value = opportunity.detail?.userFacts?.applicationUrl ?? opportunity.detail?.facts?.application?.applicationUrl
  if (!value) return undefined
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined } catch { return undefined }
}

function deadlineLabel(opportunity: Opportunity | undefined, zh: boolean) {
  if (!opportunity?.deadline) return undefined
  const value = opportunity.deadline
  if (opportunity.deadlinePrecision === 'date') {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (match) return zh ? `${Number(match[2])}月${Number(match[3])}日` : `${match[2]}/${match[3]}`
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

export default function JobLibrary({ read, opportunities, filter, onFilterChange, query, onQueryChange, visibleCount, onVisibleCountChange, onOpenOpportunity }: {
  read: OpportunityDecisionListRead
  opportunities: Opportunity[]
  filter: JobFilter
  onFilterChange: (value: JobFilter) => void
  query: string
  onQueryChange: (value: string) => void
  visibleCount: number
  onVisibleCountChange: (value: number) => void
  onOpenOpportunity: (id: string) => void
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const byId = useMemo(() => new Map(opportunities.map((item) => [item.id, item])), [opportunities])
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return read.all.filter((item) => {
      if (filter !== 'all' && group(item, byId.get(item.opportunityId)) !== filter) return false
      return !needle || `${item.company} ${item.role}`.toLocaleLowerCase().includes(needle)
    })
  }, [read, byId, filter, query])
  const visible = filtered.slice(0, visibleCount)
  const options: Array<[JobFilter, string, string]> = [
    ['all', '全部', 'All'], ['unapplied', '待投递', 'To apply'],
    ['in_progress', '推进中', 'In progress'], ['ended', '已结束', 'Ended'],
  ]
  return <section className="tsui-library" aria-label={zh ? '岗位库' : 'Job library'}>
    <header className="tsui-library-heading"><h1>{zh ? '岗位库' : 'Job library'}</h1><span>{read.all.length} {zh ? '个岗位' : 'jobs'}</span></header>
    <div className="tsui-library-toolbar">
      <div className="tsui-library-filters" role="group" aria-label={zh ? '岗位状态' : 'Job status'}>
        {options.map(([value, labelZh, labelEn]) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => { onFilterChange(value); onVisibleCountChange(40) }}>{zh ? labelZh : labelEn}</button>)}
      </div>
      <input type="search" value={query} onChange={(event) => { onQueryChange(event.target.value); onVisibleCountChange(40) }} aria-label={zh ? '搜索公司或岗位' : 'Search company or role'} placeholder={zh ? '搜索公司或岗位' : 'Search company or role'} />
    </div>
    <div className="tsui-library-panel">
      {visible.map((item) => {
        const opportunity = byId.get(item.opportunityId)
        const url = applicationUrl(opportunity)
        const ended = group(item, opportunity) === 'ended'
        const deadline = deadlineLabel(opportunity, zh)
        return <article className="tsui-job-row" key={item.opportunityId} data-opportunity-id={item.opportunityId}>
          <button type="button" className="opportunity-decision-row tsui-job-open" data-opportunity-id={item.opportunityId} onClick={() => onOpenOpportunity(item.opportunityId)}>
            <span className="tsui-job-mark" aria-hidden="true">{item.company.slice(0, 2)}</span>
            <span className="tsui-job-identity"><strong>{item.company}</strong><span>{item.role}</span></span>
            <span className="tsui-job-meta"><strong>{deadline ?? (zh ? '时间待定' : 'Date pending')}</strong><span>{deadline ? (zh ? '申请截止' : 'Application deadline') : presentStageLabel(item.process.stage, undefined, lang)}</span></span>
            {!url ? <span className="tsui-job-state">{ended ? (zh ? '已结束' : 'Ended') : presentStageLabel(item.process.stage, undefined, lang)} <span aria-hidden="true">→</span></span> : null}
          </button>
          {url ? <a className="tsui-job-apply" href={url} target="_blank" rel="noopener noreferrer" aria-label={(zh ? '打开申请入口：' : 'Open application: ') + item.company + ' · ' + item.role}>{zh ? '投递 ↗' : 'Apply ↗'}</a> : null}
        </article>
      })}
      {!filtered.length ? <div className="tsui-library-empty"><strong>{query ? (zh ? '没有匹配结果' : 'No matching jobs') : (zh ? '这里暂时没有岗位' : 'No jobs in this view')}</strong>{query ? <button type="button" onClick={() => onQueryChange('')}>{zh ? '清除搜索' : 'Clear search'}</button> : null}</div> : null}
      {visible.length < filtered.length ? <button className="tsui-library-more" type="button" onClick={() => onVisibleCountChange(Math.min(visibleCount + 40, filtered.length))}>{zh ? `继续加载（已显示 ${visible.length}/${filtered.length}）` : `Load more (${visible.length}/${filtered.length})`}</button> : null}
    </div>
    <p className="tsui-library-total">{zh ? `${filtered.length} 个岗位` : `${filtered.length} jobs`}</p>
  </section>
}

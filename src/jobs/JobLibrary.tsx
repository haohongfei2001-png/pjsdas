import { useMemo } from 'react'
import type { JobCategory } from '../applicationDeadline.js'
import type { Opportunity } from '../model.js'
import type { OpportunityDecisionListRead, OpportunityDecisionRead } from '../opportunityDecisionRead.js'
import { presentStageLabel } from '../stagePresentation.js'
import { useUiLanguage } from '../uiLanguage.js'
import './jobs.css'

export type JobFilter = 'all' | JobCategory

function applicationUrl(opportunity: Opportunity | undefined, stage: OpportunityDecisionRead['process']['stage']) {
  if (!opportunity || stage !== 'not_applied' || opportunity.participationStatus === 'abandoned') return undefined
  const value = opportunity.detail?.userFacts?.applicationUrl ?? opportunity.detail?.facts?.application?.applicationUrl
  if (!value) return undefined
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined } catch { return undefined }
}

function deadlineLabel(item: OpportunityDecisionRead, zh: boolean) {
  if (!item.applicationDeadline?.deadline) return undefined
  const value = item.applicationDeadline.deadline
  if (item.applicationDeadline.precision === 'date') {
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
  onOpenOpportunity: (id: string, opener?: HTMLElement) => void
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const byId = useMemo(() => new Map(opportunities.map((item) => [item.id, item])), [opportunities])
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return read.all.filter((item) => {
      if (filter !== 'all' && item.category !== filter) return false
      return !needle || `${item.company} ${item.role}`.toLocaleLowerCase().includes(needle)
    })
  }, [read, byId, filter, query])
  const visible = filtered.slice(0, visibleCount)
  const options: Array<[JobFilter, string, string]> = [
    ['all', '全部', 'All'], ['to_apply', '待投递', 'To apply'], ['applied', '已投递', 'Applied'],
    ['written_test', '收到笔试', 'Written test'], ['interview', '收到面试', 'Interview'],
    ['process_ended', '流程结束', 'Process ended'], ['deadline_passed', '时间截止', 'Deadline passed'], ['no_deadline', '无截止日期', 'No deadline'],
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
        const url = item.category === 'to_apply' || item.category === 'no_deadline' ? applicationUrl(opportunity, item.process.stage) : undefined
        const deadline = deadlineLabel(item, zh)
        const stateLabel = item.process.stage === 'offer' ? 'Offer' : item.process.result === 'rejected' ? (zh ? '已拒绝' : 'Rejected') : opportunity?.participationStatus === 'abandoned' ? (zh ? '已放弃' : 'Withdrawn') : item.category === 'deadline_passed' ? (zh ? '时间截止' : 'Deadline passed') : presentStageLabel(item.process.stage, undefined, lang)
        return <article className="tsui-job-row" key={item.opportunityId} data-opportunity-id={item.opportunityId}>
          <button type="button" className="opportunity-decision-row tsui-job-open" data-opportunity-id={item.opportunityId} onClick={event => onOpenOpportunity(item.opportunityId, event.currentTarget)}>
            <span className="tsui-job-mark" aria-hidden="true">{item.company.slice(0, 2)}</span>
            <span className="tsui-job-identity"><strong>{item.company}</strong><span>{item.role}</span></span>
            <span className="tsui-job-meta"><strong>{deadline ?? (item.category === 'no_deadline' ? (zh ? '无截止日期' : 'No deadline') : presentStageLabel(item.process.stage, undefined, lang))}</strong><span>{deadline ? (zh ? '申请截止' : 'Application deadline') : presentStageLabel(item.process.stage, undefined, lang)}</span></span>
            {!url ? <span className="tsui-job-state">{stateLabel} <span aria-hidden="true">→</span></span> : null}
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

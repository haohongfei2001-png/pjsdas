import { Fragment, useEffect, useRef, useState } from 'react'
import type { Opportunity } from '../model.js'
import { readScheduleWindow, type ScheduleEntry, type ScheduleSection, type ScheduleStream } from './scheduleStream.js'
import { useUiLanguage } from '../uiLanguage.js'

const KIND: Record<string, [string, string]> = {
  interview: ['面试', 'Interview'], written_test: ['笔试', 'Written test'],
  assessment: ['测评', 'Assessment'], application_deadline: ['申请截止', 'Application deadline'],
  follow_up: ['跟进', 'Follow up'], prep_trigger: ['准备节点', 'Preparation'],
}

function timeLabel(entry: ScheduleEntry, zh: boolean) {
  const temporal = entry.node?.temporal
  if (temporal?.precision === 'date' && temporal.date) return temporal.date
  const at = temporal?.startAt ?? temporal?.deadlineAt ?? entry.occurredAt
  if (!at) return zh ? '时间待定' : 'Time TBD'
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return entry.date ?? (zh ? '时间待定' : 'Time TBD')
  const label = new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: temporal?.timezone || undefined }).format(date)
  if (temporal?.shape === 'availability_window') {
    const end = temporal.resolutionBasis !== 'legacy_projection' && temporal.endAt ? new Date(temporal.endAt) : undefined
    const endLabel = end && Number.isFinite(end.getTime())
      ? new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: temporal.timezone || undefined }).format(end)
      : undefined
    return (zh ? '可参加 ' : 'Available ') + label + (endLabel ? ' – ' + endLabel : '')
  }
  if (temporal?.deadlineAt && !temporal.startAt) return (zh ? '截止 · ' : 'Due · ') + label
  return label
}

export function ScheduleWindowList({ stream, section, opportunities, onOpenOpportunity, className = '' }: {
  stream: ScheduleStream
  section: ScheduleSection
  opportunities: Opportunity[]
  onOpenOpportunity: (id: string) => void
  className?: string
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [visible, setVisible] = useState(30)
  const loader = useRef<HTMLDivElement>(null)
  const total = stream.counts[section]
  const windowed = readScheduleWindow(stream, section, Math.min(visible, 500))
  const shown = visible > 500 ? stream.sections[section].slice(0, visible) : windowed.entries
  useEffect(() => {
    const target = loader.current
    if (!target || visible >= total || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver((items) => {
      if (items.some((item) => item.isIntersecting)) setVisible((count) => Math.min(total, count + 30))
    }, { rootMargin: '220px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [visible, total])
  if (!total) return <p className="tsui-empty">{zh ? '这里暂无有依据的记录。' : 'No recorded items here.'}</p>
  return <div className={'tsui-stream ' + className}>
    {shown.map((entry, index) => {
      const opportunity = opportunities.find((item) => item.id === entry.opportunityId)
      const title = entry.kind === 'node' ? (KIND[entry.title]?.[zh ? 0 : 1] ?? entry.title) : entry.title
      const text = [opportunity?.company, opportunity?.role].filter(Boolean).join(' · ')
      return <Fragment key={entry.id}>
        {(index === 0 || shown[index - 1].date !== entry.date) ? <h3 className="tsui-date-heading">{entry.date ?? (zh ? '时间待定' : 'Time TBD')}</h3> : null}
        <button className="tsui-node-row" type="button" disabled={!opportunity} onClick={() => { if (entry.opportunityId) onOpenOpportunity(entry.opportunityId) }}>
        <span className="tsui-node-time">{timeLabel(entry, zh)}</span>
        <span className="tsui-node-copy"><strong>{title}</strong><small>{text || (zh ? '独立事项' : 'Independent item')}</small></span>
        {entry.state === 'elapsed_unresolved' ? <span className="tsui-node-badge">{zh ? '待确认' : 'Unresolved'}</span> : null}
        {opportunity ? <span className="tsui-node-arrow" aria-hidden="true">›</span> : null}
        </button>
      </Fragment>
    })}
    <div ref={loader} className="tsui-load-anchor" />
    {visible < total ? <button className="tsui-load-more" type="button" onClick={() => setVisible((count) => Math.min(total, count + 30))}>{zh ? '继续加载' : 'Load more'} · {shown.length}/{total}</button> : <p className="tsui-end">{zh ? '已显示全部' : 'All items shown'} · {total}</p>}
  </div>
}

export default function ScheduleFeature({ stream, opportunities, onOpenOpportunity }: {
  stream: ScheduleStream
  opportunities: Opportunity[]
  onOpenOpportunity: (id: string) => void
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [section, setSection] = useState<ScheduleSection>(() => { const requested = new URLSearchParams(window.location.search).get('view'); return requested === 'unresolved' || requested === 'history' || requested === 'undated' ? requested : 'upcoming' })
  const tabs: Array<[ScheduleSection, string, string]> = [
    ['upcoming', '接下来', 'Upcoming'], ['unresolved', '待确认', 'Unresolved'],
    ['history', '已发生', 'Past'], ['undated', '时间待定', 'Undated'],
  ]
  return <section className="tsui-schedule-page">
    <header className="tsui-page-heading"><div><p>{zh ? '招聘进程' : 'YOUR PROGRESS'}</p><h1>{zh ? '日程' : 'Schedule'}</h1><span>{zh ? '真实发生的事，和接下来要面对的节点。' : 'What happened and what comes next.'}</span></div></header>
    <nav className="tsui-schedule-tabs" aria-label={zh ? '日程视图' : 'Schedule views'}>
      {tabs.map(([id, chinese, english]) => <button key={id} type="button" className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => { setSection(id); window.history.replaceState(null, '', window.location.pathname + '?view=' + id + window.location.hash) }}>{zh ? chinese : english}<span>{stream.counts[id]}</span></button>)}
    </nav>
    <div className="tsui-schedule-panel"><ScheduleWindowList key={stream.key + section} stream={stream} section={section} opportunities={opportunities} onOpenOpportunity={onOpenOpportunity} /></div>
  </section>
}

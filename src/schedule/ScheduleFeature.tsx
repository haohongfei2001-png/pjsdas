import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { Opportunity } from '../model.js'
import { readScheduleWindow, type ScheduleEntry, type ScheduleSection, type ScheduleStream } from './scheduleStream.js'
import { useUiLanguage } from '../uiLanguage.js'
import { localDateKey } from '../todayBrief.js'

const KIND: Record<string, [string, string]> = {
  interview: ['面试', 'Interview'], written_test: ['笔试', 'Written test'],
  assessment: ['测评', 'Assessment'], application_deadline: ['申请截止', 'Application deadline'],
  follow_up: ['跟进', 'Follow up'], prep_trigger: ['准备节点', 'Preparation'],
}

function timeLabel(entry: ScheduleEntry, zh: boolean) {
  const temporal = entry.node?.temporal
  if (entry.section === 'history' && entry.occurredAt) {
    const happened = new Date(entry.occurredAt)
    if (Number.isFinite(happened.getTime())) return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(happened)
  }
  if (temporal?.precision === 'date' && temporal.date) return temporal.date + (zh ? ' · 具体时间待定' : ' · Exact time TBD')
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


type View = 'all' | 'upcoming' | 'past' | 'unresolved' | 'undated'
type OccurrenceCommand = 'complete' | 'cancel' | 'reschedule'
type CommandResult = { outcome: 'COMMITTED' | 'ALREADY_APPLIED' | 'NO_WRITE'; commandId?: string; message: string }
type Props = {
  stream: ScheduleStream
  opportunities: Opportunity[]
  onOpenOpportunity: (id: string) => void
  canWrite?: boolean
  onOccurrenceCommand?: (entry: ScheduleEntry, kind: OccurrenceCommand, date?: string) => Promise<CommandResult>
  onUndoOccurrenceCommand?: (commandId: string) => Promise<void>
}

function sortEntries(a: ScheduleEntry, b: ScheduleEntry) {
  return (a.date ?? '9999-12-31').localeCompare(b.date ?? '9999-12-31')
    || (a.occurredAt ?? a.node?.temporal.startAt ?? a.node?.temporal.deadlineAt ?? '').localeCompare(
      b.occurredAt ?? b.node?.temporal.startAt ?? b.node?.temporal.deadlineAt ?? '')
    || a.id.localeCompare(b.id)
}

function localDateTimeInput(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (number: number) => String(number).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function requestedView(): View {
  const value = new URLSearchParams(window.location.search).get('view')
  if (value === 'history' || value === 'past') return 'past'
  if (value === 'upcoming' || value === 'unresolved' || value === 'undated') return value
  return 'all'
}

function initialRange(entries: ScheduleEntry[], view: View, today: string) {
  if (view !== 'all') return { start: 0, end: Math.min(entries.length, 30) }
  const index = entries.findIndex((entry) => (entry.date ?? '9999-12-31') >= today)
  const anchor = index < 0 ? entries.length : index
  if (anchor === entries.length) return { start: Math.max(0, entries.length - 30), end: entries.length }
  return { start: anchor, end: Math.min(entries.length, anchor + 30) }
}

export default function ScheduleFeature({
  stream, opportunities, onOpenOpportunity, canWrite = false, onOccurrenceCommand, onUndoOccurrenceCommand,
}: Props) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const today = localDateKey(new Date(stream.evaluatedAt), stream.timezone)
  const all = useMemo(() => [
    ...stream.sections.history, ...stream.sections.unresolved, ...stream.sections.upcoming,
  ].sort(sortEntries), [stream])
  const [view, setView] = useState<View>(requestedView)
  const entries = useMemo(() => view === 'all' ? all
    : view === 'past' ? [...stream.sections.history].reverse()
      : stream.sections[view], [all, stream, view])
  const [range, setRange] = useState(() => initialRange(entries, view, today))
  const [selectedId, setSelectedId] = useState<string>()
  const [month, setMonth] = useState(today.slice(0, 7))
  const [pending, setPending] = useState<OccurrenceCommand>()
  const [confirm, setConfirm] = useState<OccurrenceCommand>()
  const [newDate, setNewDate] = useState('')
  const [feedback, setFeedback] = useState<{ text: string; commandId?: string; error?: boolean }>()
  const previousKey = useRef(stream.key)
  const listRef = useRef<HTMLDivElement>(null)
  const loader = useRef<HTMLDivElement>(null)
  const prependAnchor = useRef<{ id: string; top: number } | null>(null)
  const selected = selectedId
    ? [...all, ...stream.sections.undated].find((entry) => entry.id === selectedId)
    : undefined
  const shown = entries.slice(range.start, range.end)
  const byId = useMemo(() => new Map(opportunities.map((item) => [item.id, item])), [opportunities])

  useEffect(() => {
    if (previousKey.current === stream.key) return
    previousKey.current = stream.key
    const anchorId = listRef.current?.querySelector<HTMLElement>('[data-schedule-entry]')?.dataset.scheduleEntry
    const index = anchorId ? entries.findIndex((entry) => entry.id === anchorId) : -1
    setRange(index >= 0 ? { start: index, end: Math.min(entries.length, index + 30) }
      : initialRange(entries, view, today))
  }, [stream.key, entries, view, today])

  useEffect(() => {
    const anchor = prependAnchor.current
    if (!anchor) return
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-schedule-entry]') ?? [])]
      .find((item) => item.dataset.scheduleEntry === anchor.id)
    if (row) window.scrollBy(0, row.getBoundingClientRect().top - anchor.top)
    prependAnchor.current = null
  }, [range.start])

  useEffect(() => {
    const target = loader.current
    if (!target || range.end >= entries.length || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver((items) => {
      if (items.some((item) => item.isIntersecting)) {
        setRange((current) => ({ ...current, end: Math.min(entries.length, current.end + 30) }))
      }
    }, { rootMargin: '220px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [range.end, entries.length, view])

  function changeView(next: View) {
    const nextEntries = next === 'all' ? all : next === 'past'
      ? [...stream.sections.history].reverse() : stream.sections[next]
    setView(next)
    setRange(initialRange(nextEntries, next, today))
    setSelectedId(undefined)
    setFeedback(undefined)
    window.history.replaceState(null, '', window.location.pathname + (next === 'all' ? '' : '?view=' + next) + window.location.hash)
  }

  function locateMonth(value: string) {
    setMonth(value)
    const index = all.findIndex((entry) => (entry.date ?? '9999-12-31') >= value + '-01')
    if (index < 0) {
      changeView('all')
      setRange({ start: Math.max(0, all.length - 30), end: all.length })
      return
    }
    setView('all')
    setRange({ start: index, end: Math.min(all.length, index + 30) })
    setSelectedId(undefined)
    window.history.replaceState(null, '', window.location.pathname + window.location.hash)
    window.requestAnimationFrame(() => listRef.current?.scrollIntoView({ block: 'start' }))
  }

  function loadEarlier() {
    const first = listRef.current?.querySelector<HTMLElement>('[data-schedule-entry]')
    if (first?.dataset.scheduleEntry) prependAnchor.current = { id: first.dataset.scheduleEntry, top: first.getBoundingClientRect().top }
    setRange((current) => ({ ...current, start: Math.max(0, current.start - 30) }))
  }

  function openEntry(entry: ScheduleEntry) {
    setSelectedId(entry.id)
    setFeedback(undefined)
    setConfirm(undefined)
    const temporal = entry.node?.temporal
    setNewDate(temporal?.precision === 'datetime'
      ? localDateTimeInput(temporal.startAt ?? temporal.deadlineAt ?? '')
      : temporal?.date ?? entry.date ?? '')
  }

  async function runCommand(kind: OccurrenceCommand) {
    if (!selected || !onOccurrenceCommand || pending) return
    setPending(kind)
    setFeedback(undefined)
    try {
      const result = await onOccurrenceCommand(selected, kind, kind === 'reschedule' ? newDate : undefined)
      setFeedback({ text: result.message, commandId: result.outcome === 'COMMITTED' ? result.commandId : undefined })
      setConfirm(undefined)
      if (result.outcome !== 'NO_WRITE') setSelectedId(undefined)
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setPending(undefined)
    }
  }

  async function undoCommand(commandId: string) {
    if (!onUndoOccurrenceCommand) return
    setPending('complete')
    try {
      await onUndoOccurrenceCommand(commandId)
      setFeedback({ text: zh ? '已撤销这次日程变更。' : 'This schedule change was undone.' })
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setPending(undefined)
    }
  }

  const tabs: Array<[View, string, string, number]> = [
    ['all', '全部', 'All', all.length],
    ['upcoming', '接下来', 'Upcoming', stream.counts.upcoming],
    ['past', '已发生', 'Past', stream.counts.history],
  ]
  return <section className="tsui-schedule-page">
    <header className="tsui-page-heading"><div><h1>{zh ? '日程' : 'Schedule'}</h1></div></header>
    <div className="tsui-schedule-toolbar">
      <nav className="tsui-schedule-tabs" aria-label={zh ? '日程视图' : 'Schedule views'}>
        {tabs.map(([id, chinese, english, count]) => <button key={id} type="button" className={view === id ? 'active' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => changeView(id)}>{zh ? chinese : english}<span>{count}</span></button>)}
      </nav>
      <div className="tsui-schedule-locator">
        <label><span className="sr-only">{zh ? '选择月份' : 'Choose month'}</span><input type="month" value={month} onChange={(event) => locateMonth(event.target.value)} /></label>
        <button type="button" onClick={() => { setMonth(today.slice(0, 7)); changeView('all'); window.requestAnimationFrame(() => listRef.current?.scrollIntoView({ block: 'start' })) }}>{zh ? '今天' : 'Today'}</button>
      </div>
    </div>
    {(stream.counts.unresolved > 0 || stream.counts.undated > 0) ? <div className="tsui-schedule-context">
      {stream.counts.unresolved > 0 ? <button type="button" onClick={() => changeView('unresolved')}>{zh ? '过去安排待确认' : 'Past arrangements to confirm'} · {stream.counts.unresolved}</button> : null}
      {stream.counts.undated > 0 ? <button type="button" onClick={() => changeView('undated')}>{zh ? '时间待定' : 'Time TBD'} · {stream.counts.undated}</button> : null}
      {view === 'unresolved' || view === 'undated' ? <button type="button" onClick={() => changeView('all')}>{zh ? '返回全部' : 'Back to all'}</button> : null}
    </div> : null}
    <div className="tsui-schedule-panel" ref={listRef}>
      {range.start > 0 ? <button className="tsui-schedule-more" type="button" onClick={loadEarlier}>{zh ? '加载更早记录' : 'Load earlier records'} · {range.start}</button> : null}
      {shown.length ? shown.map((entry, index) => {
        const opportunity = entry.opportunityId ? byId.get(entry.opportunityId) : undefined
        const title = entry.kind === 'node' ? KIND[entry.title]?.[zh ? 0 : 1] ?? entry.title : entry.title
        const date = entry.date ?? (zh ? '时间待定' : 'Time TBD')
        const heading = index === 0 || shown[index - 1].date !== entry.date
        const todayMarker = view === 'all' && entry.date === today && (index === 0 || shown[index - 1].date !== today)
        return <Fragment key={entry.id}>
          {heading ? <h2 className={'tsui-schedule-date' + (todayMarker ? ' today' : '')}>{date}{todayMarker ? <span>{zh ? '今天' : 'Today'}</span> : null}</h2> : null}
          <button className="tsui-schedule-row" data-schedule-entry={entry.id} type="button" onClick={() => openEntry(entry)}>
            <span className="tsui-schedule-time">{timeLabel(entry, zh)}</span>
            <span className="tsui-schedule-copy"><strong>{title}</strong><small>{opportunity ? opportunity.company + ' · ' + opportunity.role : zh ? '独立事项' : 'Independent item'}</small></span>
            <span className={'tsui-schedule-state state-' + entry.section}>{entry.state === 'elapsed_unresolved' ? zh ? '待确认' : 'Unresolved'
              : entry.state === 'completed' ? zh ? '已完成' : 'Completed'
                : entry.state === 'cancelled' ? zh ? '已取消' : 'Cancelled'
                  : entry.state === 'superseded' ? zh ? '已改期' : 'Rescheduled'
                    : entry.section === 'history' ? zh ? '已发生' : 'Past'
                : entry.section === 'undated' ? zh ? '时间待定' : 'Time TBD'
                  : zh ? '接下来' : 'Upcoming'}</span>
            <span aria-hidden="true">›</span>
          </button>
        </Fragment>
      }) : <p className="tsui-empty">{zh ? '这里暂无有依据的记录。' : 'No recorded items here.'}</p>}
      <div ref={loader} className="tsui-load-anchor" />
      {range.end < entries.length ? <button className="tsui-load-more" type="button" onClick={() => setRange((current) => ({ ...current, end: Math.min(entries.length, current.end + 30) }))}>{zh ? '继续加载' : 'Load more'} · {range.end}/{entries.length}</button>
        : <p className="tsui-end">{zh ? '已显示全部' : 'All items shown'} · {entries.length}</p>}
    </div>
    {selected ? <aside className="tsui-schedule-detail" aria-labelledby="tsui-event-title">
      <div className="tsui-schedule-detail-head">
        <div><small>{selected.date ?? (zh ? '时间待定' : 'Time TBD')}</small><h2 id="tsui-event-title">{selected.kind === 'node' ? KIND[selected.title]?.[zh ? 0 : 1] ?? selected.title : selected.title}</h2></div>
        <button type="button" onClick={() => setSelectedId(undefined)} aria-label={zh ? '关闭详情' : 'Close details'}>×</button>
      </div>
      <p>{timeLabel(selected, zh)}</p>
      {selected.opportunityId && byId.has(selected.opportunityId) ? <p>{byId.get(selected.opportunityId)!.company} · {byId.get(selected.opportunityId)!.role}</p> : null}
      {selected.state === 'elapsed_unresolved' ? <p className="tsui-schedule-warning">{zh ? '时间已过，结果仍待确认；不会自动标记完成。' : 'The time passed, but the outcome is unconfirmed.'}</p> : null}
      {selected.opportunityId && byId.has(selected.opportunityId) ? <button type="button" className="tsui-schedule-job-link" onClick={() => onOpenOpportunity(selected.opportunityId!)}>{zh ? '查看岗位详情' : 'View job details'} →</button> : null}
      {selected.node?.occurrenceId && (selected.state === 'scheduled' || selected.state === 'elapsed_unresolved') ? <div className="tsui-schedule-commands">
        <h3>{zh ? '更新这次安排' : 'Update this occurrence'}</h3>
        {!canWrite ? <p>{zh ? '连接权威工作区后才能记录变更。' : 'Connect the authoritative workspace to record changes.'}</p>
          : <>
            {confirm === 'reschedule' ? <div className="tsui-schedule-reschedule"><label>{selected.node?.temporal.precision === 'datetime' ? zh ? '新的本地日期与时间' : 'New local date and time' : zh ? '新的日期' : 'New date'}<input type={selected.node?.temporal.precision === 'datetime' ? 'datetime-local' : 'date'} value={newDate} onChange={(event) => setNewDate(event.target.value)} /></label><p>{selected.node?.temporal.precision === 'datetime' ? zh ? '保留原有明确时长；按当前设备时区记录新时间。' : 'The explicit duration is preserved; new time uses this device timezone.' : zh ? '仅记录你确认的日期；不会补造具体时间。' : 'Only the confirmed date is recorded; no time is invented.'}</p><button type="button" disabled={!newDate || Boolean(pending)} onClick={() => { void runCommand('reschedule') }}>{zh ? '确认改期' : 'Confirm reschedule'}</button><button type="button" onClick={() => setConfirm(undefined)}>{zh ? '返回' : 'Back'}</button></div>
              : confirm === 'complete' || confirm === 'cancel' ? <div className="tsui-schedule-confirm"><p>{confirm === 'complete' ? zh ? '确认这次安排已完成？' : 'Confirm this occurrence completed?' : zh ? '确认取消这次安排？' : 'Confirm this occurrence cancelled?'}</p><button type="button" disabled={Boolean(pending)} onClick={() => { void runCommand(confirm) }}>{zh ? '确认' : 'Confirm'}</button><button type="button" onClick={() => setConfirm(undefined)}>{zh ? '返回' : 'Back'}</button></div>
                : <div className="tsui-schedule-command-buttons"><button type="button" onClick={() => setConfirm('complete')}>{zh ? '确认完成' : 'Mark complete'}</button><button type="button" onClick={() => setConfirm('reschedule')}>{zh ? '改期' : 'Reschedule'}</button><button type="button" onClick={() => setConfirm('cancel')}>{zh ? '取消安排' : 'Cancel occurrence'}</button></div>}
          </>}
      </div> : null}
      {selected.sourceRefs.length > 0 ? <details><summary>{zh ? '来源记录' : 'Source records'}</summary><ul>{selected.sourceRefs.map((ref) => <li key={ref}>{ref}</li>)}</ul></details> : null}
    </aside> : null}
    {feedback ? <div role={feedback.error ? 'alert' : 'status'} className={'tsui-schedule-feedback' + (feedback.error ? ' error' : '')}>{feedback.text}{feedback.commandId && onUndoOccurrenceCommand ? <button type="button" disabled={Boolean(pending)} onClick={() => { void undoCommand(feedback.commandId!) }}>{zh ? '撤销' : 'Undo'}</button> : null}</div> : null}
  </section>
}

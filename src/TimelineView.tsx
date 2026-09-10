import { useMemo, useState } from 'react'
import type { TimelineCategory, TimelineRecord, TimelineSource } from './model'
import { useUiLanguage } from './uiLanguage'
import './timeline.css'

const categories: TimelineCategory[] = ['opportunity', 'process', 'action', 'rules', 'data', 'note']
const sources: TimelineSource[] = ['excel', 'natural_language', 'process_event', 'user_action', 'rules', 'backup', 'system']

const categoryLabels: Record<TimelineCategory, [string, string]> = {
  opportunity: ['机会', 'Opportunity'],
  process: ['流程', 'Process'],
  action: ['行动', 'Action'],
  rules: ['规则', 'Rules'],
  data: ['数据', 'Data'],
  note: ['记录', 'Note'],
}

const sourceLabels: Record<TimelineSource, [string, string]> = {
  excel: ['Excel 历史', 'Excel history'],
  natural_language: ['自然语言', 'Natural language'],
  process_event: ['流程通知', 'Process event'],
  user_action: ['用户操作', 'User action'],
  rules: ['规则设置', 'Rules'],
  backup: ['本地备份', 'Backup'],
  system: ['系统回填', 'System'],
}

function dayKey(iso: string) {
  const date = new Date(iso)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatDay(iso: string, zh: boolean) {
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    year: 'numeric', month: zh ? 'long' : 'short', day: 'numeric', weekday: 'short',
  }).format(new Date(iso))
}

function formatTime(iso: string, zh: boolean) {
  const date = new Date(iso)
  if (date.getHours() === 0 && date.getMinutes() === 0) return zh ? '当天' : 'Date only'
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function changeValue(value: unknown) {
  if (value === undefined) return '—'
  if (value === null) return '∅'
  return String(value)
}

export default function TimelineView({ records }: { records: TimelineRecord[] }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'all' | TimelineCategory>('all')
  const [source, setSource] = useState<'all' | TimelineSource>('all')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return records.filter((item) => {
      if (category !== 'all' && item.category !== category) return false
      if (source !== 'all' && item.source !== source) return false
      if (!needle) return true
      return [item.title, item.detail, item.company, item.role, item.sourceRef]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle)
    })
  }, [records, query, category, source])

  const groups = useMemo(() => {
    const result: Array<{ key: string; date: string; items: TimelineRecord[] }> = []
    for (const item of filtered) {
      const key = dayKey(item.occurredAt)
      const last = result[result.length - 1]
      if (!last || last.key !== key) result.push({ key, date: item.occurredAt, items: [item] })
      else last.items.push(item)
    }
    return result
  }, [filtered])

  return (
    <section className="timeline-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">TIMELINE · V0.9</div>
          <h1>{zh ? '求职历程' : 'Timeline'}</h1>
          <p>{zh
            ? '已经发生的投递、流程节点、行动完成、规则修改和数据迁移都进入同一条可追溯时间线。Timeline 记录事实，不承担 Today 的任务排序。'
            : 'Applications, process events, completed actions, rule changes and data migrations share one traceable timeline. Timeline records facts; Today decides what to do next.'}</p>
        </div>
      </header>

      <div className="timeline-summary">
        <div><span>{zh ? '全部记录' : 'All records'}</span><strong>{records.length}</strong></div>
        <div><span>{zh ? '流程事件' : 'Process events'}</span><strong>{records.filter((item) => item.category === 'process').length}</strong></div>
        <div><span>{zh ? '机会 / 投递' : 'Opportunity / apply'}</span><strong>{records.filter((item) => item.category === 'opportunity').length}</strong></div>
      </div>

      <div className="timeline-toolbar">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? '搜索公司、岗位或事件' : 'Search company, role or event'} />
        <select value={category} onChange={(event) => setCategory(event.target.value as 'all' | TimelineCategory)}>
          <option value="all">{zh ? '全部类型' : 'All types'}</option>
          {categories.map((item) => <option value={item} key={item}>{categoryLabels[item][zh ? 0 : 1]}</option>)}
        </select>
        <select value={source} onChange={(event) => setSource(event.target.value as 'all' | TimelineSource)}>
          <option value="all">{zh ? '全部来源' : 'All sources'}</option>
          {sources.map((item) => <option value={item} key={item}>{sourceLabels[item][zh ? 0 : 1]}</option>)}
        </select>
        <span>{filtered.length} / {records.length}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-card"><strong>{zh ? '没有匹配的历程记录' : 'No matching timeline records'}</strong><p>{zh ? '调整搜索或筛选条件。' : 'Adjust search or filters.'}</p></div>
      ) : (
        <div className="timeline-groups">
          {groups.map((group) => (
            <section className="timeline-day" key={group.key}>
              <div className="timeline-day-label"><strong>{formatDay(group.date, zh)}</strong><span>{group.items.length} {zh ? '条' : 'events'}</span></div>
              <div className="timeline-day-events">
                {group.items.map((item) => (
                  <article className={`timeline-event category-${item.category}`} key={item.id}>
                    <div className="timeline-marker"><span /></div>
                    <div className="timeline-event-body">
                      <div className="timeline-event-meta">
                        <span className="timeline-category">{categoryLabels[item.category][zh ? 0 : 1]}</span>
                        <span>{sourceLabels[item.source][zh ? 0 : 1]}</span>
                        <span>{formatTime(item.occurredAt, zh)}</span>
                      </div>
                      <h3>{item.title}</h3>
                      {(item.company || item.role) ? <p className="timeline-entity">{[item.company, item.role].filter(Boolean).join('｜')}</p> : null}
                      {item.sourceRef && !item.company ? <p className="timeline-entity">{item.sourceRef}</p> : null}
                      {item.detail ? <p className="timeline-detail">{item.detail}</p> : null}
                      {item.changes && Object.keys(item.changes).length > 0 ? (
                        <div className="timeline-changes">
                          {Object.entries(item.changes).slice(0, 5).map(([key, value]) => (
                            <span key={key}><b>{key}</b> {changeValue(value.before)} → {changeValue(value.after)}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  )
}

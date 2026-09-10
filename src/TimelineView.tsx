import { useMemo, useState } from 'react'
import type { TimelineCategory, TimelineRecord, TimelineSource } from './model'
import type { ChangeSetRecord, ChangeSetSource, ChangeSetStatus } from './changeSet'
import { useUiLanguage } from './uiLanguage'
import './timeline.css'

const categories: TimelineCategory[] = ['opportunity', 'process', 'action', 'rules', 'change', 'data', 'note']
const sources: TimelineSource[] = ['excel', 'natural_language', 'process_event', 'user_action', 'rules', 'backup', 'system', 'changeset']

const categoryLabels: Record<TimelineCategory, [string, string]> = {
  opportunity: ['机会', 'Opportunity'],
  process: ['流程', 'Process'],
  action: ['行动', 'Action'],
  rules: ['规则', 'Rules'],
  change: ['变更集', 'ChangeSet'],
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
  changeset: ['ChangeSet', 'ChangeSet'],
}

const changeSetSourceLabels: Record<ChangeSetSource, [string, string]> = {
  natural_language: ['自然语言', 'Natural language'],
  rules: ['规则设置', 'Rules'],
  process_event: ['流程通知', 'Process event'],
  user_action: ['用户操作', 'User action'],
  api: ['API', 'API'],
  mcp: ['MCP', 'MCP'],
}

const changeSetStatusLabels: Record<ChangeSetStatus, [string, string]> = {
  pending: ['待确认', 'Pending'],
  applied: ['已应用', 'Applied'],
  discarded: ['已放弃', 'Discarded'],
  failed: ['失败', 'Failed'],
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

export default function TimelineView({ records, changeSets, onApplyChangeSet, onDiscardChangeSet }: { records: TimelineRecord[]; changeSets: ChangeSetRecord[]; onApplyChangeSet: (id: string) => Promise<void>; onDiscardChangeSet: (id: string) => Promise<void> }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'all' | TimelineCategory>('all')
  const [source, setSource] = useState<'all' | TimelineSource>('all')
  const [busyChangeSetId, setBusyChangeSetId] = useState<string | null>(null)

  async function resolveChangeSet(id: string, action: 'apply' | 'discard') {
    setBusyChangeSetId(id)
    try {
      if (action === 'apply') await onApplyChangeSet(id)
      else await onDiscardChangeSet(id)
    } finally {
      setBusyChangeSetId(null)
    }
  }

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
        <div><span>ChangeSet</span><strong>{changeSets.filter((item) => item.status === 'applied').length}</strong></div>
      </div>

      <details className="changeset-ledger">
        <summary>
          <div><span className="eyebrow">CHANGESET LEDGER</span><strong>{zh ? '变更集账本' : 'ChangeSet ledger'}</strong></div>
          <span>{changeSets.filter((item) => item.status === 'pending').length} {zh ? '条待确认' : 'pending'} · {changeSets.length} {zh ? '条记录' : 'records'}</span>
        </summary>
        <p>{zh ? '这里保存规范化修改和应用状态，不保存自然语言更新的完整原文。未来 API / MCP 也使用同一种协议。' : 'This ledger stores normalized changes and application status, not the full raw text of natural-language updates. Future API / MCP integrations use the same protocol.'}</p>
        {changeSets.length === 0 ? <div className="changeset-empty">{zh ? '还没有 ChangeSet。' : 'No ChangeSets yet.'}</div> : (
          <div className="changeset-list">
            {changeSets.slice(0, 8).map((item) => (
              <article className={`changeset-item status-${item.status}`} key={item.id}>
                <div className="changeset-item-copy">
                  <strong>{item.title}</strong>
                  <small>{item.id} · {changeSetSourceLabels[item.source][zh ? 0 : 1]} · {item.operations.length} {zh ? '项' : 'ops'}</small>
                  <div className="changeset-operation-preview">
                    {item.operations.slice(0, 5).map((operation) => <span key={operation.id}>{operation.summary}</span>)}
                    {item.operations.length > 5 ? <span>+{item.operations.length - 5}</span> : null}
                  </div>
                </div>
                <div className="changeset-item-state">
                  <span>{changeSetStatusLabels[item.status][zh ? 0 : 1]}</span>
                  {item.status === 'pending' ? (
                    <div className="changeset-item-actions">
                      <button disabled={busyChangeSetId === item.id} onClick={() => { void resolveChangeSet(item.id, 'discard') }}>{zh ? '放弃' : 'Discard'}</button>
                      <button className="apply" disabled={busyChangeSetId === item.id} onClick={() => { void resolveChangeSet(item.id, 'apply') }}>{busyChangeSetId === item.id ? '…' : (zh ? '应用' : 'Apply')}</button>
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </details>

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
                        {item.changeSetId ? <span>{item.changeSetId}</span> : null}
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

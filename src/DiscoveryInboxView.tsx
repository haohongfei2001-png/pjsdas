import { useEffect, useMemo, useState } from 'react'
import { DISCOVERY_REJECTION_REASON_OPTIONS } from './discoveryFeedback.js'
import {
  getAllDiscoveryInboxItems,
  promoteDiscoveryInboxItem,
  updateDiscoveryInboxStatus,
} from './discoveryInboxStore.js'
import { useCloud } from './cloud/CloudContext.js'
import { useUiLanguage } from './uiLanguage.js'
import type { DiscoveryInboxItem, DiscoveryInboxStatus, DiscoveryRejectionReason } from './model.js'
import './discoveryInbox.css'

const statusOrder: DiscoveryInboxStatus[] = ['new', 'later', 'seen', 'dismissed', 'promoted']

function statusLabel(status: DiscoveryInboxStatus, zh: boolean) {
  const labels: Record<DiscoveryInboxStatus, [string, string]> = {
    new: ['新发现', 'New'],
    seen: ['已看', 'Seen'],
    later: ['稍后再看', 'Later'],
    dismissed: ['不感兴趣', 'Dismissed'],
    promoted: ['已加入机会池', 'Promoted'],
  }
  return labels[status][zh ? 0 : 1]
}

export default function DiscoveryInboxView() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const cloud = useCloud()
  const [items, setItems] = useState<DiscoveryInboxItem[]>([])
  const [filter, setFilter] = useState<DiscoveryInboxStatus | 'all'>('all')
  const [busyId, setBusyId] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [reasons, setReasons] = useState<Record<string, DiscoveryRejectionReason>>({})

  async function reload() {
    const next = await getAllDiscoveryInboxItems()
    setItems(next)
    setReasons((current) => Object.fromEntries(next.map((item) => [item.id, current[item.id] ?? item.rejectionReason ?? 'not_interested'])))
  }

  useEffect(() => { void reload() }, [])

  const counts = useMemo(() => {
    const result: Record<DiscoveryInboxStatus, number> = { new: 0, seen: 0, later: 0, dismissed: 0, promoted: 0 }
    for (const item of items) result[item.status] += 1
    return result
  }, [items])

  const visible = filter === 'all' ? items : items.filter((item) => item.status === filter)

  async function syncAfterMutation(success: string) {
    await reload()
    window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
    if (cloud.session && !cloud.checkpoint.conflict) {
      try {
        await cloud.syncNow()
        setMessage(`${success}${zh ? '，并已请求同步到 Google Drive。' : '; Google Drive sync requested.'}`)
      } catch {
        setMessage(`${success}${zh ? '；Google Drive 暂未同步。' : '; Google Drive sync did not complete.'}`)
      }
    } else setMessage(success)
  }

  async function mutate(item: DiscoveryInboxItem, status: DiscoveryInboxStatus) {
    setBusyId(item.id)
    setError('')
    setMessage('')
    try {
      await updateDiscoveryInboxStatus(item.id, status, status === 'dismissed' ? reasons[item.id] : undefined)
      await syncAfterMutation(zh ? '发现箱状态已更新' : 'Discovery Inbox updated')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally { setBusyId('') }
  }

  async function promote(item: DiscoveryInboxItem) {
    setBusyId(item.id)
    setError('')
    setMessage('')
    try {
      await promoteDiscoveryInboxItem(item.id)
      await syncAfterMutation(zh ? '岗位已加入 Opportunities' : 'Job added to Opportunities')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally { setBusyId('') }
  }

  return (
    <section className="discovery-inbox-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">AI JOB DISCOVERY · V1.4</div>
          <h1>{zh ? '发现箱' : 'Discovery Inbox'}</h1>
          <p>{zh ? '把“值得以后处理”与“已经进入机会池”分开。发现箱不会自动投递，也不会自动把候选变成 Opportunity。' : 'Keep candidates worth revisiting separate from Opportunities. Inbox items never auto-apply or auto-promote.'}</p>
        </div>
      </header>

      <div className="discovery-inbox-metrics">
        {statusOrder.map((status) => <button key={status} className={filter === status ? 'active' : ''} onClick={() => setFilter(status)}><span>{statusLabel(status, zh)}</span><strong>{counts[status]}</strong></button>)}
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}><span>{zh ? '全部' : 'All'}</span><strong>{items.length}</strong></button>
      </div>

      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice success">{message}</div> : null}

      {!visible.length ? <div className="empty-card"><strong>{zh ? '当前没有这一类候选' : 'No candidates in this view'}</strong><p>{zh ? '从 ChatGPT 岗位发现审阅页选择“保存到发现箱”后，候选会出现在这里。' : 'Use Save to Inbox from a ChatGPT discovery review to stage candidates here.'}</p></div> : null}

      <div className="discovery-inbox-list">
        {visible.map((item) => (
          <article key={item.id} className={`discovery-inbox-item status-${item.status}`}>
            <div className="discovery-inbox-title">
              <div><strong>{item.company}</strong><h3>{item.role}</h3></div>
              <span>{statusLabel(item.status, zh)}</span>
            </div>
            <div className="discovery-inbox-facts">
              <span>{zh ? '地点' : 'Location'}：{item.location ?? (zh ? '来源未明确' : 'Not stated')}</span>
              <span>{zh ? '薪资' : 'Compensation'}：{item.compensationText ?? (zh ? '来源未明确' : 'Not stated')}</span>
              <span>{zh ? '匹配度' : 'Fit'}：{item.fitScore}</span>
              <span>{zh ? '机会价值' : 'Opportunity'}：{item.opportunityValue}</span>
            </div>
            <p>{item.rationale}</p>
            {item.profileWarnings?.length ? <div className="discovery-inbox-warnings">{item.profileWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
            <a href={item.sourceUrl} target="_blank" rel="noreferrer">{zh ? '查看招聘来源' : 'Open source'} · {item.sourceTitle}</a>

            {item.status !== 'promoted' ? (
              <div className="discovery-inbox-actions">
                {item.status !== 'seen' && item.status !== 'dismissed' ? <button disabled={busyId === item.id} onClick={() => { void mutate(item, 'seen') }}>{zh ? '已看' : 'Seen'}</button> : null}
                {item.status !== 'later' && item.status !== 'dismissed' ? <button disabled={busyId === item.id} onClick={() => { void mutate(item, 'later') }}>{zh ? '稍后再看' : 'Later'}</button> : null}
                {(item.status === 'later' || item.status === 'seen' || item.status === 'dismissed') ? <button disabled={busyId === item.id} onClick={() => { void mutate(item, 'new') }}>{zh ? '重新考虑' : 'Reconsider'}</button> : null}
                {item.status !== 'dismissed' ? (
                  <label className="discovery-inbox-dismiss">
                    <select value={reasons[item.id] ?? 'not_interested'} onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value as DiscoveryRejectionReason }))}>
                      {DISCOVERY_REJECTION_REASON_OPTIONS.map((option) => <option key={option.value} value={option.value}>{zh ? option.zh : option.en}</option>)}
                    </select>
                    <button disabled={busyId === item.id} onClick={() => { void mutate(item, 'dismissed') }}>{zh ? '不感兴趣' : 'Dismiss'}</button>
                  </label>
                ) : null}
                <button className="primary" disabled={busyId === item.id} onClick={() => { void promote(item) }}>{zh ? '加入 Opportunities' : 'Add to Opportunities'}</button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { DISCOVERY_REJECTION_REASON_OPTIONS } from './discoveryFeedback.js'
import {
  discoveryDecisionSummary,
  sortDiscoveryInboxItems,
  type DiscoveryInboxSort,
} from './discoveryDecision.js'
import {
  bulkUpdateDiscoveryInboxStatus,
  getAllDiscoveryInboxItems,
  promoteDiscoveryInboxItem,
  updateDiscoveryInboxStatus,
} from './discoveryInboxStore.js'
import { useCloud } from './cloud/CloudContext.js'
import OpportunityAssessmentSummary from './OpportunityAssessmentSummary.js'
import RichOpportunityFactsSummary from './RichOpportunityFactsSummary.js'
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

function confidenceLabel(value: DiscoveryInboxItem['fitConfidence'], zh: boolean) {
  const labels = {
    high: zh ? '高' : 'High',
    medium: zh ? '中' : 'Medium',
    low: zh ? '低' : 'Low',
  }
  return labels[value]
}

function sortLabel(sort: DiscoveryInboxSort, zh: boolean) {
  const labels: Record<DiscoveryInboxSort, [string, string]> = {
    review_priority: ['建议先看', 'Review priority'],
    newest: ['最新发现', 'Newest'],
    fit: ['匹配度', 'Fit'],
    opportunity: ['机会价值', 'Opportunity value'],
    completeness: ['信息完整度', 'Information completeness'],
    deadline: ['截止时间', 'Deadline'],
  }
  return labels[sort][zh ? 0 : 1]
}

export default function DiscoveryInboxView() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const cloud = useCloud()
  const [items, setItems] = useState<DiscoveryInboxItem[]>([])
  const [filter, setFilter] = useState<DiscoveryInboxStatus | 'all'>('all')
  const [sort, setSort] = useState<DiscoveryInboxSort>('review_priority')
  const [busyId, setBusyId] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [reasons, setReasons] = useState<Record<string, DiscoveryRejectionReason>>({})
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkReason, setBulkReason] = useState<DiscoveryRejectionReason>('not_interested')
  const [compareOpen, setCompareOpen] = useState(false)
  const [promotePreview, setPromotePreview] = useState<DiscoveryInboxItem | null>(null)

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

  const visible = useMemo(() => {
    const filtered = filter === 'all' ? items : items.filter((item) => item.status === filter)
    return sortDiscoveryInboxItems(filtered, sort)
  }, [filter, items, sort])

  const selectedItems = useMemo(
    () => selectedIds.map((id) => items.find((item) => item.id === id)).filter((item): item is DiscoveryInboxItem => Boolean(item)),
    [items, selectedIds],
  )
  const selectedMutable = selectedItems.filter((item) => item.status !== 'promoted')

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

  async function bulkMutate(status: 'later' | 'dismissed') {
    if (!selectedMutable.length) return
    setBusyId('__bulk__')
    setError('')
    setMessage('')
    try {
      await bulkUpdateDiscoveryInboxStatus(
        selectedMutable.map((item) => item.id),
        status,
        status === 'dismissed' ? bulkReason : undefined,
      )
      setSelectedIds([])
      setCompareOpen(false)
      await syncAfterMutation(
        zh ? `已批量更新 ${selectedMutable.length} 个候选` : `Updated ${selectedMutable.length} candidates`,
      )
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
      setPromotePreview(null)
      setSelectedIds((current) => current.filter((id) => id !== item.id))
      await syncAfterMutation(zh ? '岗位已加入 Opportunities' : 'Job added to Opportunities')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally { setBusyId('') }
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])
    setCompareOpen(false)
  }

  function selectVisible() {
    const ids = visible.map((item) => item.id)
    const allSelected = ids.length > 0 && ids.every((id) => selectedIds.includes(id))
    setSelectedIds((current) => allSelected ? current.filter((id) => !ids.includes(id)) : Array.from(new Set([...current, ...ids])))
    setCompareOpen(false)
  }

  return (
    <section className="discovery-inbox-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">AI JOB DISCOVERY · V1.5</div>
          <h1>{zh ? '发现箱' : 'Discovery Inbox'}</h1>
          <p>{zh ? '先判断，再进入正式机会池。招聘事实与 AI 分项评估保持分层，未知事实不会被补造。' : 'Decide before promoting. Source-backed job facts stay separate from component assessment, and unknown facts remain unknown.'}</p>
        </div>
      </header>

      <div className="discovery-inbox-metrics">
        {statusOrder.map((status) => <button key={status} className={filter === status ? 'active' : ''} onClick={() => setFilter(status)}><span>{statusLabel(status, zh)}</span><strong>{counts[status]}</strong></button>)}
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}><span>{zh ? '全部' : 'All'}</span><strong>{items.length}</strong></button>
      </div>

      <div className="discovery-inbox-controls">
        <label>
          <span>{zh ? '排序' : 'Sort'}</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as DiscoveryInboxSort)}>
            {(['review_priority', 'newest', 'fit', 'opportunity', 'completeness', 'deadline'] as DiscoveryInboxSort[]).map((value) => (
              <option key={value} value={value}>{sortLabel(value, zh)}</option>
            ))}
          </select>
        </label>
        <button onClick={selectVisible}>{zh ? '选择当前列表' : 'Select visible'}</button>
        <span className="discovery-inbox-sort-note">{zh ? '“建议先看”仅按候选状态、现有匹配度/机会价值与基础信息完整度排序，不改变正式 PJSDAS 优先级。' : 'Review priority uses inbox status, existing fit/opportunity scores, and basic information completeness only. It does not change formal PJSDAS priority.'}</span>
      </div>

      {selectedIds.length ? (
        <div className="discovery-inbox-bulkbar">
          <strong>{zh ? `已选择 ${selectedIds.length} 个` : `${selectedIds.length} selected`}</strong>
          <button disabled={!selectedMutable.length || busyId === '__bulk__'} onClick={() => { void bulkMutate('later') }}>{zh ? '批量稍后再看' : 'Move to Later'}</button>
          <label>
            <select value={bulkReason} onChange={(event) => setBulkReason(event.target.value as DiscoveryRejectionReason)}>
              {DISCOVERY_REJECTION_REASON_OPTIONS.map((option) => <option key={option.value} value={option.value}>{zh ? option.zh : option.en}</option>)}
            </select>
            <button disabled={!selectedMutable.length || busyId === '__bulk__'} onClick={() => { void bulkMutate('dismissed') }}>{zh ? '批量不感兴趣' : 'Dismiss selected'}</button>
          </label>
          <button disabled={selectedItems.length < 2 || selectedItems.length > 3} onClick={() => setCompareOpen((value) => !value)}>{zh ? '比较 2–3 个岗位' : 'Compare 2–3 jobs'}</button>
          <button onClick={() => { setSelectedIds([]); setCompareOpen(false) }}>{zh ? '清除选择' : 'Clear'}</button>
        </div>
      ) : null}

      {compareOpen && selectedItems.length >= 2 && selectedItems.length <= 3 ? (
        <section className="discovery-inbox-compare" aria-label={zh ? '候选岗位比较' : 'Candidate comparison'}>
          <div className="discovery-inbox-compare-head">
            <div><div className="eyebrow">COMPARE</div><h2>{zh ? '候选岗位比较' : 'Candidate comparison'}</h2></div>
            <button onClick={() => setCompareOpen(false)}>{zh ? '关闭' : 'Close'}</button>
          </div>
          <div className="discovery-inbox-compare-grid">
            {selectedItems.map((item) => {
              const summary = discoveryDecisionSummary(item)
              return (
                <article key={item.id}>
                  <strong>{item.company}</strong>
                  <h3>{item.role}</h3>
                  <dl>
                    <div><dt>{zh ? '匹配度' : 'Fit'}</dt><dd>{item.fitScore} · {confidenceLabel(item.fitConfidence, zh)}</dd></div>
                    <div><dt>{zh ? '机会价值' : 'Opportunity'}</dt><dd>{item.opportunityValue} · {confidenceLabel(item.opportunityValueConfidence, zh)}</dd></div>
                    <div><dt>{zh ? '审阅参考' : 'Review reference'}</dt><dd>{summary.reviewScore}</dd></div>
                    <div><dt>{zh ? '基础信息完整度' : 'Basic info completeness'}</dt><dd>{summary.knownFacts}/{summary.totalFacts}</dd></div>
                    <div><dt>{zh ? '地点' : 'Location'}</dt><dd>{item.location ?? (zh ? '未知' : 'Unknown')}</dd></div>
                    <div><dt>{zh ? '截止' : 'Deadline'}</dt><dd>{item.deadline ?? (zh ? '未知' : 'Unknown')}</dd></div>
                    <div><dt>{zh ? '薪资' : 'Compensation'}</dt><dd>{item.compensationText ?? (zh ? '未知' : 'Unknown')}</dd></div>
                  </dl>
                  {summary.risks.length || summary.missing.length ? <div className="comparison-flags">{[...summary.risks, ...summary.missing].map((entry) => <span key={entry.key}>{zh ? entry.zh : entry.en}</span>)}</div> : null}
                  <RichOpportunityFactsSummary facts={item.facts} zh={zh} />
                  <OpportunityAssessmentSummary
                    assessment={item.assessment}
                    fitScore={item.fitScore}
                    opportunityValue={item.opportunityValue}
                    fitConfidence={item.fitConfidence}
                    opportunityValueConfidence={item.opportunityValueConfidence}
                    zh={zh}
                  />
                  <a href={item.sourceUrl} target="_blank" rel="noreferrer">{zh ? '查看来源' : 'Open source'}</a>
                </article>
              )
            })}
          </div>
        </section>
      ) : null}

      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice success">{message}</div> : null}

      {!visible.length ? <div className="empty-card"><strong>{zh ? '当前没有这一类候选' : 'No candidates in this view'}</strong><p>{zh ? '从 ChatGPT 岗位发现审阅页选择“保存到发现箱”后，候选会出现在这里。' : 'Use Save to Inbox from a ChatGPT discovery review to stage candidates here.'}</p></div> : null}

      <div className="discovery-inbox-list">
        {visible.map((item) => {
          const summary = discoveryDecisionSummary(item)
          return (
            <article key={item.id} className={`discovery-inbox-item status-${item.status}`}>
              <div className="discovery-inbox-title">
                <div className="discovery-inbox-title-main">
                  <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelected(item.id)} aria-label={`${item.company} ${item.role}`} />
                  <div><strong>{item.company}</strong><h3>{item.role}</h3></div>
                </div>
                <span>{statusLabel(item.status, zh)}</span>
              </div>

              <div className="discovery-inbox-decision-grid">
                <div title={zh ? '（匹配度 + 机会价值）/ 2，仅用于发现箱审阅排序。' : '(Fit + opportunity value) / 2, used only for inbox review ordering.'}><span>{zh ? '审阅参考' : 'Review reference'}</span><strong>{summary.reviewScore}</strong></div>
                <div><span>{zh ? '基础信息完整度' : 'Basic info completeness'}</span><strong>{summary.knownFacts}/{summary.totalFacts}</strong><small>{summary.completenessPercent}%</small></div>
                <div><span>{zh ? '匹配度置信度' : 'Fit confidence'}</span><strong>{confidenceLabel(item.fitConfidence, zh)}</strong></div>
                <div><span>{zh ? '机会价值置信度' : 'Opportunity confidence'}</span><strong>{confidenceLabel(item.opportunityValueConfidence, zh)}</strong></div>
              </div>

              <div className="discovery-inbox-facts">
                <span>{zh ? '地点' : 'Location'}：{item.location ?? (zh ? '来源未明确' : 'Not stated')}</span>
                <span>{zh ? '截止' : 'Deadline'}：{item.deadline ?? (zh ? '来源未明确' : 'Not stated')}</span>
                <span>{zh ? '薪资' : 'Compensation'}：{item.compensationText ?? (zh ? '来源未明确' : 'Not stated')}</span>
                <span>{zh ? '匹配度' : 'Fit'}：{item.fitScore}</span>
                <span>{zh ? '机会价值' : 'Opportunity'}：{item.opportunityValue}</span>
              </div>

              <p>{item.rationale}</p>
              <RichOpportunityFactsSummary facts={item.facts} zh={zh} />
              <OpportunityAssessmentSummary
                assessment={item.assessment}
                fitScore={item.fitScore}
                opportunityValue={item.opportunityValue}
                fitConfidence={item.fitConfidence}
                opportunityValueConfidence={item.opportunityValueConfidence}
                zh={zh}
              />

              {(summary.strengths.length || summary.risks.length || summary.missing.length) ? (
                <div className="discovery-inbox-signals">
                  {summary.strengths.length ? <div><strong>{zh ? '值得关注' : 'Why it stands out'}</strong>{summary.strengths.map((entry) => <span className="positive" key={entry.key}>{zh ? entry.zh : entry.en}</span>)}</div> : null}
                  {summary.risks.length ? <div><strong>{zh ? '需要留意' : 'Risks'}</strong>{summary.risks.map((entry) => <span className="risk" key={entry.key}>{zh ? entry.zh : entry.en}</span>)}</div> : null}
                  {summary.missing.length ? <div><strong>{zh ? '缺失信息' : 'Missing facts'}</strong>{summary.missing.map((entry) => <span className="missing" key={entry.key}>{zh ? entry.zh : entry.en}</span>)}</div> : null}
                </div>
              ) : null}

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
                  <button className="primary" disabled={busyId === item.id} onClick={() => setPromotePreview(item)}>{zh ? '加入 Opportunities' : 'Add to Opportunities'}</button>
                </div>
              ) : null}
            </article>
          )
        })}
      </div>

      {promotePreview ? (
        <div className="discovery-inbox-modal-backdrop" onMouseDown={() => setPromotePreview(null)}>
          <section className="discovery-inbox-modal" role="dialog" aria-modal="true" aria-label={zh ? '加入机会池预览' : 'Promotion preview'} onMouseDown={(event) => event.stopPropagation()}>
            <div className="eyebrow">PROMOTE PREVIEW · COMPONENT ASSESSMENT</div>
            <h2>{zh ? '确认进入正式机会池' : 'Confirm promotion to Opportunities'}</h2>
            <p><strong>{promotePreview.company}</strong> · {promotePreview.role}</p>
            <div className="discovery-inbox-preview-grid">
              <span>{zh ? '岗位类型' : 'Role type'}<strong>{promotePreview.roleType}</strong></span>
              <span>{zh ? '匹配度' : 'Fit'}<strong>{promotePreview.fitScore}</strong></span>
              <span>{zh ? '机会价值' : 'Opportunity'}<strong>{promotePreview.opportunityValue}</strong></span>
              <span>{zh ? '地点' : 'Location'}<strong>{promotePreview.location ?? (zh ? '未知' : 'Unknown')}</strong></span>
              <span>{zh ? '截止' : 'Deadline'}<strong>{promotePreview.deadline ?? (zh ? '未知' : 'Unknown')}</strong></span>
              <span>{zh ? '薪资' : 'Compensation'}<strong>{promotePreview.compensationText ?? (zh ? '未知' : 'Unknown')}</strong></span>
            </div>
            <RichOpportunityFactsSummary facts={promotePreview.facts} zh={zh} />
            <OpportunityAssessmentSummary
              assessment={promotePreview.assessment}
              fitScore={promotePreview.fitScore}
              opportunityValue={promotePreview.opportunityValue}
              fitConfidence={promotePreview.fitConfidence}
              opportunityValueConfidence={promotePreview.opportunityValueConfidence}
              zh={zh}
            />
            <p className="discovery-inbox-preview-note">{zh ? '确认后，该候选会通过现有 ChangeSet 路径进入 Opportunities。招聘事实、来源证据、分项评估、聚合分数与警告会继续保留；这一步不会自动提交申请。' : 'After confirmation, this candidate enters Opportunities through the existing ChangeSet path. Source-backed facts, evidence, component assessment, aggregate scores, and warnings remain attached. This does not submit an application.'}</p>
            {promotePreview.profileWarnings?.length ? <div className="discovery-inbox-warnings">{promotePreview.profileWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
            <a href={promotePreview.sourceUrl} target="_blank" rel="noreferrer">{zh ? '再次查看招聘来源' : 'Open source again'}</a>
            <div className="discovery-inbox-modal-actions">
              <button onClick={() => setPromotePreview(null)}>{zh ? '取消' : 'Cancel'}</button>
              <button className="primary" disabled={busyId === promotePreview.id} onClick={() => { void promote(promotePreview) }}>{zh ? '确认加入 Opportunities' : 'Confirm promotion'}</button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}

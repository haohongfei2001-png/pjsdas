import { useMemo } from 'react'
import { presentRankingReasons } from './rankingReasonPresentation.js'
import { presentStageLabel } from './stagePresentation.js'
import { useUiLanguage } from './uiLanguage.js'
import type {
  OpportunityDecisionListRead,
  OpportunityDecisionRead,
  OpportunityDecisionReasonCode,
} from './opportunityDecisionRead.js'
import './opportunityDecision.css'

export type OpportunityListView = 'in_progress' | 'worth_pursuing' | 'all' | 'ended'

const reasonLabels: Record<OpportunityDecisionReasonCode, [string, string]> = {
  active_recruiting_process: ['招聘流程正在推进', 'Recruiting process is active'],
  offer_received: ['已收到 Offer', 'Offer received'],
  core_opportunity: ['核心机会', 'Core opportunity'],
  early_window: ['早期窗口有时机优势', 'Early-window timing advantage'],
  waiting_release: ['岗位尚未开放', 'Role has not opened yet'],
  deadline_near: ['申请截止临近', 'Application deadline is near'],
  shared_application_constraint: ['受共享投递名额约束', 'Shared application quota applies'],
  source_needs_refresh: ['公开来源需要复核', 'Public source needs refresh'],
  source_closed: ['公开招聘来源已关闭', 'Public posting is closed'],
  assessment_missing: ['评估信息仍不完整', 'Assessment is incomplete'],
  elapsed_node_unresolved: ['有已过时间节点待确认', 'A past schedule node needs resolution'],
  user_not_pursuing: ['你已标记为不再推进', 'You marked this as no longer pursued'],
  process_closed: ['招聘流程已结束', 'Recruiting process has ended'],
}

const conclusionLabels: Record<OpportunityDecisionRead['conclusion'], [string, string]> = {
  continue_process: ['继续推进当前流程', 'Keep advancing the current process'],
  review_offer: ['已到 Offer 阶段，处理下一决定', 'Offer received; handle the next decision'],
  worth_pursuing: ['值得继续考虑', 'Worth pursuing'],
  wait_for_opening: ['等待开放，同时保留关注', 'Wait for opening and keep it on radar'],
  application_window_closed: ['申请窗口已结束', 'Application window has closed'],
  not_pursuing: ['当前不再推进', 'Not pursuing'],
  process_ended: ['流程已结束', 'Process ended'],
}

function nodeLabel(item: OpportunityDecisionRead, zh: boolean) {
  const node = item.nearestNode
  if (!node) return undefined
  const kind: Record<typeof node.kind, [string, string]> = {
    interview: ['面试', 'Interview'],
    written_test: ['笔试', 'Written test'],
    assessment: ['测评', 'Assessment'],
    application_deadline: ['申请截止', 'Application deadline'],
    follow_up: ['复核', 'Follow-up'],
    prep_trigger: ['准备节点', 'Prep trigger'],
  }
  const temporal = node.temporal
  let time = temporal.date
  if (!time && temporal.startAt) time = new Date(temporal.startAt).toLocaleString(zh ? 'zh-CN' : 'en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  if (!time && temporal.deadlineAt) time = new Date(temporal.deadlineAt).toLocaleString(zh ? 'zh-CN' : 'en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  return `${kind[node.kind][zh ? 0 : 1]}${time ? ' · ' + time : ''}${node.requiresResolution ? (zh ? ' · 待确认' : ' · Resolve') : ''}`
}

function reasons(item: OpportunityDecisionRead, zh: boolean) {
  const ranking = item.nextAction?.rankingReasons?.length
    ? presentRankingReasons(item.nextAction.rankingReasons, zh)
    : []
  const semantic = item.reasons.map((reason) => reasonLabels[reason.code][zh ? 0 : 1])
  return [...new Set([...ranking, ...semantic])].slice(0, 2)
}

export default function OpportunityDecisionList({
  read,
  onOpenOpportunity,
  view,
  onViewChange,
  query,
  onQueryChange,
}: {
  read: OpportunityDecisionListRead
  onOpenOpportunity: (id: string) => void
  view: OpportunityListView
  onViewChange: (view: OpportunityListView) => void
  query: string
  onQueryChange: (query: string) => void
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'

  const source = view === 'in_progress'
    ? read.inProgress
    : view === 'worth_pursuing'
      ? read.worthPursuing
      : view === 'ended'
        ? read.all.filter((item) => item.bucket === 'ended')
        : read.all

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return source.filter((item) => !needle || `${item.company} ${item.role}`.toLocaleLowerCase().includes(needle))
  }, [source, query])

  return (
    <section className="opportunity-decision-list">
      <div className="opportunity-decision-toolbar">
        <div className="opportunity-decision-primary-tabs" role="group" aria-label={zh ? '机会视图' : 'Opportunity views'}>
          <button className={view === 'in_progress' ? 'active' : ''} aria-pressed={view === 'in_progress'} type="button" onClick={() => onViewChange('in_progress')}>
            <span>{zh ? '推进中' : 'In Progress'}</span>
            <strong>{read.inProgress.length}</strong>
          </button>
          <button className={view === 'worth_pursuing' ? 'active' : ''} aria-pressed={view === 'worth_pursuing'} type="button" onClick={() => onViewChange('worth_pursuing')}>
            <span>{zh ? '值得推进' : 'Worth Pursuing'}</span>
            <strong>{read.worthPursuing.length}</strong>
          </button>
        </div>
        <div className="opportunity-decision-filter">
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} aria-label={zh ? '搜索公司或岗位' : 'Search company or role'} placeholder={zh ? '搜索公司或岗位' : 'Search company or role'} />
          <select value={view} onChange={(event) => onViewChange(event.target.value as OpportunityListView)} aria-label={zh ? '筛选机会状态' : 'Filter opportunity state'}>
            <option value="in_progress">{zh ? '推进中' : 'In Progress'}</option>
            <option value="worth_pursuing">{zh ? '值得推进' : 'Worth Pursuing'}</option>
            <option value="ended">{zh ? '已结束 / 不再推进' : 'Ended / not pursuing'}</option>
            <option value="all">{zh ? '全部机会' : 'All opportunities'}</option>
          </select>
        </div>
      </div>

      {filtered.length ? (
        <div className="opportunity-decision-rows">
          {filtered.map((item) => {
            const itemReasons = reasons(item, zh)
            const nearest = nodeLabel(item, zh)
            return (
              <button className="opportunity-decision-row" type="button" key={item.opportunityId}
                data-opportunity-id={item.opportunityId} onClick={() => onOpenOpportunity(item.opportunityId)}>
                <div className="opportunity-decision-identity">
                  <strong>{item.company}</strong>
                  <span>{item.role}</span>
                </div>
                <div className="opportunity-decision-state">
                  <strong>{presentStageLabel(item.process.stage, undefined, lang)}</strong>
                  <span>{conclusionLabels[item.conclusion][zh ? 0 : 1]}</span>
                </div>
                <div className="opportunity-decision-next">
                  <small>{zh ? '下一步' : 'Next move'}</small>
                  <strong>{item.nextAction?.title ?? conclusionLabels[item.conclusion][zh ? 0 : 1]}</strong>
                  {nearest ? <span>{nearest}</span> : null}
                </div>
                <div className="opportunity-decision-reasons">
                  {itemReasons.map((reason) => <span key={reason}>{reason}</span>)}
                </div>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="opportunity-decision-empty">
          <strong>{query ? (zh ? '没有匹配结果' : 'No matching opportunities') : (zh ? '这里暂时没有机会' : 'Nothing in this view right now')}</strong>
          <span>{zh ? 'PJSDAS 只在这个视图里放与你当前决策有关的机会。' : 'PJSDAS keeps this view limited to opportunities relevant to the current decision.'}</span>
        </div>
      )}
    </section>
  )
}

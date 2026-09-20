import { presentRankingReasons } from './rankingReasonPresentation.js'
import { presentStageLabel } from './stagePresentation.js'
import { useUiLanguage } from './uiLanguage.js'
import type { ProcessRecord } from './model.js'
import type { OpportunityDecisionRead, OpportunityDecisionReasonCode } from './opportunityDecisionRead.js'
import type { OpportunityDetailDestination } from './OpportunityDetailDrawer.js'

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

const nodeLabels: Record<NonNullable<OpportunityDecisionRead['nearestNode']>['kind'], [string, string]> = {
  interview: ['面试', 'Interview'],
  written_test: ['笔试', 'Written test'],
  assessment: ['测评', 'Assessment'],
  application_deadline: ['申请截止', 'Application deadline'],
  follow_up: ['复核', 'Follow-up'],
  prep_trigger: ['准备节点', 'Prep trigger'],
}

const progressLabels: Record<NonNullable<ProcessRecord['progress']>, [string, string]> = {
  not_started: ['尚未开始', 'Not started'],
  action_required: ['需要行动', 'Action required'],
  scheduled: ['已安排', 'Scheduled'],
  in_progress: ['进行中', 'In progress'],
  completed: ['已完成当前阶段', 'Stage completed'],
  waiting_result: ['等待结果', 'Waiting for result'],
}

const resultLabels: Record<NonNullable<ProcessRecord['result']>, [string, string]> = {
  pending: ['结果未定', 'Pending'],
  advanced: ['已推进', 'Advanced'],
  rejected: ['未通过', 'Rejected'],
  offer: ['Offer', 'Offer'],
  closed_other: ['已结束', 'Closed'],
}

export default function OpportunityDecisionSummary({
  decision,
  process,
  onNavigate,
}: {
  decision: OpportunityDecisionRead
  process?: ProcessRecord
  onNavigate: (destination: OpportunityDetailDestination) => void
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const ranking = decision.nextAction?.rankingReasons?.length
    ? presentRankingReasons(decision.nextAction.rankingReasons, zh)
    : []
  const reasons = [
    ...ranking.map((text) => ({ text, tone: 'reason' as const })),
    ...decision.reasons.map((item) => ({ text: reasonLabels[item.code][zh ? 0 : 1], tone: item.tone })),
  ].filter((item, index, items) => items.findIndex((candidate) => candidate.text === item.text) === index).slice(0, 4)

  const primary = decision.nextAction
  const node = decision.nearestNode
  const nodeTime = node?.temporal.date
    ?? node?.temporal.startAt
    ?? node?.temporal.deadlineAt
    ?? node?.temporal.endAt
  const nodeTimeLabel = node?.temporal.precision === 'date' && node.temporal.date
    ? node.temporal.date
    : nodeTime
      ? new Date(nodeTime).toLocaleString(zh ? 'zh-CN' : 'en-GB')
      : undefined

  return (
    <>
      <section className="opportunity-detail-conclusion">
        <div className="eyebrow">{zh ? '结论' : 'CONCLUSION'}</div>
        <h3>{conclusionLabels[decision.conclusion][zh ? 0 : 1]}</h3>
        <div className="opportunity-detail-decision-reasons">
          {reasons.map((item) => (
            <div className={`opportunity-detail-decision-reason ${item.tone === 'risk' ? 'risk' : ''}`} key={item.text}>{item.text}</div>
          ))}
        </div>
      </section>

      <section className="opportunity-detail-process-summary">
        <div><small>{zh ? '阶段' : 'Stage'}</small><strong>{presentStageLabel(decision.process.stage, undefined, lang)}</strong></div>
        <div><small>{zh ? '阶段进度' : 'Progress'}</small><strong>{process?.progress ? progressLabels[process.progress][zh ? 0 : 1] : (zh ? '未明确' : 'Not stated')}</strong></div>
        <div><small>{zh ? '流程结果' : 'Result'}</small><strong>{process?.result ? resultLabels[process.result][zh ? 0 : 1] : (zh ? '结果未定' : 'Pending')}</strong></div>
      </section>

      {primary ? (
        <section className="opportunity-detail-primary-operation">
          <div>
            <small>{zh ? '下一操作' : 'NEXT OPERATION'}</small>
            <strong>{primary.title}</strong>
            <span>{primary.estimatedMinutes} {zh ? '分钟' : 'min'}{primary.dueAt ? ` · ${new Date(primary.dueAt).toLocaleString(zh ? 'zh-CN' : 'en-GB')}` : ''}</span>
          </div>
          {primary.operation === 'open_application' && primary.externalUrl
            ? <a href={primary.externalUrl} target="_blank" rel="noreferrer">{zh ? '打开申请' : 'Open application'}</a>
            : primary.operation === 'start_prep'
              ? <button type="button" onClick={() => onNavigate('prepare')}>{zh ? '开始准备' : 'Start prep'}</button>
              : primary.operation === 'compare_group'
                ? <button type="button" onClick={() => onNavigate('opportunities')}>{zh ? '比较机会' : 'Compare opportunities'}</button>
                : <button type="button" onClick={() => onNavigate('today')}>{zh ? '在 Today 处理' : 'Handle in Today'}</button>}
        </section>
      ) : null}

      {node ? (
        <section className="opportunity-detail-nearest-node">
          <span>{zh ? '最近节点' : 'NEAREST NODE'}</span>
          <div>
            <strong>{nodeLabels[node.kind][zh ? 0 : 1]}{node.requiresResolution ? (zh ? ' · 待确认' : ' · Resolve') : ''}</strong>
            <small>{nodeTimeLabel ?? (zh ? '时间未明确' : 'Time not stated')}</small>
          </div>
        </section>
      ) : null}
    </>
  )
}

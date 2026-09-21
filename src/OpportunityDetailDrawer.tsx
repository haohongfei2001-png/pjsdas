import { useEffect } from 'react'
import { jobPostingFreshness } from './jobPosting.js'
import OpportunityAssessmentSummary from './OpportunityAssessmentSummary.js'
import OpportunityDecisionSummary from './OpportunityDecisionSummary.js'
import type { OpportunityDecisionRead } from './opportunityDecisionRead.js'
import RichOpportunityFactsSummary from './RichOpportunityFactsSummary.js'
import { presentStageLabel } from './stagePresentation.js'
import { useUiLanguage } from './uiLanguage.js'
import type {
  Action,
  ApplicationGroup,
  JobPostingEvidence,
  Opportunity,
  ProcessRecord,
  TimelineRecord,
} from './model.js'
import './opportunityDetail.css'

export type OpportunityDetailDestination = 'today' | 'opportunities' | 'prepare'

interface OpportunityDetailDrawerProps {
  opportunity: Opportunity
  decision?: OpportunityDecisionRead
  process?: ProcessRecord
  actions: Action[]
  applicationGroup?: ApplicationGroup
  timeline: TimelineRecord[]
  onClose: () => void
  onNavigate: (destination: OpportunityDetailDestination) => void
}

const actionStatusLabels: Record<Action['status'], [string, string]> = {
  todo: ['待办', 'To do'],
  doing: ['进行中', 'In progress'],
  done: ['已完成', 'Done'],
  skipped: ['已跳过', 'Skipped'],
}

function actionStatusLabel(status: Action['status'], zh: boolean) {
  return actionStatusLabels[status][zh ? 0 : 1]
}

function freshnessLabel(posting: JobPostingEvidence, zh: boolean) {
  const freshness = jobPostingFreshness(posting)
  const labels: Record<typeof freshness, [string, string]> = {
    fresh: ['近期核验', 'Fresh'],
    aging: ['需要关注', 'Aging'],
    stale: ['建议复核', 'Stale'],
    closed: ['来源已关闭', 'Source closed'],
    unknown: ['状态未知', 'Unknown'],
  }
  return { freshness, label: labels[freshness][zh ? 0 : 1] }
}

function formatDate(value: string | undefined, zh: boolean) {
  if (!value) return zh ? '未明确' : 'Not stated'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function SourceRow({ posting, zh }: { posting: JobPostingEvidence; zh: boolean }) {
  const freshness = freshnessLabel(posting, zh)
  return (
    <article className="opportunity-detail-source-row">
      <div>
        <strong>{posting.sourceHost}</strong>
        <a href={posting.sourceUrl} target="_blank" rel="noreferrer">{posting.sourceTitle}</a>
        <small>{zh ? '最近核验' : 'Last verified'} {formatDate(posting.lastVerifiedAt, zh)}</small>
      </div>
      <span className={`opportunity-detail-freshness ${freshness.freshness}`}>{freshness.label}</span>
    </article>
  )
}

export default function OpportunityDetailDrawer({
  opportunity,
  decision,
  process,
  actions,
  applicationGroup,
  timeline,
  onClose,
  onNavigate,
}: OpportunityDetailDrawerProps) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const discovery = opportunity.detail?.discovery
  const userFacts = opportunity.detail?.userFacts
  const posting = discovery?.posting
  const postingHistory = discovery?.postingHistory ?? []
  const relevantActions = actions
    .filter((item) => item.status !== 'done' && item.status !== 'skipped')
    .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'))
  const recentTimeline = [...timeline]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 6)
  const effectiveStage = process?.stage ?? opportunity.processStage
  const storedStageLabel = process?.stageLabel ?? opportunity.currentStageLabel
  const effectiveStageText = presentStageLabel(effectiveStage, storedStageLabel, lang)

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="opportunity-detail-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="opportunity-detail-drawer" role="dialog" aria-modal="true" aria-label={zh ? '岗位详情' : 'Opportunity details'} onMouseDown={(event) => event.stopPropagation()}>
        <header className="opportunity-detail-header">
          <div>
            <div className="eyebrow">OPPORTUNITY</div>
            <strong className="opportunity-detail-company">{opportunity.company}</strong>
            <h2>{opportunity.role}</h2>
            <div className="opportunity-detail-header-badges">
              <span>{effectiveStageText}</span>
              {opportunity.early ? <span>{zh ? '早期窗口' : 'Early window'}</span> : null}
            </div>
          </div>
          <button className="opportunity-detail-close" type="button" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}>×</button>
        </header>

        {decision ? <OpportunityDecisionSummary decision={decision} process={process} onNavigate={onNavigate} /> : null}

        <div className="opportunity-detail-progressive">
          <RichOpportunityFactsSummary facts={opportunity.detail?.facts} zh={zh} />

          {applicationGroup ? (
            <details className="opportunity-detail-section">
              <summary>{zh ? '申请约束' : 'Application constraints'}</summary>
              <div className="opportunity-detail-prose">
                <p>{applicationGroup.rule ?? (zh ? '该组没有额外规则说明。' : 'No additional rule is stored for this group.')}</p>
                {applicationGroup.remaining !== undefined ? <span>{zh ? '剩余名额' : 'Remaining capacity'}：{applicationGroup.remaining}</span> : null}
                {applicationGroup.currentOrder ? <span>{zh ? '当前顺序' : 'Current order'}：{applicationGroup.currentOrder}</span> : null}
              </div>
            </details>
          ) : null}

          <details className="opportunity-detail-section">
            <summary>{zh ? '准备与相关待办' : 'Preparation & related actions'}</summary>
            <div className="opportunity-detail-process-grid">
              <div><small>{zh ? '最近进展' : 'Last progress'}</small><strong>{formatDate(process?.lastProgressAt, zh)}</strong></div>
              <div><small>{zh ? '下次复核' : 'Next check'}</small><strong>{formatDate(process?.nextCheckAt, zh)}</strong></div>
              <div><small>{zh ? '准备包' : 'Prep pack'}</small><strong>{process?.prepPack ?? (zh ? '未指定' : 'Not specified')}</strong></div>
            </div>
            {relevantActions.length ? (
              <div className="opportunity-detail-action-list">
                {relevantActions.map((action) => (
                  <article key={action.id}>
                    <div><strong>{action.title}</strong><small>{action.dueAt ? formatDate(action.dueAt, zh) : (zh ? '无明确时间' : 'No dated node')}</small></div>
                    <span>{actionStatusLabel(action.status, zh)}</span>
                  </article>
                ))}
              </div>
            ) : <p className="opportunity-detail-muted">{zh ? '当前没有未完成的岗位级待办。' : 'No unfinished opportunity-level action.'}</p>}
            <button className="text-button" type="button" onClick={() => onNavigate('prepare')}>{zh ? '查看全部准备' : 'Open preparation'}</button>
          </details>

          {(posting || postingHistory.length) ? (
            <details className="opportunity-detail-section">
              <summary>{zh ? '来源证据' : 'Source evidence'}</summary>
              <div className="opportunity-detail-source-list">
                {posting ? <SourceRow posting={posting} zh={zh} /> : null}
                {postingHistory.map((item) => <SourceRow key={item.id} posting={item} zh={zh} />)}
              </div>
              <p className="opportunity-detail-muted">{zh ? '来源生命周期与招聘流程状态分离；招聘页面关闭不会自动关闭机会。' : 'Source lifecycle is separate from recruiting lifecycle; a closed posting never automatically closes the opportunity.'}</p>
            </details>
          ) : null}

          <OpportunityAssessmentSummary
            assessment={opportunity.detail?.assessment}
            fitScore={opportunity.fitScore}
            opportunityValue={opportunity.opportunityValue}
            fitConfidence={discovery?.fitConfidence}
            opportunityValueConfidence={discovery?.opportunityValueConfidence}
            zh={zh}
          />
        </div>

        {recentTimeline.length ? (
          <details className="opportunity-detail-section">
            <summary>{zh ? '完整历史' : 'Full history'}</summary>
            <div className="opportunity-detail-timeline">
              {recentTimeline.map((record) => (
                <article key={record.id}>
                  <time>{formatDate(record.occurredAt, zh)}</time>
                  <div><strong>{record.title}</strong>{record.detail ? <p>{record.detail}</p> : null}</div>
                </article>
              ))}
            </div>
          </details>
        ) : null}

        <footer className="opportunity-detail-footer">
          <button type="button" onClick={() => onNavigate('today')}>{zh ? '回到 Today' : 'Back to Today'}</button>
          {userFacts?.applicationUrl ? <a href={userFacts.applicationUrl} target="_blank" rel="noreferrer">{zh ? '打开用户确认链接' : 'Open confirmed link'}</a> : opportunity.detail?.facts?.application.applicationUrl ? <a href={opportunity.detail.facts.application.applicationUrl} target="_blank" rel="noreferrer">{zh ? '打开投递页面' : 'Open application page'}</a> : discovery?.sourceUrl ? <a href={discovery.sourceUrl} target="_blank" rel="noreferrer">{zh ? '打开招聘来源' : 'Open source'}</a> : null}
        </footer>
      </aside>
    </div>
  )
}

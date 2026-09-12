import { useEffect } from 'react'
import { jobPostingFreshness } from './jobPosting.js'
import OpportunityAssessmentSummary from './OpportunityAssessmentSummary.js'
import RichOpportunityFactsSummary from './RichOpportunityFactsSummary.js'
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

export type OpportunityDetailDestination = 'today' | 'opportunities' | 'pipeline' | 'prepare'

interface OpportunityDetailDrawerProps {
  opportunity: Opportunity
  process?: ProcessRecord
  actions: Action[]
  applicationGroup?: ApplicationGroup
  timeline: TimelineRecord[]
  onClose: () => void
  onNavigate: (destination: OpportunityDetailDestination) => void
}

const roleLabels: Record<Opportunity['roleType'], [string, string]> = {
  core: ['核心', 'Core'],
  backup: ['保底', 'Backup'],
  reach: ['冲刺', 'Reach'],
  lottery: ['彩票', 'Long shot'],
  practice: ['练手', 'Practice'],
}

function stageLabel(stage: Opportunity['processStage'], zh: boolean) {
  const labels: Record<Opportunity['processStage'], [string, string]> = {
    not_applied: ['待投递', 'Not applied'],
    screening: ['筛选中', 'Screening'],
    assessment: ['测评', 'Assessment'],
    written_test: ['笔试', 'Written test'],
    interview: ['面试', 'Interview'],
    offer: ['Offer', 'Offer'],
    waiting_release: ['等待开放', 'Waiting release'],
    closed: ['已结束', 'Closed'],
  }
  return labels[stage][zh ? 0 : 1]
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
  const posting = discovery?.posting
  const postingHistory = discovery?.postingHistory ?? []
  const relevantActions = actions
    .filter((item) => item.status !== 'done' && item.status !== 'skipped')
    .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'))
  const recentTimeline = [...timeline]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 6)

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
            <div className="eyebrow">OPPORTUNITY · {opportunity.id}</div>
            <strong className="opportunity-detail-company">{opportunity.company}</strong>
            <h2>{opportunity.role}</h2>
            <div className="opportunity-detail-header-badges">
              <span>{roleLabels[opportunity.roleType][zh ? 0 : 1]}</span>
              <span>{stageLabel(opportunity.processStage, zh)}</span>
              {opportunity.early ? <span>{zh ? '提前批 / 早期窗口' : 'Early window'}</span> : null}
            </div>
          </div>
          <button className="opportunity-detail-close" type="button" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}>×</button>
        </header>

        <section className="opportunity-detail-score-grid" aria-label={zh ? '核心判断' : 'Core assessment'}>
          <div><small>FIT</small><b>{Math.round(opportunity.fitScore)}</b></div>
          <div><small>{zh ? '机会价值' : 'VALUE'}</small><b>{Math.round(opportunity.opportunityValue)}</b></div>
          <div><small>{zh ? '当前阶段' : 'STAGE'}</small><strong>{opportunity.currentStageLabel || stageLabel(opportunity.processStage, zh)}</strong></div>
          <div><small>{zh ? '截止' : 'DEADLINE'}</small><strong>{formatDate(opportunity.deadline, zh)}</strong></div>
        </section>

        <section className="opportunity-detail-next-step">
          <div>
            <div className="eyebrow">NEXT DECISION</div>
            <h3>{opportunity.nextActionLabel ?? (zh ? '根据当前状态继续判断下一步' : 'Decide the next move from current state')}</h3>
            <p>{discovery?.rationale ?? opportunity.detail?.jdSummary ?? (zh ? '该岗位目前没有额外决策说明。' : 'No additional decision rationale is stored for this opportunity.')}</p>
          </div>
          <div className="opportunity-detail-nav-actions">
            <button type="button" onClick={() => onNavigate('opportunities')}>{zh ? '回到机会池' : 'Opportunity pool'}</button>
            {process || opportunity.processStage !== 'not_applied' ? <button type="button" onClick={() => onNavigate('pipeline')}>{zh ? '查看流程' : 'View pipeline'}</button> : null}
            <button type="button" onClick={() => onNavigate('prepare')}>{zh ? '查看准备' : 'View prep'}</button>
          </div>
        </section>

        <section className="opportunity-detail-overview">
          <div><small>{zh ? '地点' : 'Location'}</small><strong>{discovery?.location ?? opportunity.detail?.facts?.identity.locations?.join(' · ') ?? (zh ? '未明确' : 'Unknown')}</strong></div>
          <div><small>{zh ? '薪资' : 'Compensation'}</small><strong>{discovery?.compensationText ?? opportunity.salaryReference ?? opportunity.detail?.facts?.compensation.raw ?? (zh ? '未明确' : 'Unknown')}</strong></div>
          <div><small>{zh ? '申请组' : 'Application group'}</small><strong>{applicationGroup?.id ?? opportunity.applicationGroupId ?? '—'}</strong></div>
          <div><small>{zh ? '成功率' : 'Offer probability'}</small><strong>{opportunity.offerProbability ?? (zh ? '未知' : 'Unknown')}</strong></div>
        </section>

        {applicationGroup ? (
          <details className="opportunity-detail-section">
            <summary>{zh ? '申请组约束' : 'Application-group constraints'}</summary>
            <div className="opportunity-detail-prose">
              <p>{applicationGroup.rule ?? (zh ? '该组没有额外规则说明。' : 'No additional rule is stored for this group.')}</p>
              <span>{zh ? '名额' : 'Capacity'}：{applicationGroup.used ?? '?'} / {applicationGroup.total ?? '?'}</span>
              {applicationGroup.remaining !== undefined ? <span>{zh ? '剩余' : 'Remaining'}：{applicationGroup.remaining}</span> : null}
              {applicationGroup.currentOrder ? <span>{zh ? '当前顺序' : 'Current order'}：{applicationGroup.currentOrder}</span> : null}
            </div>
          </details>
        ) : null}

        <RichOpportunityFactsSummary facts={opportunity.detail?.facts} zh={zh} />
        <OpportunityAssessmentSummary
          assessment={opportunity.detail?.assessment}
          fitScore={opportunity.fitScore}
          opportunityValue={opportunity.opportunityValue}
          fitConfidence={discovery?.fitConfidence}
          opportunityValueConfidence={discovery?.opportunityValueConfidence}
          zh={zh}
        />

        <details className="opportunity-detail-section" open={Boolean(process || relevantActions.length)}>
          <summary>{zh ? '流程与待办' : 'Pipeline & actions'}</summary>
          <div className="opportunity-detail-process-grid">
            <div><small>{zh ? '流程阶段' : 'Process stage'}</small><strong>{process?.stageLabel ?? opportunity.currentStageLabel}</strong></div>
            <div><small>{zh ? '最近进展' : 'Last progress'}</small><strong>{formatDate(process?.lastProgressAt, zh)}</strong></div>
            <div><small>{zh ? '下次复核' : 'Next check'}</small><strong>{formatDate(process?.nextCheckAt, zh)}</strong></div>
            <div><small>{zh ? '准备包' : 'Prep pack'}</small><strong>{process?.prepPack ?? (zh ? '未指定' : 'Not specified')}</strong></div>
          </div>
          {relevantActions.length ? (
            <div className="opportunity-detail-action-list">
              {relevantActions.map((action) => (
                <article key={action.id}>
                  <div><strong>{action.title}</strong><small>{action.dueAt ? formatDate(action.dueAt, zh) : (zh ? '无明确时间' : 'No dated node')}</small></div>
                  <span>{action.status}</span>
                </article>
              ))}
            </div>
          ) : <p className="opportunity-detail-muted">{zh ? '当前没有未完成的岗位级 Action。' : 'No unfinished opportunity-level Action.'}</p>}
        </details>

        {(posting || postingHistory.length) ? (
          <details className="opportunity-detail-section">
            <summary>{zh ? '公开来源与新鲜度' : 'Public sources & freshness'}</summary>
            <div className="opportunity-detail-source-list">
              {posting ? <SourceRow posting={posting} zh={zh} /> : null}
              {postingHistory.map((item) => <SourceRow key={item.id} posting={item} zh={zh} />)}
            </div>
            <p className="opportunity-detail-muted">{zh ? '来源状态与求职流程状态分离；招聘页面关闭不会自动关闭 Opportunity。' : 'Source lifecycle is separate from recruiting lifecycle; a closed posting never automatically closes the Opportunity.'}</p>
          </details>
        ) : null}

        {recentTimeline.length ? (
          <details className="opportunity-detail-section">
            <summary>{zh ? '最近历史' : 'Recent history'}</summary>
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
          {opportunity.detail?.facts?.application.applicationUrl ? <a href={opportunity.detail.facts.application.applicationUrl} target="_blank" rel="noreferrer">{zh ? '打开投递页面' : 'Open application page'}</a> : discovery?.sourceUrl ? <a href={discovery.sourceUrl} target="_blank" rel="noreferrer">{zh ? '打开招聘来源' : 'Open source'}</a> : null}
        </footer>
      </aside>
    </div>
  )
}

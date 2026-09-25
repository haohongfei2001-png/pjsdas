import { useEffect, useRef, useState } from 'react'
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
  DecisionRequest,
  JobPostingEvidence,
  Opportunity,
  ProcessRecord,
  TimelineRecord,
} from './model.js'
import './opportunityDetail.css'
import './jobs/jobDetail.css'

export type OpportunityDetailDestination = 'today' | 'opportunities' | 'prepare'

interface OpportunityDetailDrawerProps {
  opportunity: Opportunity
  decision?: OpportunityDecisionRead
  process?: ProcessRecord
  actions: Action[]
  decisionRequests: DecisionRequest[]
  relatedPrep: Array<{ id: string; title: string; reason: string }>
  applicationGroup?: ApplicationGroup
  timeline: TimelineRecord[]
  onClose: () => void
  onCapture: () => void
  onNavigate: (destination: OpportunityDetailDestination) => void
  onOpenDecision: (id: string) => void
  onMarkAction: (id: string, status: Action['status']) => Promise<void>
  readOnly?: boolean
  asPage?: boolean
  returnLabel?: string
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
  decisionRequests,
  relatedPrep,
  applicationGroup,
  timeline,
  onClose,
  onCapture,
  onNavigate,
  onOpenDecision,
  onMarkAction,
  readOnly = false,
  asPage = false,
  returnLabel,
}: OpportunityDetailDrawerProps) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const discovery = opportunity.detail?.discovery
  const userFacts = opportunity.detail?.userFacts
  const posting = discovery?.posting
  const postingHistory = discovery?.postingHistory ?? []
  const [visibleTimelineCount, setVisibleTimelineCount] = useState(6)
  const [pendingActionId, setPendingActionId] = useState<string>()
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => setVisibleTimelineCount(6), [opportunity.id])
  const ended = opportunity.processStage === 'closed' || opportunity.participationStatus === 'abandoned'
  const hasRetainedStaleActions = ended && actions.some((item) => item.status === 'todo' || item.status === 'doing')
  const relevantActions = actions
    .filter((item) => !ended && (item.status === 'todo' || item.status === 'doing'))
    .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'))
  const orderedTimeline = [...timeline]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
  const visibleTimeline = orderedTimeline.slice(0, visibleTimelineCount)
  const completeTimeline = visibleTimeline.length === orderedTimeline.length
  const effectiveStage = process?.stage ?? opportunity.processStage
  const storedStageLabel = process?.stageLabel ?? opportunity.currentStageLabel
  const effectiveStageText = presentStageLabel(effectiveStage, storedStageLabel, lang)
  const applyAction = !ended ? actions.find((item) => item.kind === 'apply' && (item.status === 'todo' || item.status === 'doing')) : undefined
  const applicationCandidate = userFacts?.applicationUrl ?? opportunity.detail?.facts?.application.applicationUrl
  let confirmedApplicationUrl: string | undefined
  try { if (applicationCandidate) { const url = new URL(applicationCandidate); if (url.protocol === 'https:' || url.protocol === 'http:') confirmedApplicationUrl = url.href } } catch { /* Show the missing-link state. */ }

  useEffect(() => { if (!asPage) closeButtonRef.current?.focus() }, [opportunity.id, asPage])

  useEffect(() => {
    if (asPage) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.getClientRects().length > 0)
      if (!focusable.length) { event.preventDefault(); dialogRef.current.focus(); return }
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, asPage])

  const Surface = asPage ? 'article' : 'aside'
  return (
    <div className={asPage ? 'job-detail-page' : 'opportunity-detail-backdrop'} role={asPage ? undefined : 'presentation'} onMouseDown={asPage ? undefined : onClose}>
      {asPage ? <button className="job-detail-back" type="button" onClick={onClose}>← {returnLabel ?? (zh ? '返回岗位库' : 'Back to jobs')}</button> : null}
      <Surface ref={dialogRef} className={asPage ? 'opportunity-detail-drawer job-detail-surface' : 'opportunity-detail-drawer'} role={asPage ? undefined : 'dialog'} aria-modal={asPage ? undefined : true} tabIndex={asPage ? undefined : -1} aria-label={zh ? '岗位详情' : 'Opportunity details'} onMouseDown={(event) => event.stopPropagation()}>
        <header className="opportunity-detail-header">
          <div>
            <div className="eyebrow">OPPORTUNITY</div>
            <strong className="opportunity-detail-company">{opportunity.company}</strong>
            {asPage ? <h1>{opportunity.role}</h1> : <h2>{opportunity.role}</h2>}
            <div className="opportunity-detail-header-badges">
              <span>{effectiveStageText}</span>
              {opportunity.early ? <span>{zh ? '早期窗口' : 'Early window'}</span> : null}
            </div>
          </div>
          {!asPage ? <button ref={closeButtonRef} className="opportunity-detail-close" type="button" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}>×</button> : null}
        </header>

        {asPage ? <div className="job-detail-action-area">
          <div className="job-detail-actions">
            {!ended && confirmedApplicationUrl ? <a href={confirmedApplicationUrl} target="_blank" rel="noopener noreferrer">{zh ? '打开申请入口 ↗' : 'Open application ↗'}</a> : null}
            {!ended && applyAction && !readOnly ? <button type="button" disabled={Boolean(pendingActionId)} onClick={() => {
              setPendingActionId(applyAction.id)
              void onMarkAction(applyAction.id, 'done').finally(() => setPendingActionId(undefined))
            }}>{pendingActionId === applyAction.id ? (zh ? '确认中…' : 'Confirming…') : (zh ? '我已投递' : 'I applied')}</button> : null}
            {!ended && !confirmedApplicationUrl ? <span className="job-detail-no-link">{zh ? '暂无已确认的申请入口' : 'No confirmed application link'}</span> : null}
            <button type="button" className="job-detail-capture" disabled={readOnly} onClick={onCapture}>{zh ? '告诉 PJSDAS' : 'Tell PJSDAS'}</button>
          </div>
          {applicationGroup ? <p className="job-detail-constraint">{applicationGroup.rule ?? (zh ? '此岗位受共享投递名额约束。' : 'This job shares application capacity.')} {applicationGroup.remaining !== undefined ? (zh ? `剩余名额：${applicationGroup.remaining}` : `Remaining: ${applicationGroup.remaining}`) : ''}</p> : null}
        </div> : null}

        {decision ? <OpportunityDecisionSummary decision={decision} process={process} onNavigate={onNavigate} onCapture={onCapture} readOnly={readOnly} /> : null}

        {decisionRequests.length ? (
          <details className="opportunity-detail-section opportunity-detail-decisions" open>
            <summary>{zh ? `需要你决定 · ${decisionRequests.length}` : `Needs your decision · ${decisionRequests.length}`}</summary>
            {decisionRequests.map((request) => <div className="opportunity-detail-decision-link" key={request.id}>
              <strong>{request.question}</strong>
              <button type="button" onClick={() => onOpenDecision(request.id)}>{zh ? '处理这项决定' : 'Review this decision'}</button>
            </div>)}
          </details>
        ) : null}

        <div className="opportunity-detail-progressive">
          <RichOpportunityFactsSummary facts={opportunity.detail?.facts} zh={zh} />

          {applicationGroup ? (
            <details className="opportunity-detail-section" open={asPage}>
              <summary>{zh ? '申请约束' : 'Application constraints'}</summary>
              <div className="opportunity-detail-prose">
                <p>{applicationGroup.rule ?? (zh ? '该组没有额外规则说明。' : 'No additional rule is stored for this group.')}</p>
                {applicationGroup.remaining !== undefined ? <span>{zh ? '剩余名额' : 'Remaining capacity'}：{applicationGroup.remaining}</span> : null}
                {applicationGroup.currentOrder ? <span>{zh ? '当前顺序' : 'Current order'}：{applicationGroup.currentOrder}</span> : null}
              </div>
            </details>
          ) : null}

          <details className="opportunity-detail-section" open={asPage && (relevantActions.length > 0 || relatedPrep.length > 0)}>
            <summary>{zh ? '准备与相关待办' : 'Preparation & related actions'}</summary>
            <div className="opportunity-detail-process-grid">
              <div><small>{zh ? '最近进展' : 'Last progress'}</small><strong>{formatDate(process?.lastProgressAt, zh)}</strong></div>
              <div><small>{zh ? '下次复核' : 'Next check'}</small><strong>{formatDate(process?.nextCheckAt, zh)}</strong></div>
              <div><small>{zh ? '准备包' : 'Prep pack'}</small><strong>{process?.prepPack ?? (zh ? '未指定' : 'Not specified')}</strong></div>
            </div>
            {relatedPrep.length ? (
              <div className="opportunity-detail-action-list opportunity-detail-related-prep">
                <strong>{zh ? `已核实的关联准备 · ${relatedPrep.length}` : `Verified related preparation · ${relatedPrep.length}`}</strong>
                {relatedPrep.map((item) => <article key={item.id}><div><strong>{item.title}</strong><small>{item.reason}</small></div></article>)}
              </div>
            ) : <p className="opportunity-detail-muted">{zh ? '当前没有可核实的准备关联；不会凭名称相似强行关联。' : 'No verified preparation link yet; name similarity alone does not create one.'}</p>}
            {relevantActions.length ? (
              <div className="opportunity-detail-action-list">
                {relevantActions.map((action) => (
                  <article key={action.id}>
                    <div><strong>{action.title}</strong><small>{action.dueAt ? formatDate(action.dueAt, zh) : (zh ? '无明确时间' : 'No dated node')}</small></div>
                    <span>{actionStatusLabel(action.status, zh)}</span>
                    {!readOnly ? <button type="button" disabled={Boolean(pendingActionId)} onClick={() => {
                      setPendingActionId(action.id)
                      void onMarkAction(action.id, 'done').finally(() => setPendingActionId(undefined))
                    }}>{pendingActionId === action.id ? (zh ? '正在完成…' : 'Completing…') : (zh ? '标记完成' : 'Mark done')}</button> : null}
                  </article>
                ))}
              </div>
            ) : <p className="opportunity-detail-muted">{hasRetainedStaleActions
              ? (zh ? '流程已结束，旧待办不会继续推荐；原记录仍保留。' : 'This process has ended. Old actions are no longer recommended; their records remain available.')
              : (zh ? '当前没有未完成的岗位级待办。' : 'No unfinished opportunity-level action.')}</p>}
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

        {orderedTimeline.length ? (
          <details className="opportunity-detail-section">
            <summary>{completeTimeline
              ? (zh ? '完整历史' : 'Full history')
              : (zh ? `最近历史 · ${visibleTimeline.length}/${orderedTimeline.length} 条` : `Recent history · ${visibleTimeline.length} of ${orderedTimeline.length}`)}</summary>
            <div className="opportunity-detail-timeline">
              {visibleTimeline.map((record) => (
                <article key={record.id}>
                  <time>{formatDate(record.occurredAt, zh)}</time>
                  <div><strong>{record.title}</strong>{record.detail ? <p>{record.detail}</p> : null}</div>
                </article>
              ))}
              {!completeTimeline ? <button className="opportunity-detail-more-history" type="button"
                onClick={() => setVisibleTimelineCount((count) => Math.min(count + 20, orderedTimeline.length))}>
                {zh ? `显示更早记录（剩余 ${orderedTimeline.length - visibleTimeline.length} 条）` : `Show earlier records (${orderedTimeline.length - visibleTimeline.length} remaining)`}
              </button> : null}
            </div>
          </details>
        ) : null}

        <footer className="opportunity-detail-footer">
          <button type="button" onClick={() => onNavigate('today')}>{zh ? '回到 Today' : 'Back to Today'}</button>
          <button className="cgr-context-capture" type="button" disabled={readOnly} onClick={onCapture}>{zh ? '告诉 PJSDAS' : 'Tell PJSDAS'}</button>
          {userFacts?.applicationUrl ? <a href={userFacts.applicationUrl} target="_blank" rel="noreferrer">{zh ? '打开用户确认链接' : 'Open confirmed link'}</a> : opportunity.detail?.facts?.application.applicationUrl ? <a href={opportunity.detail.facts.application.applicationUrl} target="_blank" rel="noreferrer">{zh ? '打开投递页面' : 'Open application page'}</a> : discovery?.sourceUrl ? <a href={discovery.sourceUrl} target="_blank" rel="noreferrer">{zh ? '打开招聘来源' : 'Open source'}</a> : null}
        </footer>
      </Surface>
    </div>
  )
}

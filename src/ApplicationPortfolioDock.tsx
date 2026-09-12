import { useEffect, useState } from 'react'
import { buildAllApplicationPortfolioDecisions, type ApplicationPortfolioDecision, type PortfolioCandidateDecision } from './applicationPortfolio.js'
import { getAllApplicationGroups, getAllOpportunities, getDecisionRules } from './db.js'
import { useUiLanguage } from './uiLanguage.js'
import './applicationPortfolio.css'

function statusLabel(status: ApplicationPortfolioDecision['status'], zh: boolean) {
  const labels: Record<ApplicationPortfolioDecision['status'], [string, string]> = {
    ready: ['可决策', 'Ready'],
    needs_rule_confirmation: ['先核实名额', 'Confirm quota'],
    capacity_exhausted: ['名额已用完', 'No capacity'],
    locked: ['已锁定', 'Locked'],
    no_candidates: ['无候选', 'No candidates'],
    no_recommendation: ['无需凑名额', 'No recommendation'],
  }
  return labels[status][zh ? 0 : 1]
}

function dispositionLabel(candidate: PortfolioCandidateDecision, zh: boolean) {
  const labels: Record<PortfolioCandidateDecision['disposition'], [string, string]> = {
    recommended: ['推荐', 'Recommended'],
    below_minimum: ['低于最低价值线', 'Below minimum'],
    overlap: ['与已选岗位过度重叠', 'Too much overlap'],
    capacity: ['名额优先给更高价值岗位', 'Capacity used by stronger roles'],
    expired: ['已过截止', 'Expired'],
    not_pending: ['已不在待投阶段', 'Not pending'],
    not_selected: ['边际组合价值不足', 'Insufficient marginal value'],
  }
  return labels[candidate.disposition][zh ? 0 : 1]
}

function roleTypeLabel(value: PortfolioCandidateDecision['roleType'], zh: boolean) {
  const labels = {
    core: zh ? '核心' : 'Core',
    backup: zh ? '保底' : 'Backup',
    reach: zh ? '冲刺' : 'Reach',
    lottery: zh ? '彩票' : 'Lottery',
    practice: zh ? '练手' : 'Practice',
  }
  return labels[value]
}

function CandidateCard({ candidate, zh }: { candidate: PortfolioCandidateDecision; zh: boolean }) {
  const components = candidate.components
  return (
    <article className={`portfolio-candidate ${candidate.disposition === 'recommended' ? 'recommended' : ''}`}>
      <div className="portfolio-candidate-head">
        <div>
          <strong>{candidate.role}</strong>
          <span>{roleTypeLabel(candidate.roleType, zh)}</span>
        </div>
        <div className="portfolio-score"><b>{candidate.baseScore}</b><small>{zh ? '基础效用' : 'base utility'}</small></div>
      </div>
      <div className="portfolio-component-row">
        <span>{zh ? '机会' : 'Value'} <b>{components.opportunityValue}</b></span>
        <span>{zh ? '匹配' : 'Fit'} <b>{components.fit}</b></span>
        <span>{zh ? '角色' : 'Role'} <b>{components.rolePriority}</b></span>
        {components.deadline !== undefined ? <span>{zh ? '截止' : 'Deadline'} <b>{components.deadline}</b></span> : null}
        {components.applicationEfficiency !== undefined ? <span>{zh ? '效率' : 'Efficiency'} <b>{components.applicationEfficiency}</b></span> : null}
        {components.evidenceConfidence !== undefined ? <span>{zh ? '证据' : 'Evidence'} <b>{components.evidenceConfidence}</b></span> : null}
      </div>
      <div className="portfolio-candidate-reason">
        <strong>{dispositionLabel(candidate, zh)}</strong>
        {candidate.reasons.length ? <span>{candidate.reasons.join(' · ')}</span> : null}
      </div>
    </article>
  )
}

export default function ApplicationPortfolioDock() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [decisions, setDecisions] = useState<ApplicationPortfolioDecision[]>([])
  const [error, setError] = useState('')

  async function reload() {
    setLoading(true)
    setError('')
    try {
      const [groups, opportunities, rules] = await Promise.all([
        getAllApplicationGroups(),
        getAllOpportunities(),
        getDecisionRules(),
      ])
      setDecisions(buildAllApplicationPortfolioDecisions(groups, opportunities, rules, new Date()))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void reload()
  }, [open])

  useEffect(() => {
    const handler = () => { if (open) void reload() }
    window.addEventListener('pjsdas:workspace-replaced', handler)
    return () => window.removeEventListener('pjsdas:workspace-replaced', handler)
  }, [open])

  return (
    <>
      <button className="portfolio-dock-trigger" type="button" onClick={() => setOpen(true)}>
        {zh ? '申请组合' : 'Portfolio'}
      </button>
      {open ? (
        <div className="portfolio-backdrop" onMouseDown={() => setOpen(false)}>
          <section className="portfolio-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header className="portfolio-header">
              <div>
                <div className="eyebrow">APPLICATION PORTFOLIO · V1.6</div>
                <h2>{zh ? '申请组合决策' : 'Application portfolio decisions'}</h2>
                <p>{zh
                  ? '把“最多可投几个”视为上限，而不是必须填满的目标。PJSDAS 比较组内岗位的价值、匹配、角色、截止、投递成本与证据置信度，并惩罚高度重复的组合。'
                  : 'Capacity is a ceiling, not a fill target. PJSDAS compares value, fit, role priority, deadlines, application cost, evidence confidence, and redundancy inside each explicit Application Group.'}</p>
              </div>
              <button className="portfolio-close" type="button" onClick={() => setOpen(false)} aria-label={zh ? '关闭' : 'Close'}>×</button>
            </header>

            <div className="portfolio-safety">
              <strong>{zh ? '只读建议' : 'Read-only advice'}</strong>
              <span>{zh ? '这里不会自动修改志愿、占用名额或提交申请。' : 'This view never changes preferences, consumes quota, or submits an application.'}</span>
              <button type="button" disabled={loading} onClick={() => { void reload() }}>{loading ? '…' : (zh ? '重新计算' : 'Recalculate')}</button>
            </div>

            {error ? <div className="portfolio-notice error">{error}</div> : null}
            {!loading && decisions.length === 0 ? (
              <div className="portfolio-empty">
                <strong>{zh ? '当前没有结构化申请组' : 'No structured Application Groups'}</strong>
                <p>{zh ? '只有明确绑定 applicationGroupId 的岗位才参与组合决策；PJSDAS 不会仅凭“同一家公司”自动猜测名额规则。' : 'Only roles explicitly bound to an applicationGroupId participate. PJSDAS does not infer quota rules from company identity alone.'}</p>
              </div>
            ) : null}

            <div className="portfolio-groups">
              {decisions.map((decision) => (
                <article className={`portfolio-group status-${decision.status}`} key={decision.groupId}>
                  <div className="portfolio-group-head">
                    <div>
                      <span className="portfolio-status">{statusLabel(decision.status, zh)}</span>
                      <h3>{decision.company}</h3>
                      <small>{decision.groupId}</small>
                    </div>
                    <div className="portfolio-capacity">
                      <span>{zh ? '剩余上限' : 'Capacity'}</span>
                      <strong>{decision.capacity ?? '?'}</strong>
                      {decision.totalSlots !== undefined ? <small>{zh ? `总 ${decision.totalSlots} · 已用 ${decision.usedSlots ?? '?'}` : `total ${decision.totalSlots} · used ${decision.usedSlots ?? '?'}`}</small> : null}
                    </div>
                  </div>

                  {decision.sourceRule || decision.currentOrder ? (
                    <div className="portfolio-source-rule">
                      {decision.sourceRule ? <span><b>{zh ? '名额规则' : 'Quota rule'}：</b>{decision.sourceRule}</span> : null}
                      {decision.currentOrder ? <span><b>{zh ? '历史首选' : 'Recorded preference'}：</b>{decision.currentOrder}</span> : null}
                    </div>
                  ) : null}

                  {decision.recommended.length ? (
                    <section className="portfolio-section">
                      <div className="portfolio-section-title">
                        <strong>{zh ? `推荐组合 · ${decision.recommended.length} 个` : `Recommended portfolio · ${decision.recommended.length}`}</strong>
                        <span>{zh ? `最低候选线 ${decision.minimumCandidateScore}` : `minimum ${decision.minimumCandidateScore}`}</span>
                      </div>
                      <div className="portfolio-candidate-list">
                        {decision.recommended.map((candidate) => <CandidateCard key={candidate.opportunityId} candidate={candidate} zh={zh} />)}
                      </div>
                    </section>
                  ) : (
                    <div className="portfolio-no-pick">
                      {decision.status === 'needs_rule_confirmation'
                        ? (zh ? '先确认剩余名额，系统不会猜测一个组合。' : 'Confirm remaining quota before PJSDAS chooses a portfolio.')
                        : decision.status === 'locked'
                          ? (zh ? '申请组已锁定，不建议替换现有志愿。' : 'The group is locked; no replacement portfolio is proposed.')
                          : decision.status === 'capacity_exhausted'
                            ? (zh ? '当前没有剩余名额。' : 'No remaining application capacity.')
                            : (zh ? '当前没有岗位达到足够的净组合价值；无需为了凑名额而投。' : 'No role has enough net portfolio value; do not apply merely to fill capacity.')}
                    </div>
                  )}

                  {decision.notRecommended.length ? (
                    <details className="portfolio-not-recommended">
                      <summary>{zh ? `查看未推荐的 ${decision.notRecommended.length} 个岗位` : `See ${decision.notRecommended.length} not recommended`}</summary>
                      <div className="portfolio-candidate-list compact">
                        {decision.notRecommended.map((candidate) => <CandidateCard key={candidate.opportunityId} candidate={candidate} zh={zh} />)}
                      </div>
                    </details>
                  ) : null}

                  {decision.warnings.length ? (
                    <div className="portfolio-warnings">{decision.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

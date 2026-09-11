import { opportunityFactsCompleteness } from './richOpportunity.js'
import type { OpportunityFacts } from './model.js'

function join(values: string[] | undefined) {
  return values?.length ? values.join(' · ') : undefined
}

function FactRow({ label, value, zh }: { label: string; value?: string; zh: boolean }) {
  return (
    <div className="rich-opportunity-fact-row">
      <dt>{label}</dt>
      <dd className={value ? '' : 'unknown'}>{value ?? (zh ? '来源未明确' : 'Not stated by source')}</dd>
    </div>
  )
}

export default function RichOpportunityFactsSummary({ facts, zh }: { facts?: OpportunityFacts; zh: boolean }) {
  if (!facts) return null
  const completeness = opportunityFactsCompleteness(facts)
  const responsibilities = join(facts.role.responsibilities)
  const requirements = join(facts.role.requirements)
  const majors = join(facts.role.majorRequirements)
  const skills = join(facts.role.skills)
  const languages = join(facts.role.languageRequirements)
  const locations = join(facts.identity.locations)
  const compensation = facts.compensation.raw ?? (
    facts.compensation.annualMinWan !== undefined || facts.compensation.annualMaxWan !== undefined
      ? `${facts.compensation.annualMinWan ?? '?'}–${facts.compensation.annualMaxWan ?? '?'} ${zh ? '万元/年' : '10k CNY/year'}`
      : undefined
  )

  return (
    <details className="rich-opportunity-facts">
      <summary>
        <span>{zh ? '招聘事实' : 'Source-backed job facts'}</span>
        <strong>{completeness.known}/{completeness.total}</strong>
        <small>{completeness.percent}%</small>
      </summary>
      <p className="rich-opportunity-facts-note">
        {zh
          ? '以下仅保存公开来源明确支持的事实；匹配度、机会价值和推荐理由仍是单独的评估层。'
          : 'Only facts explicitly supported by the public source are stored here. Fit, opportunity value, and rationale remain a separate assessment layer.'}
      </p>
      <dl className="rich-opportunity-facts-grid">
        <FactRow zh={zh} label={zh ? '部门' : 'Department'} value={facts.identity.department} />
        <FactRow zh={zh} label={zh ? '业务单元' : 'Business unit'} value={facts.identity.businessUnit} />
        <FactRow zh={zh} label={zh ? '地点' : 'Locations'} value={locations} />
        <FactRow zh={zh} label={zh ? '招聘批次' : 'Recruitment batch'} value={facts.identity.recruitmentBatch ?? facts.application.recruitmentBatch} />
        <FactRow zh={zh} label={zh ? '学历' : 'Education'} value={facts.role.educationRequirement} />
        <FactRow zh={zh} label={zh ? '专业' : 'Majors'} value={majors} />
        <FactRow zh={zh} label={zh ? '经验' : 'Experience'} value={facts.role.experienceRequirement} />
        <FactRow zh={zh} label={zh ? '技能' : 'Skills'} value={skills} />
        <FactRow zh={zh} label={zh ? '语言' : 'Languages'} value={languages} />
        <FactRow zh={zh} label={zh ? '投递方式' : 'Application method'} value={facts.application.applicationMethod} />
        <FactRow zh={zh} label={zh ? '薪资' : 'Compensation'} value={compensation} />
      </dl>
      {responsibilities ? (
        <div className="rich-opportunity-facts-block">
          <strong>{zh ? '职责' : 'Responsibilities'}</strong>
          <p>{responsibilities}</p>
        </div>
      ) : null}
      {requirements ? (
        <div className="rich-opportunity-facts-block">
          <strong>{zh ? '要求' : 'Requirements'}</strong>
          <p>{requirements}</p>
        </div>
      ) : null}
      {facts.evidence.evidenceSummary ? (
        <div className="rich-opportunity-facts-block evidence">
          <strong>{zh ? '来源摘要' : 'Evidence summary'}</strong>
          <p>{facts.evidence.evidenceSummary}</p>
        </div>
      ) : null}
      <div className="rich-opportunity-facts-source">
        <span>{zh ? '核验时间' : 'Verified'}：{new Date(facts.evidence.verifiedAt).toLocaleString()}</span>
        {facts.application.applicationUrl ? <a href={facts.application.applicationUrl} target="_blank" rel="noreferrer">{zh ? '投递页面' : 'Application page'}</a> : null}
      </div>
    </details>
  )
}
